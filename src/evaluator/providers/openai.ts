import type { JudgeProvider, TokenUsage } from "../../types"

export class OpenAIJudgeProvider implements JudgeProvider {
  name = "openai"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
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
        max_tokens: 8096,
        // JSON mode — guarantees the response is valid JSON, eliminating
        // format-drift parse failures. The judge prompt explicitly asks for
        // a JSON object so this just enforces what we already requested.
        response_format: { type: "json_object" },
      }),
    })

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`)
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
  }
}
