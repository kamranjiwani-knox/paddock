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
  inputTokens: number
  outputTokens: number
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

// ─── Improvement ─────────────────────────────────────────────

export interface FailurePattern {
  dimension: EvalDimension
  frequency: number
  severity: number
  exampleScenarios: string[]
  suggestedFix: string
}

export interface Patch {
  filePath: string
  operation: "modify" | "create" | "append"
  content: string
  description: string
  rationale: string
}

export interface ImprovementPlan {
  id: string
  targetFailures: string[]
  patches: Patch[]
  estimatedImpact: string
  riskLevel: "low" | "medium" | "high"
}

export interface SandboxResult {
  ok: boolean
  errors: string[]
}

// ─── Loop State ──────────────────────────────────────────────

export type LoopPhase =
  | "idle"
  | "generating_scenarios"
  | "running_agent"
  | "evaluating"
  | "improving"
  | "verifying"
  | "committing"
  | "done"
  | "failed"

export interface LoopState {
  id: string
  phase: LoopPhase
  branchName: string
  iteration: number
  maxIterations: number
  scenarios: Scenario[]
  traces: ExecutionTrace[]
  evaluations: ConsensusResult[]
  improvements: ImprovementPlan[]
  budget: Budget
  passRate: number
  previousPassRate?: number
  tokenUsage: Record<string, TokenUsage>
  startedAt: number
  updatedAt: number
  error?: string
}

export interface Budget {
  maxIterations: number
  maxTimeMs: number
  maxLlmCalls: number
  currentIterations: number
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
  autoImprove: boolean
  maxIterations: number
  maxTimeMs: number
  maxLlmCalls: number
  autoPush: boolean
  useBranch: boolean         // create separate git branch for eval (default: false)
  branchPrefix: string
  blockedTools: string[]
  fullRun: boolean             // skip rerun logic, eval all scenarios fresh
}

export interface JudgeProviderConfig {
  type: "claude" | "gemini" | "openai"
  model: string
  apiKey: string
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
  autoImprove: true,
  maxIterations: 5,
  maxTimeMs: 30 * 60 * 1000,
  maxLlmCalls: 100,
  autoPush: true,
  useBranch: false,
  branchPrefix: "paddock",
  blockedTools: DEFAULT_BLOCKED_TOOLS,
  fullRun: false,
}
