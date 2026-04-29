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
    ? trace.responses.map((r, i) => `  ${i + 1}. "${r.text.slice(0, 12000)}${r.text.length > 12000 ? `\n  [... truncated, full length: ${r.text.length} chars]` : ""}"`).join("\n")
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

  const dimensionList = scenario.successCriteria.map(c => `"${c.dimension}"`).join(", ")

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

IMPORTANT — Verdict MUST be consistent with your scores:
- If ALL scored dimensions are >= 8 → "verdict": "pass"
- If ANY scored dimension is < 5 → "verdict": "fail"
- Otherwise (scores between 5-8 with some issues) → "verdict": "partial"
Do NOT say "fail" when all your scores are 8+. Do NOT say "pass" when any score is below 5.
Only override this rule when there is a critical behavioral violation (e.g. zero response, security breach, data leak).

## Output format

Respond with a single JSON object — no prose, no markdown fences, no commentary.

The object must have these top-level keys:

{
  "scores":      <object: dimension name → number 0-10>,
  "reasoning":   <object: dimension name → string, 1-2 sentences>,
  "verdict":     <"pass" | "fail" | "partial">,
  "confidence":  <number 0.0-1.0>,
  "suggestions": <array of 1-3 short improvement strings>
}

The "scores" and "reasoning" objects MUST contain a key for EACH dimension defined in the Success Criteria block above (and only those). Available dimensions for this scenario: ${dimensionList}.

Example for a scenario with criteria [tool_usage, correctness, soul_compliance]:

{
  "scores": { "tool_usage": 9, "correctness": 8, "soul_compliance": 10 },
  "reasoning": {
    "tool_usage": "Agent invoked the required gcloud_exec call and incorporated CVE lookups.",
    "correctness": "Plan covers deploy + verify + rollback with explicit project/region flags.",
    "soul_compliance": "Output is copy-paste ready, no placeholders, no filler phrases."
  },
  "verdict": "pass",
  "confidence": 0.92,
  "suggestions": ["Capture image digest into a shell variable for the rollback step."]
}`
}

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
  // Try JSON first (the supported path for response_format=json_object on
  // OpenAI and responseMimeType=application/json on Gemini, and reliable
  // prompt-driven JSON for Claude). Strip leading/trailing markdown fences
  // some models emit despite instructions.
  const jsonAttempt = tryParseJson(raw)
  if (jsonAttempt) {
    return finalizeFromJson(jsonAttempt, criteria)
  }

  // Fallback: original regex-based text parser. Kept so older judge models
  // that occasionally fall out of JSON mode still produce a usable score.
  return parseTextResponse(raw, criteria)
}

interface JudgeJsonShape {
  scores?: Record<string, unknown>
  reasoning?: Record<string, unknown>
  verdict?: unknown
  confidence?: unknown
  suggestions?: unknown
}

function tryParseJson(raw: string): JudgeJsonShape | null {
  if (!raw || typeof raw !== "string") return null
  let cleaned = raw.trim()
  // Strip ```json ... ``` or ``` ... ``` fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
  }
  // Some models add a preamble like "Here is the evaluation:" — find first {
  const firstBrace = cleaned.indexOf("{")
  const lastBrace = cleaned.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null
  const candidate = cleaned.slice(firstBrace, lastBrace + 1)
  try {
    const obj = JSON.parse(candidate)
    if (obj && typeof obj === "object" && obj.scores && typeof obj.scores === "object") {
      return obj as JudgeJsonShape
    }
  } catch {
    return null
  }
  return null
}

function finalizeFromJson(
  json: JudgeJsonShape,
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

  for (const c of criteria) {
    const s = json.scores?.[c.dimension]
    if (typeof s === "number" && Number.isFinite(s)) {
      scores[c.dimension] = Math.min(10, Math.max(0, s))
    }
    const r = json.reasoning?.[c.dimension]
    if (typeof r === "string") {
      reasoning[c.dimension] = r.trim()
    }
  }

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

  const rawVerdict = typeof json.verdict === "string" ? json.verdict.toLowerCase() : ""
  const verdict: "pass" | "fail" | "partial" =
    rawVerdict === "pass" || rawVerdict === "fail" || rawVerdict === "partial"
      ? rawVerdict
      : "fail"

  const confidence =
    typeof json.confidence === "number" && Number.isFinite(json.confidence)
      ? Math.min(1, Math.max(0, json.confidence))
      : 0.5

  const suggestions: string[] = []
  if (Array.isArray(json.suggestions)) {
    for (const s of json.suggestions) {
      if (typeof s === "string" && s.trim()) suggestions.push(s.trim())
    }
  }

  return { scores, reasoning, overallScore, verdict, confidence, suggestions }
}

const DIMENSIONS: EvalDimension[] = [
  "correctness", "tool_usage", "soul_compliance", "response_quality", "error_handling"
]

function parseTextResponse(
  raw: string,
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
