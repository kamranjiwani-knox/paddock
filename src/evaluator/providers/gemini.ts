import type { JudgeProvider, JudgePrompt, TokenUsage } from "../../types"

/**
 * Gemini judge provider.
 *
 * Prompt structure: when complete() receives a JudgePrompt, the static
 * system prefix is sent as `systemInstruction` (Gemini's structured
 * separation) and the variable content as `contents`. This positions
 * us to take advantage of Gemini's implicit caching when it stabilizes
 * (currently flaky on gemini-3-pro-preview per a known Google issue).
 *
 * Explicit caching via `cachedContents` is a separate, larger change
 * and is deferred — implicit + structured separation is already a win
 * for any scenario where implicit caching works.
 *
 * Thinking budget: Gemini 2.5+ models (including gemini-3-pro-preview) think
 * by default with a model-determined budget. This makes per-call results
 * non-deterministic and skews judge agreement vs the non-thinking judges.
 * We pin the budget to EVAL_JUDGE_THINKING_BUDGET (default 8000) so all
 * three judges reason at comparable depth. Set to 0 to disable thinking on
 * supported models. Older models (gemini-2.0-*, gemini-1.5-*) ignore this.
 */
function parseBudget(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[gemini-judge] invalid env value "${raw}", using ${fallback}`)
    return fallback
  }
  return Math.floor(n)
}
const JUDGE_THINKING_BUDGET = parseBudget(process.env.EVAL_JUDGE_THINKING_BUDGET, 8000)
const JUDGE_MAX_OUTPUT_TOKENS = parseBudget(process.env.EVAL_JUDGE_MAX_TOKENS, 16000)

const SUPPORTS_THINKING_BUDGET = (model: string): boolean =>
  /^gemini-(2\.5|3)/.test(model)

export class GeminiJudgeProvider implements JudgeProvider {
  name = "gemini"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private apiKey: string

  constructor(apiKey: string, model = "gemini-2.5-pro") {
    this.model = model
    this.apiKey = apiKey
  }

  async complete(prompt: string | JudgePrompt): Promise<string> {
    const { system, user } = typeof prompt === "string"
      ? { system: "", user: prompt }
      : prompt

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`

    const supportsThinking = SUPPORTS_THINKING_BUDGET(this.model)
    const generationConfig: Record<string, unknown> = {
      // Older models (gemini-1.5/2.0) get the original 8K cap; thinking-capable
      // models get the wider cap to leave room when JUDGE_MAX_TOKENS is bumped
      // alongside thinking budget. (Gemini's thinkingBudget is separate from
      // maxOutputTokens, so this is generous, not load-bearing.)
      maxOutputTokens: supportsThinking ? JUDGE_MAX_OUTPUT_TOKENS : 8096,
      // JSON mode — Gemini guarantees the response is parseable JSON
      // when this is set.
      responseMimeType: "application/json",
    }
    if (supportsThinking) {
      // 0 disables thinking; positive values pin the budget. Without this
      // the model uses an undocumented dynamic budget per call, which
      // varies the strictness of judging across runs.
      generationConfig.thinkingConfig = { thinkingBudget: JUDGE_THINKING_BUDGET }
    }

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: user }] }],
      generationConfig,
    }
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status} ${await res.text()}`)
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    }
    if (data.usageMetadata) {
      this.usage.inputTokens += data.usageMetadata.promptTokenCount ?? 0
      this.usage.outputTokens += data.usageMetadata.candidatesTokenCount ?? 0
      this.usage.totalTokens += data.usageMetadata.totalTokenCount ?? 0
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  }
}
