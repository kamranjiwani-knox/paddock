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
 */
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

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
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
