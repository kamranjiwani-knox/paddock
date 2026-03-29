import type { Scenario, ExecutionTrace, EvalDimension } from "../types"

export function buildJudgePrompt(
  trace: ExecutionTrace,
  scenario: Scenario,
  soulMd: string,
): string {
  const formattedMessages = scenario.messages
    .map((m, i) => `  ${i + 1}. [${m.from}]: "${m.text}"`)
    .join("\n")

  const formattedResponses = trace.responses.length > 0
    ? trace.responses.map((r, i) => `  ${i + 1}. "${r.text.slice(0, 500)}${r.text.length > 500 ? "..." : ""}"`).join("\n")
    : "  (no responses captured)"

  const formattedToolCalls = trace.toolCalls.length > 0
    ? trace.toolCalls.map(tc => {
        const params = JSON.stringify(tc.params ?? {}).slice(0, 200)
        const result = tc.error
          ? `ERROR: ${tc.error}`
          : JSON.stringify(tc.result ?? "").slice(0, 200)
        return `  - ${tc.name}(${params}) → ${result} [${tc.durationMs}ms]`
      }).join("\n")
    : "  (no tool calls)"

  const formattedErrors = trace.errors.length > 0
    ? trace.errors.map(e => `  - [${e.phase}] ${e.message}`).join("\n")
    : "  (no errors)"

  const formattedCriteria = scenario.successCriteria
    .map(c => `  - ${c.dimension} (weight: ${c.weight}): ${c.description}`)
    .join("\n")

  return `You are evaluating an AI agent's performance on a test scenario.
Be strict but fair. Score based on observable behavior, not assumptions.
Only score dimensions that have criteria defined. Skip others.

## Scenario
Name: ${scenario.name}
Category: ${scenario.category}
Difficulty: ${scenario.difficulty}
Description: ${scenario.description}
Expected behavior: ${scenario.expectedBehavior}

## Agent's Personality (SOUL.md)
${soulMd || "(not provided)"}

## Execution Trace

### User Messages Sent:
${formattedMessages}

### Agent Responses:
${formattedResponses}

### Tool Calls Made:
${formattedToolCalls}

### Errors Encountered:
${formattedErrors}

### Timing:
Total: ${trace.timing.totalMs}ms

## Success Criteria
${formattedCriteria}

## Instructions
Score EACH dimension listed in success criteria from 0 to 10:
- 0-2: Critical failure
- 3-4: Major issues
- 5-6: Partial success with notable problems
- 7-8: Good with minor issues
- 9-10: Excellent

Output EXACTLY this format (no other text before or after):

SCORE[correctness]: <0-10>
REASONING[correctness]: <1-2 sentences>
SCORE[tool_usage]: <0-10>
REASONING[tool_usage]: <1-2 sentences>
SCORE[soul_compliance]: <0-10>
REASONING[soul_compliance]: <1-2 sentences>
SCORE[response_quality]: <0-10>
REASONING[response_quality]: <1-2 sentences>
SCORE[error_handling]: <0-10>
REASONING[error_handling]: <1-2 sentences>
VERDICT: <pass|fail|partial>
CONFIDENCE: <0.0-1.0>
SUGGESTIONS:
- <suggestion 1>
- <suggestion 2>
- <suggestion 3>`
}

const DIMENSIONS: EvalDimension[] = [
  "correctness", "tool_usage", "soul_compliance", "response_quality", "error_handling"
]

export function parseJudgeResponse(
  raw: string,
  model: string,
  criteria: { dimension: EvalDimension; weight: number }[],
): {
  scores: Partial<Record<EvalDimension, number>>
  reasoning: Partial<Record<EvalDimension, string>>
  overallScore: number
  verdict: "pass" | "fail" | "partial"
  confidence: number
  suggestions: string[]
} {
  const scores: Partial<Record<EvalDimension, number>> = {}
  const reasoning: Partial<Record<EvalDimension, string>> = {}

  for (const dim of DIMENSIONS) {
    const scoreMatch = raw.match(new RegExp(`SCORE\\[${dim}\\]:\\s*(\\d+(?:\\.\\d+)?)`))
    if (scoreMatch) {
      scores[dim] = Math.min(10, Math.max(0, parseFloat(scoreMatch[1])))
    }

    const reasonMatch = raw.match(new RegExp(`REASONING\\[${dim}\\]:\\s*(.+)`))
    if (reasonMatch) {
      reasoning[dim] = reasonMatch[1].trim()
    }
  }

  // Verdict
  const verdictMatch = raw.match(/VERDICT:\s*(pass|fail|partial)/i)
  const verdict = (verdictMatch?.[1]?.toLowerCase() as "pass" | "fail" | "partial") ?? "fail"

  // Confidence
  const confMatch = raw.match(/CONFIDENCE:\s*([\d.]+)/)
  const confidence = confMatch ? Math.min(1, Math.max(0, parseFloat(confMatch[1]))) : 0.5

  // Suggestions
  const suggestions: string[] = []
  const suggestionsSection = raw.match(/SUGGESTIONS:\n([\s\S]*?)$/m)
  if (suggestionsSection) {
    const lines = suggestionsSection[1].split("\n")
    for (const line of lines) {
      const trimmed = line.replace(/^[\s-]+/, "").trim()
      if (trimmed && !trimmed.startsWith("SCORE") && !trimmed.startsWith("REASONING")) {
        suggestions.push(trimmed)
      }
    }
  }

  // Calculate weighted overall score
  let totalWeight = 0
  let weightedSum = 0
  for (const c of criteria) {
    const score = scores[c.dimension]
    if (score !== undefined) {
      weightedSum += score * c.weight
      totalWeight += c.weight
    }
  }
  const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0

  return { scores, reasoning, overallScore, verdict, confidence, suggestions }
}
