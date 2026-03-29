import type { JudgeProvider } from "../../types"

export class OpenAIJudgeProvider implements JudgeProvider {
  name = "openai"
  model: string
  private apiKey: string

  constructor(apiKey: string, model = "gpt-4o") {
    this.model = model
    this.apiKey = apiKey
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
      }),
    })

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`)
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return data.choices?.[0]?.message?.content ?? ""
  }
}
