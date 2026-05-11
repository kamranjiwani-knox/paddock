import Anthropic from "@anthropic-ai/sdk"
import type { JudgeProvider, JudgePrompt, TokenUsage } from "../../types"

/**
 * Claude judge provider — supports two auth modes, auto-detected from env.
 *
 *   Vertex AI mode (preferred for FedRAMP-aligned deployments):
 *     - Active when `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` are set.
 *     - Uses `@anthropic-ai/vertex-sdk` (optional peer dep — install
 *       separately for this mode).
 *     - Auth is Application Default Credentials locally and Workload Identity
 *       Federation in production via `google-auth-library`'s chain.
 *     - No token rotation — Vertex quota is per-GCP-project, managed via the
 *       Google Cloud console rather than by swapping credentials.
 *
 *   Direct API mode (default for public users):
 *     - Active when neither Vertex env is set but an API key / OAuth token
 *       is provided.
 *     - Uses `@anthropic-ai/sdk` against `api.anthropic.com`.
 *     - Supports comma-separated rotation of `ANTHROPIC_API_KEY` or
 *       `CLAUDE_CODE_OAUTH_TOKEN` (sk-ant-oat01-*) with `authToken` + beta
 *       headers.
 *
 * Prompt caching: when complete() receives a JudgePrompt, the static system
 * prefix is sent as a cached block (cache_control: ephemeral). Anthropic
 * caches everything up to and including that breakpoint. Subsequent calls
 * within the 5-min TTL pay 10% of input cost on the cached prefix. Works
 * identically in both auth modes.
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

/**
 * Minimal client shape — both `Anthropic` and `AnthropicVertex` expose this.
 * Using a structural type avoids importing AnthropicVertex eagerly: the
 * @anthropic-ai/vertex-sdk peer dep is only loaded at runtime in Vertex mode.
 */
type AnthropicClient = { messages: Anthropic["messages"] }

type ClaudeMode =
  | { kind: "vertex"; projectId: string; region: string; client?: AnthropicClient }
  | { kind: "api-key"; tokens: string[]; tokenIndex: number }

function detectVertexMode(): { projectId: string; region: string } | null {
  const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID
  const region = process.env.CLOUD_ML_REGION
  if (projectId && region) return { projectId, region }
  return null
}

export class ClaudeJudgeProvider implements JudgeProvider {
  name = "claude"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private mode: ClaudeMode

  constructor(apiKeyOrTokens: string | undefined, model = "claude-sonnet-4-6") {
    this.model = model
    const vertex = detectVertexMode()
    if (vertex) {
      // Vertex mode takes priority — operators who set both Vertex env AND
      // a legacy API key get Vertex routing, which matches the migration
      // intent for FedRAMP-aligned deployments.
      this.mode = { kind: "vertex", projectId: vertex.projectId, region: vertex.region }
      return
    }
    const tokens = (apiKeyOrTokens ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
    if (tokens.length === 0) {
      throw new Error(
        "ClaudeJudgeProvider: no auth configured. Set ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION for Vertex mode, or pass an ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN for direct mode.",
      )
    }
    this.mode = { kind: "api-key", tokens, tokenIndex: 0 }
  }

  private isOAuthToken(token: string): boolean {
    return token.startsWith("sk-ant-oat")
  }

  private thinkingEnabled(): boolean {
    return JUDGE_THINKING_BUDGET > 0 && SUPPORTS_THINKING(this.model)
  }

  /** Lazy-load the Vertex SDK so direct-API users don't have to install it. */
  private async getVertexClient(): Promise<AnthropicClient> {
    if (this.mode.kind !== "vertex") {
      throw new Error("getVertexClient called outside Vertex mode")
    }
    if (this.mode.client) return this.mode.client
    let AnthropicVertexCtor: new (opts: { projectId: string; region: string }) => AnthropicClient
    try {
      const mod = await import("@anthropic-ai/vertex-sdk")
      AnthropicVertexCtor = mod.AnthropicVertex as unknown as typeof AnthropicVertexCtor
    } catch {
      throw new Error(
        "Vertex mode requires the optional peer dependency `@anthropic-ai/vertex-sdk`. Install it with: npm install @anthropic-ai/vertex-sdk",
      )
    }
    this.mode.client = new AnthropicVertexCtor({
      projectId: this.mode.projectId,
      region: this.mode.region,
    })
    return this.mode.client
  }

  private createApiKeyClient(token: string): Anthropic {
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

  private rotateApiKey(): void {
    if (this.mode.kind === "api-key") {
      this.mode.tokenIndex = (this.mode.tokenIndex + 1) % this.mode.tokens.length
    }
  }

  private recordUsage(
    usage:
      | (Anthropic.Usage & {
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        })
      | undefined,
  ): void {
    if (!usage) return
    // Anthropic surfaces 4 input buckets when prompt caching is on. Track
    // them disjointly so the cost report can apply correct discounted rates
    // (cache reads at 0.1×, cache creation at 1.25×). `input_tokens` from
    // the SDK is already the un-cached portion.
    this.usage.inputTokens += usage.input_tokens ?? 0
    this.usage.cacheCreationTokens =
      (this.usage.cacheCreationTokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    this.usage.cacheReadTokens =
      (this.usage.cacheReadTokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    this.usage.outputTokens += usage.output_tokens ?? 0
    // Anthropic doesn't split thinking out — output_tokens already includes
    // thinking blocks. Leave thinkingTokens unset.
    this.usage.totalTokens =
      this.usage.inputTokens +
      (this.usage.cacheCreationTokens ?? 0) +
      (this.usage.cacheReadTokens ?? 0) +
      this.usage.outputTokens +
      (this.usage.thinkingTokens ?? 0)
  }

  private async callOnce(client: AnthropicClient, system: string, user: string): Promise<string> {
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
    this.recordUsage(response.usage as Parameters<typeof this.recordUsage>[0])
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
  }

  async complete(prompt: string | JudgePrompt): Promise<string> {
    const { system, user } = typeof prompt === "string"
      ? { system: "", user: prompt }
      : prompt

    if (this.mode.kind === "vertex") {
      const client = await this.getVertexClient()
      return this.callOnce(client, system, user)
    }

    // API-key mode with token rotation on retryable failures.
    let lastError: unknown
    for (let attempt = 0; attempt < this.mode.tokens.length; attempt++) {
      try {
        const client = this.createApiKeyClient(this.mode.tokens[this.mode.tokenIndex])
        const text = await this.callOnce(client, system, user)
        this.rotateApiKey()
        return text
      } catch (err) {
        lastError = err
        const status = (err as { status?: number })?.status
        if (status === 429 || status === 529 || status === 400 || status === 401) {
          console.warn(`[claude] token ${this.mode.tokenIndex} failed (${status}), rotating...`)
          this.rotateApiKey()
          continue
        }
        throw err
      }
    }
    throw lastError
  }
}
