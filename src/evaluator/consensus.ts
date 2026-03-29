import type {
  ConsensusResult,
  JudgeScore,
  Verdict,
  EvalDimension,
  ExecutionTrace,
  Scenario,
} from "../types"
import { Judge } from "./judge"

export class ConsensusEngine {
  private judges: Judge[]
  private minJudges: number

  constructor(judges: Judge[], opts?: { minJudges?: number }) {
    this.judges = judges
    this.minJudges = opts?.minJudges ?? Math.min(2, judges.length)
  }

  async evaluate(
    trace: ExecutionTrace,
    scenario: Scenario,
    soulMd: string,
  ): Promise<ConsensusResult> {
    // 1. Run all judges in parallel
    const results = await Promise.allSettled(
      this.judges.map(j => j.evaluate(trace, scenario, soulMd))
    )

    // 2. Filter successful results
    const scores = results
      .filter((r): r is PromiseFulfilledResult<JudgeScore> => r.status === "fulfilled")
      .map(r => r.value)

    // 3. Require minimum judges
    if (scores.length < this.minJudges) {
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map(r => String(r.reason))
      throw new Error(
        `Only ${scores.length}/${this.judges.length} judges responded (min: ${this.minJudges}). Errors: ${errors.join("; ")}`
      )
    }

    // 4. Median score per dimension
    const dimensionScores = this.computeMedianScores(scores)

    // 5. Majority vote for verdict
    let finalVerdict = this.majorityVote(scores.map(s => s.verdict))

    // 6. Agreement score
    const agreement = this.computeAgreement(scores)

    // 7. Override: low agreement → "partial"
    if (agreement < 0.5) {
      finalVerdict = "partial"
    }

    // 8. Weighted final score from criteria
    let totalWeight = 0
    let weightedSum = 0
    for (const c of scenario.successCriteria) {
      const score = dimensionScores[c.dimension]
      if (score !== undefined) {
        weightedSum += score * c.weight
        totalWeight += c.weight
      }
    }
    const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0

    // 9. Collect failure reasons and suggestions
    const failureReasons = scores
      .filter(s => s.verdict === "fail")
      .flatMap(s => {
        const reasons: string[] = []
        for (const [dim, reason] of Object.entries(s.reasoning)) {
          if (s.scores[dim as EvalDimension] !== undefined && s.scores[dim as EvalDimension]! < 7) {
            reasons.push(`[${s.judgeModel}] ${dim}: ${reason}`)
          }
        }
        return reasons
      })

    const improvementSuggestions = [
      ...new Set(
        scores
          .filter(s => s.verdict !== "pass")
          .flatMap(s => s.suggestions)
      ),
    ]

    return {
      scenarioId: scenario.id,
      judges: scores,
      finalVerdict,
      finalScore,
      agreement,
      dimensionScores,
      failureReasons,
      improvementSuggestions,
    }
  }

  private computeMedianScores(
    scores: JudgeScore[],
  ): Partial<Record<EvalDimension, number>> {
    const dims: EvalDimension[] = [
      "correctness", "tool_usage", "soul_compliance", "response_quality", "error_handling",
    ]
    const result: Partial<Record<EvalDimension, number>> = {}

    for (const dim of dims) {
      const values = scores
        .map(s => s.scores[dim])
        .filter((v): v is number => v !== undefined)
      if (values.length > 0) {
        result[dim] = median(values)
      }
    }

    return result
  }

  private majorityVote(verdicts: Verdict[]): Verdict {
    const counts: Record<Verdict, number> = { pass: 0, fail: 0, partial: 0 }
    for (const v of verdicts) counts[v]++
    return (Object.entries(counts) as [Verdict, number][])
      .sort((a, b) => b[1] - a[1])[0][0]
  }

  private computeAgreement(scores: JudgeScore[]): number {
    if (scores.length <= 1) return 1
    const verdicts = scores.map(s => s.verdict)
    const majority = this.majorityVote(verdicts)
    return verdicts.filter(v => v === majority).length / verdicts.length
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}
