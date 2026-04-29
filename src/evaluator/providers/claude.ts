import Anthropic from "@anthropic-ai/sdk"
import type { JudgeProvider, JudgePrompt, TokenUsage } from "../../types"

/**
 * Claude judge provider.
 * Supports both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN (comma-separated for rotation).
 * OAuth tokens (sk-ant-oat01-*) use authToken + beta headers.
 * API keys (sk-ant-api03-*) use apiKey.
 *
 * Prompt caching: when complete() receives a JudgePrompt, the static system
 * prefix is sent as a cached block (cache_control: ephemeral). Anthropic
 * caches everything up to and including that breakpoint. Subsequent calls
 * within the 5-min TTL pay 10% of input cost on the cached prefix.
 */
export class ClaudeJudgeProvider implements JudgeProvider {
  name = "claude"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private tokens: string[]
  private tokenIndex = 0

  constructor(apiKeyOrTokens: string, model = "claude-sonnet-4-6") {
    this.model = model
    this.tokens = apiKeyOrTokens.split(",").map(t => t.trim()).filter(Boolean)
    if (this.tokens.length === 0) {
      throw new Error("ClaudeJudgeProvider: no API key or OAuth tokens provided")
    }
  }

  private isOAuthToken(token: string): boolean {
    return token.startsWith("sk-ant-oat")
  }

  private createClient(token: string): Anthropic {
    if (this.isOAuthToken(token)) {
      return new Anthropic({
        authToken: token,
        defaultHeaders: {
          "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        },
      })
    }
    return new Anthropic({ apiKey: token })
  }

  private getClient(): Anthropic {
    return this.createClient(this.tokens[this.tokenIndex])
  }

  private rotateToken(): void {
    this.tokenIndex = (this.tokenIndex + 1) % this.tokens.length
  }

  async complete(prompt: string | JudgePrompt): Promise<string> {
    const { system, user } = typeof prompt === "string"
      ? { system: "", user: prompt }
      : prompt

    let lastError: unknown

    for (let attempt = 0; attempt < this.tokens.length; attempt++) {
      try {
        const client = this.getClient()
        const systemBlocks = system
          ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
          : undefined
        const response = await client.messages.create({
          model: this.model,
          max_tokens: 8096,
          ...(systemBlocks ? { system: systemBlocks } : {}),
          messages: [{ role: "user", content: user }],
        })
        if (response.usage) {
          this.usage.inputTokens += response.usage.input_tokens
          this.usage.outputTokens += response.usage.output_tokens
          this.usage.totalTokens += response.usage.input_tokens + response.usage.output_tokens
        }
        this.rotateToken()
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map(b => b.text)
          .join("")
      } catch (err) {
        lastError = err
        const status = (err as { status?: number })?.status
        if (status === 429 || status === 529 || status === 400 || status === 401) {
          console.warn(`[claude] token ${this.tokenIndex} failed (${status}), rotating...`)
          this.rotateToken()
          continue
        }
        throw err
      }
    }

    throw lastError
  }
}
