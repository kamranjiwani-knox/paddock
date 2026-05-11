// ─── Scenario ────────────────────────────────────────────────

export type ScenarioCategory =
  | "tool_use"
  | "memory"
  | "conversation"
  | "patching_workflow"
  | "edge_case"
  | "multi_turn"
  | "error_recovery"

export type Difficulty = "easy" | "medium" | "hard" | "adversarial"

export interface Scenario {
  id: string
  category: ScenarioCategory
  difficulty: Difficulty
  name: string
  description: string
  messages: ScenarioMessage[]
  expectedBehavior: string
  successCriteria: SuccessCriterion[]
  setup?: ScenarioSetup
}

export interface ScenarioMessage {
  text: string
  from: string
  delayMs?: number
}

export interface SuccessCriterion {
  dimension: EvalDimension
  description: string
  weight: number
}

export type EvalDimension =
  | "correctness"
  | "tool_usage"
  | "soul_compliance"
  | "response_quality"
  | "error_handling"

export interface ScenarioSetup {
  files?: Record<string, string>
  env?: Record<string, string>
  tools?: string[]
}

// ─── Execution Trace ─────────────────────────────────────────

export interface ExecutionTrace {
  scenarioId: string
  responses: TracedResponse[]
  toolCalls: TracedToolCall[]
  errors: TracedError[]
  timing: TraceTiming
  metadata: TraceMetadata
  /** Cumulative token usage from the agent's LLM calls during this scenario,
   * keyed by model name (e.g. "claude-opus-4-7"). Captured via
   * `runtime.getTokenUsage()` after the scenario completes. Undefined when the
   * agent runtime doesn't expose token usage (e.g. claude-cli provider). */
  agentTokenUsage?: Record<string, TokenUsage>
}

export interface TracedResponse {
  text: string
  ts: number
}

export interface TracedToolCall {
  name: string
  params: unknown
  result: unknown
  durationMs: number
  ts: number
  error?: string
}

export interface TracedError {
  message: string
  stack?: string
  ts: number
  phase: "llm" | "tool" | "channel" | "runtime"
}

export interface TraceTiming {
  startedAt: number
  endedAt: number
  totalMs: number
}

export interface TraceMetadata {
  agentDir: string
  soulMd: string
  configJson: string
  toolNames: string[]
}

// ─── Evaluation ──────────────────────────────────────────────

export interface JudgeScore {
  judgeModel: string
  scores: Partial<Record<EvalDimension, number>>
  reasoning: Partial<Record<EvalDimension, string>>
  overallScore: number
  verdict: Verdict
  confidence: number
  suggestions: string[]
  raw: string
}

export type Verdict = "pass" | "fail" | "partial" | "skipped"

export interface ConsensusResult {
  scenarioId: string
  judges: JudgeScore[]
  finalVerdict: Verdict
  finalScore: number
  agreement: number
  dimensionScores: Partial<Record<EvalDimension, number>>
  failureReasons: string[]
  improvementSuggestions: string[]
}

export interface TokenUsage {
  /** Un-cached input tokens (full input rate). Cache reads / writes are
   * tracked separately below — keep them out of this field. */
  inputTokens: number
  /** Tokens written to prompt cache. Anthropic charges 1.25× input rate.
   * OpenAI uses implicit caching with no creation charge (left 0). */
  cacheCreationTokens?: number
  /** Tokens read from prompt cache. Anthropic charges 0.1× input rate.
   * OpenAI charges 0.5× input rate. */
  cacheReadTokens?: number
  /** Visible output tokens only — does NOT include reasoning/thinking. */
  outputTokens: number
  /** Thinking / reasoning tokens billed at the output rate. Populated when
   * the provider exposes it as a distinct counter:
   *   Gemini → `thoughtsTokenCount`
   *   OpenAI → `completion_tokens_details.reasoning_tokens`
   * Anthropic doesn't split thinking out in `usage` — the model's
   * `output_tokens` already includes thinking blocks — so the agent and
   * Claude judge leave this 0 (and outputTokens contains the combined sum).
   * Cost = (output + thinking) × output rate. */
  thinkingTokens?: number
  /** Sum of all the above. */
  totalTokens: number
}

export interface JudgePrompt {
  /** Static prefix — identical across every judge call within a paddock run.
   * Goes in the cacheable position (Anthropic system w/ cache_control,
   * OpenAI system role, Gemini systemInstruction). */
  system: string
  /** Variable suffix — the per-eval scenario, SOUL.md, execution trace,
   * and success criteria. Goes in the user message. */
  user: string
}

export interface JudgeProvider {
  name: string
  model: string
  usage: TokenUsage
  /** Accepts either a plain string (legacy/back-compat) or a structured
   * JudgePrompt for caching-aware providers. */
  complete(prompt: string | JudgePrompt): Promise<string>
}

// ─── Loop State ──────────────────────────────────────────────

export type LoopPhase =
  | "idle"
  | "generating_scenarios"
  | "running_agent"
  | "evaluating"
  | "done"
  | "failed"

export interface LoopState {
  id: string
  phase: LoopPhase
  scenarios: Scenario[]
  traces: ExecutionTrace[]
  evaluations: ConsensusResult[]
  budget: Budget
  passRate: number
  tokenUsage: Record<string, TokenUsage>
  startedAt: number
  updatedAt: number
  error?: string
}

export interface Budget {
  maxTimeMs: number
  maxLlmCalls: number
  currentTimeMs: number
  currentLlmCalls: number
}

// ─── Config ──────────────────────────────────────────────────

export interface EvalConfig {
  repoRoot: string
  agentDir: string
  categories?: ScenarioCategory[]
  difficulties?: Difficulty[]
  scenarioIds?: string[]
  scenarioCount: number
  passThreshold: number
  judges: JudgeProviderConfig[]
  maxTimeMs: number
  maxLlmCalls: number
  blockedTools: string[]
  fullRun: boolean             // skip rerun logic, eval all scenarios fresh
  concurrency: number          // max concurrent scenarios (default: 1 = sequential)
}

export interface JudgeProviderConfig {
  type: "claude" | "gemini" | "openai"
  model: string
  /**
   * API key for direct-API mode. Optional because Claude and Gemini judges
   * also support Vertex AI mode, which they detect from
   * `ANTHROPIC_VERTEX_PROJECT_ID` + `CLOUD_ML_REGION` env vars and authenticate
   * to via the Google Cloud ADC/WIF chain — no API key needed in that mode.
   *
   * OpenAI does not have a Vertex equivalent and still requires an API key.
   *
   * When omitted, the provider falls back to whatever env-detected auth path
   * is available; if none is available, the provider throws at construction
   * time with a clear error.
   */
  apiKey?: string
}

export const DEFAULT_BLOCKED_TOOLS = [
  "exec",
  "process",
  "shutdown",
  "spawn_agent",
  "gcloud_exec",
  "kubectl_exec",
  "telegram_send",
  "tts",
]

export interface LastReportData {
  timestamp: string
  passRate: number
  results: Array<{
    id: string
    verdict: Verdict
    score: number
    agreement: number
  }>
  allScenarioIds: string[]
}

export const DEFAULT_EVAL_CONFIG: Omit<EvalConfig, "repoRoot" | "agentDir" | "judges"> = {
  scenarioCount: 10,
  passThreshold: 0.8,
  maxTimeMs: 30 * 60 * 1000,
  maxLlmCalls: 100,
  blockedTools: DEFAULT_BLOCKED_TOOLS,
  fullRun: false,
  concurrency: 1,
}
