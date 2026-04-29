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
 *
 * Extended thinking: enabled by default with EVAL_JUDGE_THINKING_BUDGET-token
 * budget so the judge reasons through the agent trace + SOUL.md before
 * scoring, matching the agent's own thinking depth. Without this the judge
 * runs single-pass while the agent runs chain-of-thought, which makes
 * judge-vs-judge agreement noisy. Set EVAL_JUDGE_THINKING_BUDGET=0 to disable.
 */
function parseBudget(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[claude-judge] invalid env value "${raw}", using ${fallback}`)
    return fallback
  }
  return Math.floor(n)
}
const JUDGE_THINKING_BUDGET = parseBudget(process.env.EVAL_JUDGE_THINKING_BUDGET, 8000)
const JUDGE_MAX_TOKENS = parseBudget(process.env.EVAL_JUDGE_MAX_TOKENS, 16000)

// Mirror the agent's THINKING_MODELS allowlist exactly. Adding speculative
// matches (e.g. claude-haiku-4) before Anthropic confirms support risks a
// 400 from the API on a model the user might pick via env override.
const SUPPORTS_THINKING = (model: string): boolean =>
  /^(claude-opus-4|claude-sonnet-4)/.test(model)

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

  private thinkingEnabled(): boolean {
    return JUDGE_THINKING_BUDGET > 0 && SUPPORTS_THINKING(this.model)
  }

  private createClient(token: string): Anthropic {
    const betaHeaders: string[] = []
    if (this.isOAuthToken(token)) {
      betaHeaders.push("oauth-2025-04-20", "claude-code-20250219")
    }
    if (this.thinkingEnabled()) {
      betaHeaders.push("interleaved-thinking-2025-05-14")
    }

    if (this.isOAuthToken(token)) {
      return new Anthropic({
        authToken: token,
        defaultHeaders: { "anthropic-beta": betaHeaders.join(",") },
      })
    }
    if (betaHeaders.length > 0) {
      return new Anthropic({
        apiKey: token,
        defaultHeaders: { "anthropic-beta": betaHeaders.join(",") },
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
        const thinking = this.thinkingEnabled()
        const response = await client.messages.create({
          model: this.model,
          max_tokens: thinking ? JUDGE_MAX_TOKENS : 8096,
          ...(systemBlocks ? { system: systemBlocks } : {}),
          messages: [{ role: "user", content: user }],
          ...(thinking
            ? { thinking: { type: "enabled" as const, budget_tokens: JUDGE_THINKING_BUDGET } }
            : {}),
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
