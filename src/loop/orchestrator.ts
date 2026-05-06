import type {
  EvalConfig,
  LoopState,
  ConsensusResult,
  Scenario,
  LastReportData,
} from "../types"
import { AgentRunner } from "../runner/agent-runner"
import type { IAgentRunner } from "../runner/types"
import { loadScenarios } from "../scenario/loader"
import { ScenarioGenerator } from "../scenario/generator"
import { Judge } from "../evaluator/judge"
import { ConsensusEngine } from "../evaluator/consensus"
import { createJudgeProvider } from "../evaluator/providers/factory"
import { BudgetTracker } from "./budget"
import { loadLastReport } from "../report/writer"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

/**
 * Optional adapters for embedding paddock as a library.
 *
 * - `runner`: provide a custom IAgentRunner (e.g. HTTP-based) instead of
 *   the default in-process FilesystemAgentRunner.
 * - `scenarios`: provide scenarios directly, bypassing filesystem load,
 *   filtering, and LLM generation.
 * - `lastReport`: provide previous-run data (or null) directly, bypassing
 *   filesystem load. Used for the rerun-skip-passing logic.
 * - `personality`: override agent personality string passed to judges
 *   (default reads SOUL.md from agentDir).
 */
export interface EvalOrchestratorDeps {
  runner?: IAgentRunner
  scenarios?: Scenario[]
  lastReport?: LastReportData | null
  personality?: string
}

export class EvalOrchestrator {
  private config: EvalConfig
  private deps: EvalOrchestratorDeps
  private state: LoopState
  private aborted = false

  constructor(config: EvalConfig, deps: EvalOrchestratorDeps = {}) {
    this.config = config
    this.deps = deps
    this.state = {
      id: crypto.randomUUID(),
      phase: "idle",
      scenarios: [],
      traces: [],
      evaluations: [],
      budget: {
        maxTimeMs: config.maxTimeMs,
        maxLlmCalls: config.maxLlmCalls,
        currentTimeMs: 0,
        currentLlmCalls: 0,
      },
      passRate: 0,
      tokenUsage: {},
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  getState(): LoopState {
    return { ...this.state }
  }

  abort(): void {
    this.aborted = true
  }

  async run(): Promise<LoopState> {
    const { config, deps } = this

    const runner: IAgentRunner = deps.runner ?? new AgentRunner({
      repoRoot: config.repoRoot,
      agentDir: config.agentDir,
      blockedTools: config.blockedTools,
      concurrency: config.concurrency,
    })

    const judgeProviders = config.judges.map(j => createJudgeProvider(j))
    const judges = judgeProviders.map(p => new Judge(p))
    const consensus = new ConsensusEngine(judges)
    const budget = new BudgetTracker({
      maxTimeMs: config.maxTimeMs,
      maxLlmCalls: config.maxLlmCalls,
    })

    try {
      // ─── 1. SCENARIOS ────────────────────────────────────────
      this.updatePhase("generating_scenarios")
      let scenarios: Scenario[]

      if (deps.scenarios) {
        // Inline source — caller already prepared the suite
        scenarios = deps.scenarios
      } else {
        scenarios = this.selectTemplateScenarios()

        if (!config.scenarioIds) {
          if (scenarios.length < config.scenarioCount && judgeProviders.length > 0) {
            try {
              const soulMd = deps.personality ?? this.readSoulMd()
              const generator = new ScenarioGenerator({
                provider: judgeProviders[0],
                soulMd,
                toolNames: [],
                skills: [],
              })
              const generated = await generator.generateSuite({
                categories: config.categories,
                difficulties: config.difficulties,
                count: config.scenarioCount - scenarios.length,
              })
              budget.recordLlmCall()
              scenarios = [...scenarios, ...generated]
            } catch (err) {
              console.warn(`[orchestrator] LLM scenario generation failed, using templates only: ${err}`)
            }
          }

          scenarios = scenarios.slice(0, config.scenarioCount)
        }
      }
      this.state.scenarios = scenarios
      console.log(`[orchestrator] ${scenarios.length} scenarios ready`)

      // ─── 2. RERUN LOGIC: skip previously-passed ──────────────
      let skippedEvaluations: ConsensusResult[] = []

      if (!config.fullRun) {
        const lastReport = deps.lastReport !== undefined
          ? deps.lastReport
          : loadLastReport(config.repoRoot)
        if (lastReport && lastReport.results.length > 0) {
          const lastResultMap = new Map(lastReport.results.map(r => [r.id, r]))
          const lastKnownIds = new Set([
            ...lastReport.results.map(r => r.id),
            ...lastReport.allScenarioIds,
          ])

          const toSkipIds = new Set<string>()
          for (const s of scenarios) {
            const prev = lastResultMap.get(s.id)
            if (prev && (prev.verdict === "pass" || prev.verdict === "skipped") && lastKnownIds.has(s.id)) {
              toSkipIds.add(s.id)
            }
          }

          if (toSkipIds.size > 0) {
            for (const id of toSkipIds) {
              const prev = lastResultMap.get(id)!
              skippedEvaluations.push({
                scenarioId: id,
                judges: [],
                finalVerdict: "skipped",
                finalScore: prev.score,
                agreement: prev.agreement,
                dimensionScores: {},
                failureReasons: [],
                improvementSuggestions: [],
              })
            }

            scenarios = scenarios.filter(s => !toSkipIds.has(s.id))
            this.state.scenarios = [...scenarios, ...this.state.scenarios.filter(s => toSkipIds.has(s.id))]
            console.log(`[orchestrator] rerun mode: ${toSkipIds.size} passed (skipped), ${scenarios.length} to eval`)
          } else {
            console.log(`[orchestrator] rerun mode: no passing scenarios to skip, running all`)
          }
        } else {
          console.log(`[orchestrator] no previous report found, running full eval`)
        }
      }

      // ─── 3. RUN AGENT ────────────────────────────────────────
      if (scenarios.length === 0) {
        console.log("[orchestrator] no scenarios to run")
      } else {
        this.updatePhase("running_agent")
        console.log(`[orchestrator] running ${scenarios.length} scenarios`)
        const traces = await runner.runSuite(scenarios)
        this.state.traces = traces

        if (this.aborted) {
          this.updatePhase("failed")
          this.state.error = "aborted"
          return this.state
        }

        // ─── 4. EVALUATE ───────────────────────────────────────
        this.updatePhase("evaluating")
        const evaluations: ConsensusResult[] = []

        for (const trace of traces) {
          if (this.aborted) break
          const scenario = scenarios.find(s => s.id === trace.scenarioId)!
          const soulMd = deps.personality ?? trace.metadata.soulMd
          try {
            const result = await consensus.evaluate(trace, scenario, soulMd)
            evaluations.push(result)
            budget.recordLlmCall()
          } catch (err) {
            console.error(`[orchestrator] evaluation failed for ${trace.scenarioId}: ${err}`)
            evaluations.push({
              scenarioId: trace.scenarioId,
              judges: [],
              finalVerdict: "fail",
              finalScore: 0,
              agreement: 0,
              dimensionScores: {},
              failureReasons: [`Evaluation error: ${err}`],
              improvementSuggestions: [],
            })
          }
        }

        this.state.evaluations = [...skippedEvaluations, ...evaluations]
      }

      // If no live runs but we had skipped, still show them
      if (this.state.evaluations.length === 0) {
        this.state.evaluations = skippedEvaluations
      }

      // ─── 5. PASS RATE ────────────────────────────────────────
      const activeEvals = this.state.evaluations.filter(e => e.finalVerdict !== "skipped")
      const passCount = activeEvals.filter(e => e.finalVerdict === "pass").length
      this.state.passRate = activeEvals.length > 0 ? passCount / activeEvals.length : 0

      console.log(`[orchestrator] pass rate: ${(this.state.passRate * 100).toFixed(0)}% (${passCount}/${activeEvals.length}) | ${budget.formatStatus()}`)

      // ─── 6. FINALIZE ─────────────────────────────────────────
      this.updatePhase(this.state.passRate >= config.passThreshold ? "done" : "failed")

      for (const jp of judgeProviders) {
        const key = `${jp.name}/${jp.model}`
        this.state.tokenUsage[key] = { ...jp.usage }
      }

      // Collect agent token usage from each scenario trace and merge under the
      // same `tokenUsage` map the report writer already serialises. We key
      // agent entries as `agent/<model>` (NOT `claude/<model>` — that namespace
      // is reserved for the Claude judge provider, and a collision would
      // silently double-count when agent and judge run on the same Claude
      // model, which is the default in .env.example). Downstream consumers
      // (consistency-test aggregator, cost-summary renderer) detect agent
      // entries via the `agent/` prefix.
      for (const trace of this.state.traces ?? []) {
        if (!trace.agentTokenUsage) continue
        for (const [model, usage] of Object.entries(trace.agentTokenUsage)) {
          const key = `agent/${model}`
          const existing = this.state.tokenUsage[key]
          if (existing) {
            existing.inputTokens += usage.inputTokens
            existing.outputTokens += usage.outputTokens
            existing.cacheCreationTokens =
              (existing.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
            existing.cacheReadTokens =
              (existing.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0)
            existing.thinkingTokens =
              (existing.thinkingTokens ?? 0) + (usage.thinkingTokens ?? 0)
            existing.totalTokens =
              existing.inputTokens +
              (existing.cacheCreationTokens ?? 0) +
              (existing.cacheReadTokens ?? 0) +
              existing.outputTokens +
              (existing.thinkingTokens ?? 0)
          } else {
            this.state.tokenUsage[key] = { ...usage }
          }
        }
      }

      this.state.budget = budget.current()

    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err)
      this.updatePhase("failed")
      console.error(`[orchestrator] fatal error:`, err)
    }

    return this.state
  }

  private updatePhase(phase: LoopState["phase"]): void {
    this.state.phase = phase
    this.state.updatedAt = Date.now()
    console.log(`[orchestrator] phase: ${phase}`)
  }

  private selectTemplateScenarios(): Scenario[] {
    let templates = loadScenarios(this.config.repoRoot)

    if (this.config.scenarioIds) {
      const wanted = this.config.scenarioIds
      const orderById = new Map(wanted.map((id, i) => [id, i]))
      templates = templates
        .filter(s => orderById.has(s.id))
        .sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0))
    }
    if (this.config.categories) {
      templates = templates.filter(s => this.config.categories!.includes(s.category))
    }
    if (this.config.difficulties) {
      templates = templates.filter(s => this.config.difficulties!.includes(s.difficulty))
    }

    return templates
  }

  private readSoulMd(): string {
    const path = join(this.config.agentDir, "SOUL.md")
    try {
      return existsSync(path) ? readFileSync(path, "utf-8") : ""
    } catch {
      return ""
    }
  }
}
