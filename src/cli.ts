#!/usr/bin/env bun
import { parseArgs } from "util"
import { resolve } from "path"
import { AgentRunner } from "./runner/agent-runner"
import { loadScenarios } from "./scenario/loader"
import { ConsensusEngine } from "./evaluator/consensus"
import { Judge } from "./evaluator/judge"
import { createJudgeProvider } from "./evaluator/providers/factory"
import { FailureAnalyzer } from "./improver/analyzer"
import { Patcher } from "./improver/patcher"
import { Sandbox } from "./improver/sandbox"
import { BranchManager } from "./git/branch-manager"
import { BudgetTracker } from "./loop/budget"
import { EvalOrchestrator } from "./loop/orchestrator"
import { ScenarioGenerator } from "./scenario/generator"
import type { EvalConfig, JudgeProviderConfig, ScenarioCategory, Difficulty } from "./types"
import { DEFAULT_BLOCKED_TOOLS } from "./types"

// ─── Helpers ─────────────────────────────────────────────────

function color(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`
}
const green = (t: string) => color(32, t)
const red = (t: string) => color(31, t)
const yellow = (t: string) => color(33, t)
const cyan = (t: string) => color(36, t)
const bold = (t: string) => color(1, t)
const dim = (t: string) => color(2, t)

function printHeader() {
  console.log()
  console.log(bold("  Paddock") + dim(" — Agent Eval Loop"))
  console.log()
}

function printUsage() {
  printHeader()
  console.log(`${bold("Usage:")} bun run src/cli.ts <command> [options]

${bold("Commands:")}
  ${cyan("run")}          Run full eval cycle
  ${cyan("scenarios")}    Generate and preview scenarios
  ${cyan("report")}       Show results of last run (TODO)

${bold("Options for 'run':")}
  --repo           Path to agent runtime repo (default: auto-detect)
  --agent-dir      Path to .agent directory
  --categories     Comma-separated: tool_use,memory,conversation,edge_case,...
  --difficulties   Comma-separated: easy,medium,hard,adversarial
  --count          Number of scenarios (default: 10)
  --threshold      Pass rate 0-1 (default: 0.8)
  --max-iter       Max improvement iterations (default: 5)
  --no-improve     Evaluate only, don't improve
  --no-push        Don't push to git
  --no-generate    Use only built-in templates, skip LLM generation

${bold("Options for 'scenarios':")}
  --categories     Comma-separated categories
  --count          Number to generate (default: 5)

${bold("Environment:")}
  CLAUDE_CODE_OAUTH_TOKEN  Claude tokens, comma-separated for rotation (preferred)
  ANTHROPIC_API_KEY        Claude API key (fallback)
  GEMINI_API_KEY      Gemini judge (optional)
  OPENAI_API_KEY      GPT judge (optional)
  EVAL_REPO_ROOT      Override repo root
  EVAL_AGENT_DIR      Override .agent dir
  EVAL_LLM_MODEL      Agent LLM model (default: claude-sonnet-4-6)
`)
}

function detectRepoRoot(): string {
  // Try EVAL_REPO_ROOT env
  if (process.env.EVAL_REPO_ROOT) return resolve(process.env.EVAL_REPO_ROOT)
  // Try common locations
  const candidates = [
    resolve(process.cwd(), ".."),
    resolve(import.meta.dir, "../.."),
  ]
  for (const p of candidates) {
    try {
      const pkg = Bun.file(resolve(p, "package.json"))
      // Sync check not available, just return first candidate
      return p
    } catch {}
  }
  throw new Error("Cannot detect repo root. Use --repo or EVAL_REPO_ROOT env var.")
}

function buildJudgeConfigs(): JudgeProviderConfig[] {
  const configs: JudgeProviderConfig[] = []

  // Prefer CLAUDE_CODE_OAUTH_TOKEN (supports comma-separated token rotation)
  const claudeKey = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
  if (claudeKey) {
    configs.push({
      type: "claude",
      model: "claude-sonnet-4-6",
      apiKey: claudeKey,
    })
  }

  if (process.env.GEMINI_API_KEY) {
    configs.push({
      type: "gemini",
      model: "gemini-2.5-pro",
      apiKey: process.env.GEMINI_API_KEY,
    })
  }

  if (process.env.OPENAI_API_KEY) {
    configs.push({
      type: "openai",
      model: "gpt-4o",
      apiKey: process.env.OPENAI_API_KEY,
    })
  }

  return configs
}

// ─── Commands ────────────────────────────────────────────────

async function cmdRun(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      "agent-dir": { type: "string" },
      categories: { type: "string" },
      difficulties: { type: "string" },
      count: { type: "string", default: "10" },
      threshold: { type: "string", default: "0.8" },
      "max-iter": { type: "string", default: "5" },
      "no-improve": { type: "boolean", default: false },
      "no-push": { type: "boolean", default: false },
      "no-generate": { type: "boolean", default: false },
    },
    strict: false,
  })

  printHeader()

  const repoRoot = values.repo && typeof values.repo === "string" ? resolve(values.repo) : detectRepoRoot()
  const agentDir = values["agent-dir"] && typeof values["agent-dir"] === "string"
    ? resolve(values["agent-dir"])
    : resolve(repoRoot, ".agent")

  const judgeConfigs = buildJudgeConfigs()
  if (judgeConfigs.length === 0) {
    console.error(red("Error: No API keys found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY."))
    process.exit(1)
  }

  const categories = typeof values.categories === "string"
    ? values.categories.split(",") as ScenarioCategory[]
    : undefined

  const difficulties = typeof values.difficulties === "string"
    ? values.difficulties.split(",") as Difficulty[]
    : undefined

  const config: EvalConfig = {
    repoRoot,
    agentDir,
    categories,
    difficulties,
    scenarioCount: parseInt(String(values.count ?? "10")),
    passThreshold: parseFloat(String(values.threshold ?? "0.8")),
    judges: judgeConfigs,
    autoImprove: !values["no-improve"],
    maxIterations: parseInt(String(values["max-iter"] ?? "5")),
    maxTimeMs: 30 * 60 * 1000,
    maxLlmCalls: 100,
    autoPush: !values["no-push"],
    branchPrefix: "eval",
    blockedTools: DEFAULT_BLOCKED_TOOLS,
  }

  console.log(`  ${dim("Repo:")}       ${repoRoot}`)
  console.log(`  ${dim("Agent dir:")}  ${agentDir}`)
  console.log(`  ${dim("Judges:")}     ${judgeConfigs.map(j => j.type).join(", ")}`)
  console.log(`  ${dim("Categories:")} ${categories?.join(", ") ?? "all"}`)
  console.log(`  ${dim("Scenarios:")}  ${config.scenarioCount}`)
  console.log(`  ${dim("Threshold:")}  ${(config.passThreshold * 100).toFixed(0)}%`)
  console.log(`  ${dim("Improve:")}    ${config.autoImprove ? "yes" : "no"}`)
  console.log()

  const orchestrator = new EvalOrchestrator(config)
  const state = await orchestrator.run()

  // Print results
  console.log()
  console.log(bold("  Results"))
  console.log()
  console.log(`  ${dim("Phase:")}     ${state.phase}`)
  console.log(`  ${dim("Pass rate:")} ${state.passRate >= config.passThreshold ? green : red}(${(state.passRate * 100).toFixed(0)}%)`)
  console.log(`  ${dim("Iterations:")} ${state.iteration}`)
  console.log(`  ${dim("Branch:")}    ${state.branchName}`)

  if (state.error) {
    console.log(`  ${red("Error:")}     ${state.error}`)
  }

  // Per-scenario results
  if (state.evaluations.length > 0) {
    console.log()
    console.log(bold("  Scenario Results"))
    console.log()
    for (const eval_ of state.evaluations) {
      const icon = eval_.finalVerdict === "pass" ? green("PASS")
        : eval_.finalVerdict === "partial" ? yellow("PARTIAL")
        : red("FAIL")
      console.log(`  ${icon} ${eval_.scenarioId} — score: ${eval_.finalScore.toFixed(1)}/10 — agreement: ${(eval_.agreement * 100).toFixed(0)}%`)
      if (eval_.failureReasons.length > 0) {
        for (const reason of eval_.failureReasons.slice(0, 2)) {
          console.log(`       ${dim(typeof reason === "string" ? reason.slice(0, 100) : JSON.stringify(reason).slice(0, 100))}`)
        }
      }
    }
  }

  console.log()
  process.exit(state.phase === "done" ? 0 : 1)
}

async function cmdScenarios(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      categories: { type: "string" },
      count: { type: "string", default: "5" },
    },
    strict: false,
  })

  printHeader()

  const repoRoot = values.repo && typeof values.repo === "string" ? resolve(values.repo) : detectRepoRoot()
  const categories = typeof values.categories === "string"
    ? values.categories.split(",") as ScenarioCategory[]
    : undefined

  const count = parseInt(String(values.count ?? "5"))

  let scenarios = loadScenarios(repoRoot)

  if (categories) {
    scenarios = scenarios.filter(s => categories.includes(s.category))
  }

  scenarios = scenarios.slice(0, count)

  console.log(bold(`  ${scenarios.length} Scenarios`))
  console.log()

  for (const s of scenarios) {
    console.log(`  ${cyan(s.id)}`)
    console.log(`  ${dim("Category:")} ${s.category} | ${dim("Difficulty:")} ${s.difficulty}`)
    console.log(`  ${dim("Messages:")} ${s.messages.length}`)
    console.log(`  ${dim("Expected:")} ${s.expectedBehavior.slice(0, 80)}`)
    console.log()
  }
}

// ─── Main ────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case "run":
    await cmdRun(args)
    break
  case "scenarios":
    await cmdScenarios(args)
    break
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage()
    break
  default:
    console.error(red(`Unknown command: ${command}`))
    printUsage()
    process.exit(1)
}
