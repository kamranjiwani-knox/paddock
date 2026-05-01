import type { JudgeProvider, JudgePrompt, TokenUsage } from "../../types"

/**
 * OpenAI judge provider.
 *
 * Prompt caching: when complete() receives a JudgePrompt, the static system
 * prefix is sent as a system-role message and the variable content as a
 * user-role message. OpenAI's implicit prefix cache matches on the static
 * leading bytes; a stable prompt_cache_key keeps repeated calls on the
 * same shard, maximizing hit rate. prompt_cache_retention="24h" extends
 * the cache lifetime beyond the default ~5-10 min idle, enabling cache
 * hits across paddock CI runs (gpt-4.1 / gpt-5 family supports this).
 *
 * Reasoning: gpt-5 family and o-series support `reasoning_effort`. gpt-4.1
 * does NOT — it's marketed as "the smartest non-reasoning model" and the
 * parameter is rejected. We keep gpt-4.1 backward-compatible (no reasoning
 * params, max_tokens=8096), and only add reasoning_effort + the larger
 * max_completion_tokens budget when the model supports it. Token-budget
 * env var maps to a reasoning_effort level since OpenAI's API doesn't
 * accept a raw token budget — only effort tiers.
 *
 * Retry: 408 / 429 / 5xx / fetch-level network errors retry up to
 * MAX_ATTEMPTS. Honors Retry-After when present (capped at 60s);
 * otherwise exponential backoff + jitter. Without this, paddock's
 * Promise.allSettled swallows transient OpenAI failures and the parser
 * writes a fail/score=0 verdict — silently dragging the gpt-4.1 mean
 * down on cold-start bursts.
 */
const MAX_ATTEMPTS = 3
const RETRY_AFTER_CAP_MS = 60_000
const RETRYABLE_HTTP_STATUS = new Set([408, 429])

function parseBudget(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[openai-judge] invalid env value "${raw}", using ${fallback}`)
    return fallback
  }
  return Math.floor(n)
}
const JUDGE_THINKING_BUDGET = parseBudget(process.env.EVAL_JUDGE_THINKING_BUDGET, 8000)
const JUDGE_MAX_TOKENS = parseBudget(process.env.EVAL_JUDGE_MAX_TOKENS, 16000)

/** Map a token-budget number to OpenAI's reasoning_effort tier. Mirrors the
 * mental model of the Claude/Gemini judges, where the same env var value
 * controls comparable reasoning depth across all three providers.
 *
 * OpenAI's API takes a tier name (string enum), not a token count:
 *   none < minimal < low < medium < high < xhigh
 *
 * Mapping (gpt-5 family supports the full set; older o-series tops out at
 * low/medium/high):
 *   budget === 0     → "none" (gpt-5) | "low" (o-series fallback)
 *   1 ≤ budget ≤ 500 → "minimal" (gpt-5) | "low" (o-series fallback)
 *   501 ≤ ≤ 2000     → "low"
 *   2001 ≤ ≤ 12000   → "medium"
 *   > 12000          → "high"
 *
 * To FULLY disable reasoning regardless of model, switch to a non-reasoning
 * model (gpt-4.1 / gpt-4o) via vars.OPENAI_MODEL. */
function budgetToReasoningEffort(
  budget: number,
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" {
  const isGpt5 = /^gpt-5/.test(model)
  if (budget === 0) return isGpt5 ? "none" : "low"
  if (budget <= 500 && isGpt5) return "minimal"
  if (budget <= 2000) return "low"
  if (budget <= 12000) return "medium"
  return "high"
}

/** Retryable iff:
 *  - fetch-level network failure (Node/Bun raise TypeError per WHATWG fetch spec), OR
 *  - HTTP 408 / 429 / any 5xx
 * Notably NOT retried: 4xx auth/validation, JSON-parse failures on 200 OK
 * (likely server bug, not transient), or any non-Error throw (programming bug). */
function isRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const status = (err as { status?: number })?.status
  if (typeof status !== "number") return false
  if (RETRYABLE_HTTP_STATUS.has(status)) return true
  return status >= 500 && status < 600
}

/** Parse OpenAI's Retry-After header. Spec allows seconds OR HTTP-date;
 * OpenAI uses seconds in practice but we handle both. Returns ms, capped
 * at RETRY_AFTER_CAP_MS so a malformed/hostile header can't pin us. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS)
  }
  const dateMs = Date.parse(header)
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), RETRY_AFTER_CAP_MS)
  }
  return undefined
}

export class OpenAIJudgeProvider implements JudgeProvider {
  name = "openai"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private apiKey: string

  constructor(apiKey: string, model = "gpt-4o") {
    this.model = model
    this.apiKey = apiKey
  }

  /** Models known to support prompt_cache_retention="24h" per OpenAI's docs.
   * Other models gracefully ignore unknown params, but we keep the list
   * explicit to avoid surprises. */
  private supports24hRetention(): boolean {
    return /^gpt-(4\.1|5)/.test(this.model)
  }

  /** Reasoning models accept `reasoning_effort` and require `max_completion_tokens`
   * (instead of legacy `max_tokens`). gpt-4.1 / gpt-4o etc. are non-reasoning —
   * passing reasoning_effort to them is rejected by the API. */
  private supportsReasoningEffort(): boolean {
    return /^(gpt-5|o[0-9]+)/.test(this.model)
  }

  async complete(prompt: string | JudgePrompt): Promise<string> {
    const { system, user } = typeof prompt === "string"
      ? { system: "", user: prompt }
      : prompt

    const messages = system
      ? [
          { role: "system" as const, content: system },
          { role: "user" as const, content: user },
        ]
      : [{ role: "user" as const, content: user }]

    const reasoning = this.supportsReasoningEffort()
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      // JSON mode — guarantees the response is valid JSON, eliminating
      // format-drift parse failures.
      response_format: { type: "json_object" },
      // Routes calls with the same key to the same shard, maximizing
      // implicit cache hit rate across paddock evaluations.
      prompt_cache_key: "paddock-judge",
    }
    if (reasoning) {
      // Reasoning models reject max_tokens; require max_completion_tokens.
      // The larger budget makes room for the model's hidden reasoning
      // tokens plus the visible JSON output.
      body.max_completion_tokens = JUDGE_MAX_TOKENS
      // Always set reasoning_effort — when budget=0, this resolves to "none"
      // (gpt-5) or "low" (o-series fallback) to honor the user's intent to
      // disable. Without setting it, the model would silently default to
      // "medium" — making EVAL_JUDGE_THINKING_BUDGET=0 a no-op on OpenAI.
      body.reasoning_effort = budgetToReasoningEffort(JUDGE_THINKING_BUDGET, this.model)
    } else {
      body.max_tokens = 8096
    }
    if (this.supports24hRetention()) {
      body.prompt_cache_retention = "24h"
    }

    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const errText = await res.text()
          const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"))
          const err = Object.assign(
            new Error(`OpenAI API error: ${res.status} ${errText}`),
            { status: res.status, retryAfterMs },
          )
          throw err
        }

        const data = await res.json() as {
          choices?: Array<{ message?: { content?: string } }>
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            total_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
          }
        }
        if (data.usage) {
          const u = data.usage
          // Split prompt_tokens into cached vs uncached. OpenAI's implicit
          // prefix cache surfaces the cached portion in prompt_tokens_details
          // and STILL counts those tokens in prompt_tokens (i.e. cached is a
          // SUBSET, not separate). Subtract so each bucket is disjoint.
          const cachedIn = u.prompt_tokens_details?.cached_tokens ?? 0
          const uncachedIn = (u.prompt_tokens ?? 0) - cachedIn
          this.usage.inputTokens += Math.max(0, uncachedIn)
          this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + cachedIn

          // Split completion_tokens into visible vs reasoning. OpenAI counts
          // reasoning_tokens INSIDE completion_tokens; same subtract pattern.
          const reasoningOut = u.completion_tokens_details?.reasoning_tokens ?? 0
          const visibleOut = (u.completion_tokens ?? 0) - reasoningOut
          this.usage.outputTokens += Math.max(0, visibleOut)
          this.usage.thinkingTokens = (this.usage.thinkingTokens ?? 0) + reasoningOut

          // Derive total locally — total_tokens from the API is the sum of
          // all four buckets, which we now track explicitly.
          this.usage.totalTokens =
            this.usage.inputTokens +
            (this.usage.cacheReadTokens ?? 0) +
            this.usage.outputTokens +
            (this.usage.thinkingTokens ?? 0)
        }
        return data.choices?.[0]?.message?.content ?? ""
      } catch (err) {
        lastError = err
        if (isRetryable(err) && attempt < MAX_ATTEMPTS - 1) {
          const status = (err as { status?: number }).status
          const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs
          const exponentialMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500)
          const delay = retryAfterMs ?? exponentialMs
          console.warn(
            `[openai] attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${status ?? "network"}), retrying in ${delay}ms${retryAfterMs ? " (Retry-After)" : ""}`,
          )
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        console.warn(`[openai] non-retriable failure after ${attempt + 1} attempt(s): ${(err as Error).message}`)
        throw err
      }
    }

    throw lastError
  }
}
