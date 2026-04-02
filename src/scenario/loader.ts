import { readdirSync, readFileSync, existsSync, cpSync } from "fs"
import { join, resolve, extname } from "path"
import type { Scenario, ScenarioCategory } from "../types"

const PADDOCK_DIR = ".paddock"
const EXAMPLE_DIR = ".paddock.example"

/**
 * Parse a simple YAML scenario file.
 * Supports the subset of YAML used in scenario files (no anchors, no complex nesting).
 */
function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = content.split("\n")
  let currentKey = ""
  let currentArray: unknown[] | null = null
  let currentArrayItemObj: Record<string, unknown> | null = null
  let currentNestedObj: Record<string, unknown> | null = null
  let currentNestedKey = ""

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimEnd()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue

    // Nested object property (2-space indent): "  key: value" under a top-level key
    const nestedMatch = trimmed.match(/^(\s{2,4})(\S[\w.\-]*):\s*(.*)$/)
    if (nestedMatch && currentNestedObj && !currentArray) {
      const [, , key, value] = nestedMatch
      currentNestedObj[key] = parseValue(value)
      currentArrayItemObj = null
      continue
    }

    // Array item with object properties: "  - key: value"
    const arrayItemMatch = trimmed.match(/^(\s+)-\s+(\w+):\s*(.*)$/)
    if (arrayItemMatch && currentArray) {
      const [, , key, value] = arrayItemMatch
      currentArrayItemObj = { [key]: parseValue(value) }
      currentArray.push(currentArrayItemObj)
      currentNestedObj = null
      continue
    }

    // Array item continuation: "    key: value" (indented more than the dash)
    const continuationMatch = trimmed.match(/^\s{4,}(\w+):\s*(.*)$/)
    if (continuationMatch && currentArrayItemObj) {
      const [, key, value] = continuationMatch
      currentArrayItemObj[key] = parseValue(value)
      continue
    }

    // Simple array item: "  - value"
    const simpleArrayMatch = trimmed.match(/^(\s+)-\s+(.+)$/)
    if (simpleArrayMatch && currentArray) {
      currentArrayItemObj = null
      currentArray.push(parseValue(simpleArrayMatch[2]))
      continue
    }

    // Top-level key: value
    const keyValueMatch = trimmed.match(/^(\w+):\s*(.*)$/)
    if (keyValueMatch) {
      const [, key, value] = keyValueMatch
      currentArrayItemObj = null
      currentNestedObj = null

      if (value === "" || value === undefined) {
        // Could be start of array or nested object — peek next line
        const nextLine = lines[i + 1]
        if (nextLine && nextLine.match(/^\s+-/)) {
          currentArray = []
          result[key] = currentArray
          currentKey = key
        } else if (nextLine && nextLine.match(/^\s{2,4}\S/)) {
          // Nested object (indented key-value pairs)
          currentNestedObj = {}
          result[key] = currentNestedObj
          currentNestedKey = key
          currentArray = null
        } else {
          result[key] = ""
          currentArray = null
        }
      } else {
        result[key] = parseValue(value)
        currentArray = null
        currentKey = key
      }
      continue
    }
  }

  // Special handling for 'setup' block with nested files/env/tools
  // The generic parser can't handle 3-level nesting, so parse it manually
  const setupIdx = lines.findIndex(l => /^setup:\s*$/.test(l.trimEnd()))
  if (setupIdx >= 0) {
    const setup: Record<string, Record<string, string> | string[]> = {}
    let currentSection: Record<string, string> | string[] | null = null
    let sectionKey = ""

    for (let j = setupIdx + 1; j < lines.length; j++) {
      const sl = lines[j]
      // Stop at next top-level key (no indent)
      if (sl.match(/^\S/) && sl.trim()) break
      // 2-space indent: section header (files:, env:, tools:)
      const sectionMatch = sl.match(/^\s{2}(\w+):\s*$/)
      if (sectionMatch) {
        sectionKey = sectionMatch[1]
        if (sectionKey === "tools") {
          currentSection = []
          setup[sectionKey] = currentSection
        } else {
          currentSection = {}
          setup[sectionKey] = currentSection
        }
        continue
      }
      // 4-space indent: key-value pair or array item
      if (currentSection) {
        const kvMatch = sl.match(/^\s{4,}(\S[\w.\-]*):\s*(.+)$/)
        if (kvMatch && !Array.isArray(currentSection)) {
          currentSection[kvMatch[1]] = String(parseValue(kvMatch[2]))
          continue
        }
        const arrMatch = sl.match(/^\s{4,}-\s+(.+)$/)
        if (arrMatch && Array.isArray(currentSection)) {
          currentSection.push(String(parseValue(arrMatch[1])))
          continue
        }
      }
    }

    if (Object.keys(setup).length > 0) {
      result.setup = setup
    }
  }

  return result
}

function parseValue(value: string): string | number | boolean {
  const trimmed = value.trim()

  // Remove surrounding quotes
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }

  // Boolean
  if (trimmed === "true") return true
  if (trimmed === "false") return false

  // Number
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed)

  return trimmed
}

/**
 * Parse setup block from YAML data.
 * Supports: setup.files (Record<string,string>), setup.env (Record<string,string>), setup.tools (string[])
 */
function parseSetup(raw: Record<string, unknown>): Scenario["setup"] {
  const setup: NonNullable<Scenario["setup"]> = {}
  if (raw.files && typeof raw.files === "object") {
    const files: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.files as Record<string, unknown>)) {
      files[k] = String(v)
    }
    setup.files = files
  }
  if (raw.env && typeof raw.env === "object") {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      env[k] = String(v)
    }
    setup.env = env
  }
  if (Array.isArray(raw.tools)) {
    setup.tools = raw.tools.map(String)
  }
  return Object.keys(setup).length > 0 ? setup : undefined
}

/**
 * Load a single scenario from a YAML file.
 */
function loadScenarioFile(filePath: string): Scenario | null {
  try {
    const content = readFileSync(filePath, "utf-8")
    const data = parseYaml(content)

    if (!data.id || !data.messages) return null

    return {
      id: String(data.id),
      category: String(data.category ?? "conversation") as ScenarioCategory,
      difficulty: String(data.difficulty ?? "medium") as Scenario["difficulty"],
      name: String(data.name ?? data.id),
      description: String(data.description ?? ""),
      expectedBehavior: String(data.expectedBehavior ?? ""),
      messages: (data.messages as Array<Record<string, unknown>>).map(m => ({
        text: String(m.text ?? ""),
        from: String(m.from ?? "eval-user"),
        delayMs: m.delayMs ? Number(m.delayMs) : undefined,
      })),
      successCriteria: ((data.successCriteria ?? []) as Array<Record<string, unknown>>).map(c => ({
        dimension: String(c.dimension ?? "correctness") as Scenario["successCriteria"][0]["dimension"],
        description: String(c.description ?? ""),
        weight: Number(c.weight ?? 0.5),
      })),
      setup: data.setup ? parseSetup(data.setup as Record<string, unknown>) : undefined,
    }
  } catch (err) {
    console.warn(`[loader] Failed to load scenario ${filePath}: ${err}`)
    return null
  }
}

/**
 * Recursively find all .yml files in a directory.
 */
function findYmlFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findYmlFiles(fullPath))
    } else if (extname(entry.name) === ".yml" || extname(entry.name) === ".yaml") {
      files.push(fullPath)
    }
  }

  return files
}

/**
 * Resolve the .paddock directory for a given repo.
 *
 * Priority:
 * 1. {repoRoot}/.paddock/scenarios/  — project-specific scenarios
 * 2. {paddockRoot}/.paddock.example/scenarios/  — default examples
 *
 * If .paddock doesn't exist in the repo, copies .paddock.example there.
 */
export function resolvePaddockDir(repoRoot: string): string {
  const projectDir = join(repoRoot, PADDOCK_DIR, "scenarios")
  const paddockRoot = resolve(import.meta.dir, "../..")
  const exampleDir = join(paddockRoot, EXAMPLE_DIR, "scenarios")

  if (existsSync(projectDir)) {
    return projectDir
  }

  // Copy example to project
  const projectPaddock = join(repoRoot, PADDOCK_DIR)
  const examplePaddock = join(paddockRoot, EXAMPLE_DIR)

  if (existsSync(examplePaddock)) {
    console.log(`[loader] No .paddock/ found in ${repoRoot}, copying from .paddock.example/`)
    cpSync(examplePaddock, projectPaddock, { recursive: true })
    return join(projectPaddock, "scenarios")
  }

  return exampleDir
}

/**
 * Load all scenarios from the .paddock directory.
 * Falls back to .paddock.example if no project-specific config exists.
 */
export function loadScenarios(repoRoot: string): Scenario[] {
  const scenariosDir = resolvePaddockDir(repoRoot)

  if (!existsSync(scenariosDir)) {
    console.warn(`[loader] No scenarios directory found at ${scenariosDir}`)
    return []
  }

  const files = findYmlFiles(scenariosDir)
  console.log(`[loader] Found ${files.length} scenario files in ${scenariosDir}`)

  const scenarios: Scenario[] = []
  for (const file of files) {
    const scenario = loadScenarioFile(file)
    if (scenario) {
      scenarios.push(scenario)
    }
  }

  console.log(`[loader] Loaded ${scenarios.length} scenarios`)
  return scenarios
}

/**
 * Load .paddock/config.json if it exists.
 */
export function loadPaddockConfig(repoRoot: string): Record<string, unknown> {
  const configPath = join(repoRoot, PADDOCK_DIR, "config.json")
  if (!existsSync(configPath)) return {}

  try {
    return JSON.parse(readFileSync(configPath, "utf-8"))
  } catch {
    return {}
  }
}
