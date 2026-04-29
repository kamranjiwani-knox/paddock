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
 */
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

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: 8096,
        // JSON mode — Gemini guarantees the response is parseable JSON
        // when this is set.
        responseMimeType: "application/json",
      },
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
