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

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: 8096,
      // JSON mode — guarantees the response is valid JSON, eliminating
      // format-drift parse failures.
      response_format: { type: "json_object" },
      // Routes calls with the same key to the same shard, maximizing
      // implicit cache hit rate across paddock evaluations.
      prompt_cache_key: "paddock-judge",
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
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        }
        if (data.usage) {
          this.usage.inputTokens += data.usage.prompt_tokens ?? 0
          this.usage.outputTokens += data.usage.completion_tokens ?? 0
          this.usage.totalTokens += data.usage.total_tokens ?? 0
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
