import type { JudgeProvider, JudgeScore, ExecutionTrace, Scenario } from "../types"
import { buildJudgePrompt, parseJudgeResponse } from "./criteria"

export class Judge {
  constructor(private provider: JudgeProvider) {}

  async evaluate(
    trace: ExecutionTrace,
    scenario: Scenario,
    soulMd: string,
  ): Promise<JudgeScore> {
    const prompt = buildJudgePrompt(trace, scenario, soulMd)

    let raw: string
    try {
      raw = await this.provider.complete(prompt)
    } catch (err) {
      // Return a failing score if the judge itself errors
      return {
        judgeModel: this.provider.model,
        scores: {},
        reasoning: {},
        overallScore: 0,
        verdict: "fail",
        confidence: 0,
        suggestions: [`Judge error: ${err instanceof Error ? err.message : String(err)}`],
        raw: `ERROR: ${err}`,
      }
    }

    const parsed = parseJudgeResponse(raw, this.provider.model, scenario.successCriteria)

    return {
      judgeModel: this.provider.model,
      scores: parsed.scores,
      reasoning: parsed.reasoning,
      overallScore: parsed.overallScore,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      suggestions: parsed.suggestions,
      raw,
    }
  }
}
