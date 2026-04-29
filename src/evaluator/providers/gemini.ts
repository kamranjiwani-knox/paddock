import type { JudgeProvider, TokenUsage } from "../../types"

export class GeminiJudgeProvider implements JudgeProvider {
  name = "gemini"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private apiKey: string

  constructor(apiKey: string, model = "gemini-2.5-pro") {
    this.model = model
    this.apiKey = apiKey
  }

  async complete(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 8096,
          // JSON mode — Gemini guarantees the response is parseable JSON
          // when this is set. The judge prompt asks for a JSON object so
          // this just enforces what we already requested.
          responseMimeType: "application/json",
        },
      }),
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
