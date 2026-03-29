import type { ConsensusResult, FailurePattern, EvalDimension } from "../types"

export class FailureAnalyzer {
  /**
   * Analyze consensus results to find patterns in failures.
   * Groups by dimension, ranks by (frequency * severity).
   */
  analyze(results: ConsensusResult[]): FailurePattern[] {
    const failed = results.filter(
      r => r.finalVerdict === "fail" || r.finalVerdict === "partial"
    )

    if (failed.length === 0) return []

    const byDimension = new Map<EvalDimension, {
      count: number
      totalDeficit: number
      scenarios: Set<string>
      suggestions: Set<string>
    }>()

    for (const result of failed) {
      for (const [dim, score] of Object.entries(result.dimensionScores)) {
        if (score === undefined || score >= 7) continue

        const d = dim as EvalDimension
        const entry = byDimension.get(d) ?? {
          count: 0,
          totalDeficit: 0,
          scenarios: new Set(),
          suggestions: new Set(),
        }

        entry.count++
        entry.totalDeficit += 10 - score
        entry.scenarios.add(result.scenarioId)
        for (const s of result.improvementSuggestions) {
          entry.suggestions.add(s)
        }

        byDimension.set(d, entry)
      }
    }

    return [...byDimension.entries()]
      .map(([dim, data]) => ({
        dimension: dim,
        frequency: data.count,
        severity: data.totalDeficit / data.count,
        exampleScenarios: [...data.scenarios],
        suggestedFix: [...data.suggestions].join("\n"),
      }))
      .sort((a, b) => (b.frequency * b.severity) - (a.frequency * a.severity))
  }
}
