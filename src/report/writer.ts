import { join } from "path"
import { mkdirSync, readdirSync, readFileSync, existsSync } from "fs"
import type { LoopState, LastReportData, Verdict } from "../types"

export interface ReportResult {
  jsonPath: string
  mdPath: string
}

export interface ReportPayload {
  /** Structured JSON payload (already-shaped object, not stringified). */
  json: object
  /** Human-readable markdown report. */
  md: string
}

/**
 * Build report payloads in memory without writing to disk.
 * Use this when embedding paddock as a library (e.g. ranch persists to S3/DB).
 */
export function buildReport(state: LoopState): ReportPayload {
  return {
    json: buildJsonReport(state),
    md: buildMarkdownReport(state),
  }
}

export function saveReport(repoRoot: string, state: LoopState): ReportResult {
  const reportsDir = join(repoRoot, ".paddock", "reports")
  mkdirSync(reportsDir, { recursive: true })

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const baseName = `eval-${ts}`
  const { json, md } = buildReport(state)

  const jsonPath = join(reportsDir, `${baseName}.json`)
  Bun.write(jsonPath, JSON.stringify(json, null, 2))

  const mdPath = join(reportsDir, `${baseName}.md`)
  Bun.write(mdPath, md)

  return { jsonPath, mdPath }
}

/**
 * Load the most recent JSON report from .paddock/reports/.
 * Returns null if no reports exist.
 */
export function loadLastReport(repoRoot: string): LastReportData | null {
  const reportsDir = join(repoRoot, ".paddock", "reports")
  if (!existsSync(reportsDir)) return null

  const jsonFiles = readdirSync(reportsDir)
    .filter(f => f.startsWith("eval-") && f.endsWith(".json"))
    .sort()

  if (jsonFiles.length === 0) return null

  const lastFile = join(reportsDir, jsonFiles[jsonFiles.length - 1])
  try {
    const raw = JSON.parse(readFileSync(lastFile, "utf-8"))
    return {
      timestamp: raw.timestamp ?? "",
      passRate: raw.passRate ?? 0,
      results: (raw.results ?? []).map((r: Record<string, unknown>) => ({
        id: String(r.id ?? ""),
        verdict: String(r.verdict ?? "fail") as Verdict,
        score: Number(r.score ?? 0),
        agreement: Number(r.agreement ?? 0),
      })),
      allScenarioIds: Array.isArray(raw.allScenarioIds) ? raw.allScenarioIds : [],
    }
  } catch {
    return null
  }
}

function buildJsonReport(state: LoopState): object {
  return {
    timestamp: new Date().toISOString(),
    phase: state.phase,
    passRate: state.passRate,
    scenarioCount: state.evaluations.length,
    allScenarioIds: state.scenarios.map(s => s.id),
    tokenUsage: state.tokenUsage,
    results: state.evaluations.map(e => ({
      id: e.scenarioId,
      verdict: e.finalVerdict,
      score: e.finalScore,
      agreement: e.agreement,
      dimensions: e.dimensionScores,
      failureReasons: e.failureReasons,
      judges: e.judges.map(j => ({
        model: j.judgeModel,
        score: j.overallScore,
        verdict: j.verdict,
        reasoning: j.reasoning,
      })),
    })),
    errors: state.traces.flatMap(t => t.errors.map(e => ({
      scenario: t.scenarioId,
      phase: e.phase,
      message: e.message,
    }))),
  }
}

function buildMarkdownReport(state: LoopState): string {
  const pass = state.evaluations.filter(e => e.finalVerdict === "pass").length
  const partial = state.evaluations.filter(e => e.finalVerdict === "partial").length
  const fail = state.evaluations.filter(e => e.finalVerdict === "fail").length
  const skipped = state.evaluations.filter(e => e.finalVerdict === "skipped").length

  const lines: string[] = [
    `# Eval Report — ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    "",
    `**Pass rate:** ${(state.passRate * 100).toFixed(0)}% | **Pass:** ${pass} | **Partial:** ${partial} | **Fail:** ${fail}` + (skipped > 0 ? ` | **Skipped:** ${skipped}` : ""),
    "",
  ]

  // Token usage
  const providers = Object.entries(state.tokenUsage)
  if (providers.length > 0) {
    lines.push("## Token Usage", "", "| Provider | Input | Output | Total |", "|----------|-------|--------|-------|")
    let grandIn = 0, grandOut = 0
    for (const [key, u] of providers) {
      lines.push(`| ${key} | ${u.inputTokens.toLocaleString()} | ${u.outputTokens.toLocaleString()} | ${u.totalTokens.toLocaleString()} |`)
      grandIn += u.inputTokens
      grandOut += u.outputTokens
    }
    if (providers.length > 1) {
      lines.push(`| **Total** | **${grandIn.toLocaleString()}** | **${grandOut.toLocaleString()}** | **${(grandIn + grandOut).toLocaleString()}** |`)
    }
    lines.push("")
  }

  // Results table
  lines.push(
    "## Results",
    "",
    "| Verdict | Scenario | Score | Agreement |",
    "|---------|----------|-------|-----------|",
  )
  for (const e of state.evaluations) {
    const icon = e.finalVerdict === "pass" ? "PASS"
      : e.finalVerdict === "partial" ? "PARTIAL"
      : e.finalVerdict === "skipped" ? "SKIPPED"
      : "FAIL"
    lines.push(`| ${icon} | ${e.scenarioId} | ${e.finalScore.toFixed(1)}/10 | ${(e.agreement * 100).toFixed(0)}% |`)
  }

  // Details for non-pass scenarios
  const nonPass = state.evaluations.filter(e => e.finalVerdict !== "pass")
  if (nonPass.length > 0) {
    lines.push("", "## Details", "")
    for (const e of nonPass) {
      lines.push(`### ${e.scenarioId} (${e.finalVerdict} — ${e.finalScore.toFixed(1)}/10)`, "")
      for (const j of e.judges) {
        lines.push(`**${j.judgeModel}** (${j.overallScore.toFixed(1)}/10):`)
        for (const [dim, text] of Object.entries(j.reasoning)) {
          if (text) lines.push(`- *${dim}*: ${text}`)
        }
        lines.push("")
      }
    }
  }

  return lines.join("\n") + "\n"
}
