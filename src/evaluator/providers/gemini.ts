import type { JudgeProvider } from "../../types"

export class GeminiJudgeProvider implements JudgeProvider {
  name = "gemini"
  model: string
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
        generationConfig: { maxOutputTokens: 4096 },
      }),
    })

    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status} ${await res.text()}`)
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  }
}
