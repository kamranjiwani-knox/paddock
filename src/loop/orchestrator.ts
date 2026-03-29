import type {
  EvalConfig,
  LoopState,
  ConsensusResult,
  Scenario,
} from "../types"
import { AgentRunner } from "../runner/agent-runner"
import { loadScenarios } from "../scenario/loader"
import { ScenarioGenerator } from "../scenario/generator"
import { Judge } from "../evaluator/judge"
import { ConsensusEngine } from "../evaluator/consensus"
import { createJudgeProvider } from "../evaluator/providers/factory"
import { FailureAnalyzer } from "../improver/analyzer"
import { Patcher } from "../improver/patcher"
import { Sandbox } from "../improver/sandbox"
import { BranchManager } from "../git/branch-manager"
import { BudgetTracker } from "./budget"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

export class EvalOrchestrator {
  private config: EvalConfig
  private state: LoopState
  private aborted = false

  constructor(config: EvalConfig) {
    this.config = config
    this.state = {
      id: crypto.randomUUID(),
      phase: "idle",
      branchName: "",
      iteration: 0,
      maxIterations: config.maxIterations,
      scenarios: [],
      traces: [],
      evaluations: [],
      improvements: [],
      budget: {
        maxIterations: config.maxIterations,
        maxTimeMs: config.maxTimeMs,
        maxLlmCalls: config.maxLlmCalls,
        currentIterations: 0,
        currentTimeMs: 0,
        currentLlmCalls: 0,
      },
      passRate: 0,
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
    const { config } = this

    // Build components
    const runner = new AgentRunner({
      repoRoot: config.repoRoot,
      agentDir: config.agentDir,
      blockedTools: config.blockedTools,
    })

    const judgeProviders = config.judges.map(j => createJudgeProvider(j))
    const judges = judgeProviders.map(p => new Judge(p))
    const consensus = new ConsensusEngine(judges)
    const analyzer = new FailureAnalyzer()
    const patcher = new Patcher({
      provider: judgeProviders[0], // use first provider for patching
      repoRoot: config.repoRoot,
    })
    const sandbox = new Sandbox(config.repoRoot)
    const git = new BranchManager(config.repoRoot)
    const budget = new BudgetTracker({
      maxIterations: config.maxIterations,
      maxTimeMs: config.maxTimeMs,
      maxLlmCalls: config.maxLlmCalls,
    })

    try {
      // ─── 1. INIT: create git branch ────────────────────────
      const categoryLabel = config.categories?.join("-") ?? "full"
      const branchName = `${config.branchPrefix}/${Date.now()}-${categoryLabel}`
      await git.saveOriginalBranch()
      await git.createBranch(branchName)
      this.state.branchName = branchName

      // ─── 2. GENERATE SCENARIOS ─────────────────────────────
      this.updatePhase("generating_scenarios")
      let scenarios = this.selectTemplateScenarios()

      // If we need more, generate with LLM
      if (scenarios.length < config.scenarioCount && judgeProviders.length > 0) {
        try {
          const soulMd = this.readSoulMd()
          const generator = new ScenarioGenerator({
            provider: judgeProviders[0],
            soulMd,
            toolNames: [], // will be filled by runner
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
      this.state.scenarios = scenarios
      console.log(`[orchestrator] ${scenarios.length} scenarios ready`)

      // ─── 3. MAIN LOOP ─────────────────────────────────────
      while (!budget.isExhausted() && !this.aborted) {

        // 3a. RUN AGENT
        this.updatePhase("running_agent")
        const scenariosToRun = this.state.iteration === 0
          ? scenarios
          : this.getFailedScenarios(scenarios)

        if (scenariosToRun.length === 0) {
          console.log("[orchestrator] no scenarios to run")
          break
        }

        console.log(`[orchestrator] running ${scenariosToRun.length} scenarios (iteration ${this.state.iteration})`)
        const traces = await runner.runSuite(scenariosToRun)
        this.state.traces = traces

        // 3b. EVALUATE
        this.updatePhase("evaluating")
        const evaluations: ConsensusResult[] = []

        for (const trace of traces) {
          if (this.aborted) break
          const scenario = scenarios.find(s => s.id === trace.scenarioId)!
          const soulMd = trace.metadata.soulMd
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

        // Merge with previous passing evaluations
        const previousPassing = this.state.evaluations
          .filter(e => e.finalVerdict === "pass")
          .filter(e => !evaluations.some(ne => ne.scenarioId === e.scenarioId))
        this.state.evaluations = [...previousPassing, ...evaluations]

        // 3c. CALCULATE PASS RATE
        const totalEvals = this.state.evaluations
        const passCount = totalEvals.filter(e => e.finalVerdict === "pass").length
        this.state.passRate = totalEvals.length > 0 ? passCount / totalEvals.length : 0

        console.log(`[orchestrator] pass rate: ${(this.state.passRate * 100).toFixed(0)}% (${passCount}/${totalEvals.length}) | ${budget.formatStatus()}`)

        // 3d. DECISION GATE
        if (this.state.passRate >= config.passThreshold) {
          console.log("[orchestrator] pass threshold reached!")
          break
        }

        if (!config.autoImprove) {
          console.log("[orchestrator] auto-improve disabled, stopping")
          break
        }

        // Diminishing returns check
        if (this.state.iteration > 0 && this.state.previousPassRate !== undefined) {
          const improvement = this.state.passRate - this.state.previousPassRate
          if (improvement < 0.05) {
            this.state.error = `Diminishing returns: improvement ${(improvement * 100).toFixed(1)}% < 5%`
            console.log(`[orchestrator] ${this.state.error}`)
            break
          }
        }
        this.state.previousPassRate = this.state.passRate

        // 3e. IMPROVE
        this.updatePhase("improving")
        const failures = analyzer.analyze(evaluations)
        if (failures.length === 0) {
          console.log("[orchestrator] no analyzable failures, stopping")
          break
        }

        console.log(`[orchestrator] ${failures.length} failure patterns found, generating patches...`)
        const soulMd = this.readSoulMd()
        const plan = await patcher.generatePlan(failures, soulMd)
        budget.recordLlmCall()

        if (plan.patches.length === 0) {
          console.log("[orchestrator] no patches generated, stopping")
          this.state.error = "Patcher could not generate valid patches"
          break
        }

        await patcher.applyPlan(plan)

        // 3f. VALIDATE
        const sandboxResult = await sandbox.validate()
        if (!sandboxResult.ok) {
          console.warn(`[orchestrator] sandbox validation failed, reverting:`, sandboxResult.errors)
          await patcher.revertPlan(plan)
          this.state.error = `Sandbox failed: ${sandboxResult.errors.join("; ").slice(0, 200)}`
          // Continue loop — maybe next iteration finds different patches
        } else {
          this.state.improvements.push(plan)
          await git.commit(`paddock: iteration ${this.state.iteration + 1} — ${plan.estimatedImpact.slice(0, 50)}`)
          console.log(`[orchestrator] patches applied and committed`)
        }

        budget.recordIteration()
        this.state.iteration++
        this.state.budget = budget.current()
      }

      // ─── 4. FINALIZE ──────────────────────────────────────
      if (this.state.passRate >= config.passThreshold) {
        this.updatePhase("committing")
        await git.commit(`paddock: final — pass rate ${(this.state.passRate * 100).toFixed(0)}%`)
        if (config.autoPush) {
          try {
            await git.push()
          } catch (err) {
            console.warn(`[orchestrator] push failed: ${err}`)
          }
        }
        this.updatePhase("done")
      } else {
        this.updatePhase("failed")
      }

      await git.restoreOriginalBranch()

    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err)
      this.updatePhase("failed")
      console.error(`[orchestrator] fatal error:`, err)
      try {
        await git.restoreOriginalBranch()
      } catch {}
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

    if (this.config.categories) {
      templates = templates.filter(s => this.config.categories!.includes(s.category))
    }
    if (this.config.difficulties) {
      templates = templates.filter(s => this.config.difficulties!.includes(s.difficulty))
    }

    return templates
  }

  private getFailedScenarios(allScenarios: Scenario[]): Scenario[] {
    const failedIds = new Set(
      this.state.evaluations
        .filter(e => e.finalVerdict !== "pass")
        .map(e => e.scenarioId)
    )
    return allScenarios.filter(s => failedIds.has(s.id))
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
