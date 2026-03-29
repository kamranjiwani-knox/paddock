import type {
  JudgeProvider,
  Scenario,
  ScenarioCategory,
  Difficulty,
} from "../types"

const ALL_CATEGORIES: ScenarioCategory[] = [
  "tool_use", "memory", "conversation", "patching_workflow",
  "edge_case", "multi_turn", "error_recovery",
]

const ALL_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard", "adversarial"]

export class ScenarioGenerator {
  private provider: JudgeProvider
  private soulMd: string
  private toolNames: string[]
  private skills: string[]

  constructor(opts: {
    provider: JudgeProvider
    soulMd: string
    toolNames: string[]
    skills: string[]
  }) {
    this.provider = opts.provider
    this.soulMd = opts.soulMd
    this.toolNames = opts.toolNames
    this.skills = opts.skills
  }

  async generate(opts: {
    category: ScenarioCategory
    difficulty: Difficulty
    count: number
  }): Promise<Scenario[]> {
    const prompt = `You are generating test scenarios for an AI agent.

## Agent Personality (SOUL.md)
${this.soulMd || "(not provided)"}

## Available Tools
${this.toolNames.length > 0 ? this.toolNames.join(", ") : "(standard set: web_search, web_fetch, file, http, browser, memory_search, cron, etc.)"}

## Loaded Skills
${this.skills.length > 0 ? this.skills.join(", ") : "(none)"}

## Task
Generate ${opts.count} test scenarios for category "${opts.category}" at difficulty "${opts.difficulty}".

Each scenario must include:
- id: unique kebab-case identifier (prefix with "gen-")
- category: "${opts.category}"
- difficulty: "${opts.difficulty}"
- name: short descriptive name
- description: what this scenario tests
- messages: array of { "text": "user message", "from": "eval-user" } objects
- expectedBehavior: what the agent SHOULD do
- successCriteria: array of { "dimension": "correctness|tool_usage|soul_compliance|response_quality|error_handling", "description": "...", "weight": 0.0-1.0 } (weights must sum to 1.0)

## Difficulty Guidelines
- easy: straightforward requests, single tool, clear intent
- medium: multi-step, requires reasoning or multi-tool use
- hard: edge cases, ambiguous requests, requires creativity
- adversarial: injection attempts, conflicting instructions, stress tests

## Language
Generate all content in English — messages, descriptions, and criteria.

## Output
Return ONLY a valid JSON array of scenario objects. No markdown fences, no explanation.`

    const raw = await this.provider.complete(prompt)

    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/)
      if (!jsonMatch) throw new Error("No JSON array found")
      const parsed = JSON.parse(jsonMatch[0]) as Scenario[]
      return parsed.filter(s => s.id && s.messages?.length > 0)
    } catch (err) {
      console.warn(`[generator] Failed to parse LLM scenarios: ${err}`)
      return []
    }
  }

  async generateSuite(opts: {
    categories?: ScenarioCategory[]
    difficulties?: Difficulty[]
    count?: number
  }): Promise<Scenario[]> {
    const categories = opts.categories ?? ALL_CATEGORIES
    const difficulties = opts.difficulties ?? ALL_DIFFICULTIES
    const totalCount = opts.count ?? 10

    // Distribute count across categories
    const perCategory = Math.max(1, Math.ceil(totalCount / categories.length))
    const scenarios: Scenario[] = []

    for (const category of categories) {
      if (scenarios.length >= totalCount) break

      // Pick a random difficulty for variety
      const difficulty = difficulties[Math.floor(Math.random() * difficulties.length)]
      const remaining = totalCount - scenarios.length
      const count = Math.min(perCategory, remaining)

      try {
        const generated = await this.generate({ category, difficulty, count })
        scenarios.push(...generated)
      } catch (err) {
        console.warn(`[generator] Failed to generate for ${category}/${difficulty}: ${err}`)
      }
    }

    return scenarios.slice(0, totalCount)
  }
}
