import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"
// Simple glob matching for file path allowlist/blocklist
function matchGlob(path: string, pattern: string): boolean {
  // Convert glob to regex
  const regex = new RegExp(
    "^" +
    pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "{{GLOBSTAR}}")
      .replace(/\*/g, "[^/]*")
      .replace(/\{\{GLOBSTAR\}\}/g, ".*")
    + "$"
  )
  return regex.test(path)
}
import type { JudgeProvider, FailurePattern, ImprovementPlan, Patch } from "../types"

const FILE_ALLOWLIST = [
  ".agent/SOUL.md",
  ".agent/skills/**/*.md",
  ".agent/agent.config.json",
  "src/slices/**/*.ts",
]

const FILE_BLOCKLIST = [
  ".env*",
  "package.json",
  "bun.lock*",
  "node_modules/**",
  "eval/**",
  ".git/**",
  "Dockerfile*",
  "docker-compose*",
]

const MAX_LINES_PER_PATCH = 200
const MAX_LINES_PER_PLAN = 500

export class Patcher {
  private provider: JudgeProvider
  private repoRoot: string
  private snapshots = new Map<string, string>()

  constructor(opts: { provider: JudgeProvider; repoRoot: string }) {
    this.provider = opts.provider
    this.repoRoot = opts.repoRoot
  }

  async generatePlan(
    failures: FailurePattern[],
    soulMd: string,
  ): Promise<ImprovementPlan> {
    // Read relevant files based on failure types
    const filesToRead: string[] = [".agent/SOUL.md"]

    for (const f of failures) {
      if (f.dimension === "soul_compliance") {
        filesToRead.push(".agent/SOUL.md")
      }
      if (f.dimension === "tool_usage" || f.dimension === "correctness") {
        // Read a few key runtime files
        filesToRead.push("src/slices/agent/core/domain/agent.service.ts")
      }
    }

    const uniqueFiles = [...new Set(filesToRead)]
    const fileContents: string[] = []

    for (const f of uniqueFiles) {
      const fullPath = join(this.repoRoot, f)
      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath, "utf-8")
          fileContents.push(`### ${f}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``)
        } catch {
          // skip unreadable
        }
      }
    }

    const formattedFailures = failures
      .map((f, i) => `${i + 1}. **${f.dimension}** — frequency: ${f.frequency}, severity: ${f.severity.toFixed(1)}\n   Scenarios: ${f.exampleScenarios.join(", ")}\n   Suggestions:\n${f.suggestedFix.split("\n").map(s => `   - ${s}`).join("\n")}`)
      .join("\n\n")

    const prompt = `You are improving an AI agent's codebase based on evaluation failures.

## Failure Patterns (ordered by severity)
${formattedFailures}

## Current SOUL.md
${soulMd}

## Relevant Source Files
${fileContents.join("\n\n")}

## Constraints
- You can ONLY modify files matching: ${FILE_ALLOWLIST.join(", ")}
- Maximum ${MAX_LINES_PER_PATCH} lines changed per file
- Maximum ${MAX_LINES_PER_PLAN} lines total
- Changes must preserve TypeScript correctness
- Do NOT add new dependencies
- Prefer minimal, targeted changes

## Task
Propose specific code changes to address the top failure patterns.
Focus on the highest-severity issues first.
For SOUL.md changes, add rules or adjust personality to address failures.
For code changes, fix the specific behavior that caused failures.

Output ONLY valid JSON (no markdown fences, no explanation):
{
  "patches": [
    {
      "filePath": "relative/path/to/file",
      "operation": "modify",
      "content": "full new file content here",
      "description": "what this change does",
      "rationale": "why this fixes the failure"
    }
  ],
  "estimatedImpact": "which failures this should fix",
  "riskLevel": "low"
}`

    const raw = await this.provider.complete(prompt)

    // Parse JSON from response
    let parsed: { patches: Patch[]; estimatedImpact: string; riskLevel: string }
    try {
      // Try to extract JSON from response (may have markdown fences)
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error("No JSON found in response")
      parsed = JSON.parse(jsonMatch[0])
    } catch (err) {
      console.error("[patcher] Failed to parse LLM response:", raw.slice(0, 500))
      return {
        id: crypto.randomUUID(),
        targetFailures: failures.map(f => f.dimension),
        patches: [],
        estimatedImpact: "Failed to generate patches",
        riskLevel: "high",
      }
    }

    // Validate patches
    const validPatches = parsed.patches.filter(p => this.isAllowed(p.filePath))

    // Enforce line limits
    const truncatedPatches = validPatches.map(p => {
      const lines = p.content.split("\n")
      if (lines.length > MAX_LINES_PER_PATCH) {
        console.warn(`[patcher] Truncating patch for ${p.filePath}: ${lines.length} > ${MAX_LINES_PER_PATCH} lines`)
        return { ...p, content: lines.slice(0, MAX_LINES_PER_PATCH).join("\n") }
      }
      return p
    })

    return {
      id: crypto.randomUUID(),
      targetFailures: failures.map(f => f.dimension),
      patches: truncatedPatches,
      estimatedImpact: parsed.estimatedImpact ?? "",
      riskLevel: (parsed.riskLevel as "low" | "medium" | "high") ?? "medium",
    }
  }

  async applyPlan(plan: ImprovementPlan): Promise<void> {
    for (const patch of plan.patches) {
      if (!this.isAllowed(patch.filePath)) {
        console.warn(`[patcher] Skipping blocked file: ${patch.filePath}`)
        continue
      }

      const fullPath = join(this.repoRoot, patch.filePath)

      // Snapshot before modification
      if (existsSync(fullPath)) {
        this.snapshots.set(patch.filePath, readFileSync(fullPath, "utf-8"))
      } else {
        this.snapshots.set(patch.filePath, "")
      }

      // Apply patch
      switch (patch.operation) {
        case "modify":
        case "create":
          mkdirSync(dirname(fullPath), { recursive: true })
          writeFileSync(fullPath, patch.content, "utf-8")
          console.log(`[patcher] ${patch.operation}: ${patch.filePath} — ${patch.description}`)
          break
        case "append":
          const existing = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : ""
          writeFileSync(fullPath, existing + "\n" + patch.content, "utf-8")
          console.log(`[patcher] append: ${patch.filePath} — ${patch.description}`)
          break
      }
    }
  }

  async revertPlan(plan: ImprovementPlan): Promise<void> {
    for (const patch of plan.patches) {
      const snapshot = this.snapshots.get(patch.filePath)
      if (snapshot === undefined) continue

      const fullPath = join(this.repoRoot, patch.filePath)
      if (snapshot === "") {
        // File didn't exist before — remove it
        try {
          const { unlinkSync } = await import("fs")
          unlinkSync(fullPath)
        } catch {}
      } else {
        writeFileSync(fullPath, snapshot, "utf-8")
      }
      console.log(`[patcher] reverted: ${patch.filePath}`)
    }
    this.snapshots.clear()
  }

  private isAllowed(filePath: string): boolean {
    // Check blocklist first
    for (const pattern of FILE_BLOCKLIST) {
      if (matchGlob(filePath, pattern)) return false
    }
    // Check allowlist
    for (const pattern of FILE_ALLOWLIST) {
      if (matchGlob(filePath, pattern)) return true
    }
    return false
  }
}
