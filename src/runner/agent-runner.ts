import { existsSync, mkdirSync, cpSync, rmSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { MockChannel } from "./mock-channel"
import type {
  Scenario,
  ExecutionTrace,
  TracedToolCall,
  TracedError,
  TracedResponse,
} from "../types"

interface AgentRunnerConfig {
  /** Path to the agent runtime repo root */
  repoRoot: string
  /** Path to .agent directory (default: repoRoot/.agent) */
  agentDir?: string
  /** Tools to block in eval mode */
  blockedTools?: string[]
  /** Response timeout per message in ms (default: 60000) */
  responseTimeoutMs?: number
  /** Quiet period to detect end of response in ms (default: 5000) */
  quietMs?: number
  /** Max retries per scenario on LLM/runtime errors (default: 2) */
  maxRetries?: number
  /** Base delay between retries in ms (default: 5000) */
  retryDelayMs?: number
  /** Delay between scenarios in ms (default: 2000) */
  scenarioDelayMs?: number
  /** Max concurrent scenarios (default: 1 = sequential) */
  concurrency?: number
}

const DEFAULT_BLOCKED_TOOLS = [
  "exec",
  "process",
  "shutdown",
  "spawn_agent",
  "gcloud_exec",
  "kubectl_exec",
  "telegram_send",
  "tts",
]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Creates a tracing wrapper around a tool that records all calls.
 *
 * Blocked tools return a stub-style informational result instead of an
 * error. The previous error-style return ('blocked in eval mode') was
 * frequently misread by the agent as a real failure (e.g., labeling
 * `auth check: FAILED` when no actual auth check happened). A stub
 * response, framed as informational rather than as a failure, lets the
 * agent reason cleanly: the call didn't happen, no result is available,
 * fall back to task-message values. The `stub: true` flag lets agent
 * code branch on intent if it cares; the message carries the same
 * signal in human-readable form for the LLM context.
 */
function wrapTool(tool: any, blocked: string[]): { wrapped: any; calls: TracedToolCall[] } {
  const calls: TracedToolCall[] = []

  const wrapped = {
    ...tool,
    async execute(params: unknown, ctx: unknown): Promise<unknown> {
      if (blocked.includes(tool.name)) {
        const stubMessage =
          `Tool '${tool.name}' is intercepted in eval mode — no live call was made. ` +
          `No result is available from this invocation. Continue with the values provided ` +
          `in the task message; do not label any subsequent check derived from this tool ` +
          `as FAILED, since no real result exists to fail.`
        const call: TracedToolCall = {
          name: tool.name,
          params,
          result: { stub: true, message: stubMessage },
          durationMs: 0,
          ts: Date.now(),
        }
        calls.push(call)
        return call.result
      }

      const start = Date.now()
      try {
        const result = await tool.execute(params, ctx)
        calls.push({
          name: tool.name,
          params,
          result,
          durationMs: Date.now() - start,
          ts: start,
        })
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        calls.push({
          name: tool.name,
          params,
          result: null,
          durationMs: Date.now() - start,
          ts: start,
          error,
        })
        throw err
      }
    },
  }

  return { wrapped, calls }
}

/**
 * Check if an error is retryable (rate limit, overloaded, transient).
 */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (status === 429 || status === 529 || status === 500 || status === 502 || status === 503) return true
  const msg = String((err as { message?: string })?.message ?? err)
  if (msg.includes("overloaded") || msg.includes("rate") || msg.includes("timeout")) return true
  // 400 with generic "Error" message — often transient OAuth issue
  if (status === 400 && msg.includes('"message":"Error"')) return true
  return false
}

export class AgentRunner {
  private config: Required<AgentRunnerConfig>

  constructor(config: AgentRunnerConfig) {
    this.config = {
      repoRoot: resolve(config.repoRoot),
      agentDir: config.agentDir ?? join(config.repoRoot, ".agent"),
      blockedTools: config.blockedTools ?? DEFAULT_BLOCKED_TOOLS,
      responseTimeoutMs: config.responseTimeoutMs ?? 180_000,
      quietMs: config.quietMs ?? 15_000,
      maxRetries: config.maxRetries ?? 2,
      retryDelayMs: config.retryDelayMs ?? 5_000,
      scenarioDelayMs: config.scenarioDelayMs ?? 2_000,
      concurrency: config.concurrency ?? 1,
    }
  }

  async runScenario(scenario: Scenario): Promise<ExecutionTrace> {
    let lastTrace: ExecutionTrace | null = null

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1)
        console.log(`[paddock] retry ${attempt}/${this.config.maxRetries} for ${scenario.id} after ${delay}ms`)
        await sleep(delay)
      }

      const trace = await this.runScenarioOnce(scenario)
      lastTrace = trace

      // Check if we got a retryable error
      const hasRetryableError = trace.errors.some(e =>
        e.phase === "runtime" && isRetryable({ status: 400, message: e.message })
      )

      // If we got responses or no retryable errors, accept the result
      if (trace.responses.length > 0 || !hasRetryableError) {
        return trace
      }

      console.warn(`[paddock] scenario ${scenario.id} failed with retryable error: ${trace.errors[0]?.message?.slice(0, 100)}`)
    }

    return lastTrace!
  }

  private async runScenarioOnce(scenario: Scenario): Promise<ExecutionTrace> {
    const startedAt = Date.now()
    const errors: TracedError[] = []
    const responses: TracedResponse[] = []

    const tempDir = join("/tmp", `paddock-agent-${Date.now()}-${scenario.id}`)
    mkdirSync(tempDir, { recursive: true })

    // Catch unhandled rejections from fire-and-forget tasks inside the runtime
    const caughtRejections: Error[] = []
    const rejectionHandler = (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      console.warn(`[paddock] caught unhandled rejection: ${error.message.slice(0, 150)}`)
      caughtRejections.push(error)
    }
    process.on("unhandledRejection", rejectionHandler)

    try {
      // Copy .agent to temp and ensure required subdirs exist
      cpSync(this.config.agentDir, tempDir, { recursive: true })
      for (const sub of ["data", "data/sessions", "data/secrets", "sessions", "memory", "skills", "workspace"]) {
        mkdirSync(join(tempDir, sub), { recursive: true })
      }

      // Apply scenario setup files (before access override so they can set config)
      if (scenario.setup?.files) {
        for (const [path, content] of Object.entries(scenario.setup.files)) {
          const fullPath = join(tempDir, path)
          const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
          mkdirSync(dir, { recursive: true })
          Bun.write(fullPath, content)
        }
      }

      // Force open access for eval user (always last — overrides any setup config)
      const configPath = join(tempDir, "agent.config.json")
      try {
        const agentConfig = existsSync(configPath)
          ? JSON.parse(readFileSync(configPath, "utf-8"))
          : {}
        agentConfig.accessStrategy = "open"
        Bun.write(configPath, JSON.stringify(agentConfig, null, 2))
      } catch {
        Bun.write(configPath, JSON.stringify({ accessStrategy: "open" }, null, 2))
      }

      // Read SOUL.md and config snapshots
      const soulMdPath = join(tempDir, "SOUL.md")
      const soulMd = existsSync(soulMdPath) ? readFileSync(soulMdPath, "utf-8") : ""
      const configJson = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "{}"

      // Dynamic import of runtime modules — try current paths first, fall back to legacy
      const runtimePath = this.config.repoRoot

      const { AgentRuntime } = await import(join(runtimePath, "src/runtime.ts"))

      let InitModule: any
      try {
        ;({ InitModule } = await import(join(runtimePath, "src/slices/runtime/init/init.module.ts")))
      } catch {
        ;({ InitModule } = await import(join(runtimePath, "src/slices/agent/init/init.module.ts")))
      }

      let ToolGateway: any
      try {
        ;({ ToolGateway } = await import(join(runtimePath, "src/slices/agent/tool/data/tool.gateway.ts")))
      } catch {
        ;({ ToolGateway } = await import(join(runtimePath, "src/slices/setup/tool/data/tool.gateway.ts")))
      }

      // Create mock channel
      const mockChannel = new MockChannel()

      // Set up tools with tracing
      const toolGateway = new ToolGateway()
      const toolNames: string[] = []
      const toolWrappers = (toolGateway.getAll() as Array<{ name: string; description: string; schema: unknown; execute: Function }>).map((tool) => {
        toolNames.push(tool.name)
        return wrapTool(tool, this.config.blockedTools)
      })
      const finalTracedTools = toolWrappers.map((w: { wrapped: unknown }) => w.wrapped)

      // Boot runtime
      const exampleDir = join(runtimePath, ".agent.example")
      const init = new InitModule(tempDir, existsSync(exampleDir) ? exampleDir : tempDir)

      const prevEnv = { ...process.env }
      // Override model for eval — runtime reads CLAUDE_MODEL from env
      process.env.CLAUDE_MODEL = process.env.EVAL_LLM_MODEL ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6"
      if (scenario.setup?.env) {
        Object.assign(process.env, scenario.setup.env)
      }

      const runtime = new AgentRuntime({
        init,
        llm: {
          provider: "claude",
          apiKey: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
          model: process.env.EVAL_LLM_MODEL ?? "claude-sonnet-4-6",
        },
        channels: [{ type: "mock" as const, instance: mockChannel }],
        tools: finalTracedTools,
      })

      await runtime.start()

      // Send scenario messages
      for (const msg of scenario.messages) {
        if (msg.delayMs) await sleep(msg.delayMs)

        try {
          const beforeCount = mockChannel.getSentMessages().length
          await mockChannel.simulateIncoming(msg.text, msg.from || "eval-user")
          // Collect any synchronous responses (e.g. empty message → immediate reply)
          const afterSync = mockChannel.getSentMessages().slice(beforeCount)
          for (const m of afterSync) {
            responses.push({ text: m.text, ts: m.ts })
          }
          // Then wait for async responses (fire-and-forget tasks)
          const agentResponses = await mockChannel.waitForAllResponses(
            this.config.quietMs,
            this.config.responseTimeoutMs
          )
          for (const text of agentResponses) {
            responses.push({ text, ts: Date.now() })
          }
        } catch (err) {
          errors.push({
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            ts: Date.now(),
            phase: "channel",
          })
        }
      }

      // Give fire-and-forget tasks a moment to settle (heartbeat, session writes)
      await sleep(3000)

      // Stop runtime
      try {
        await runtime.stop()
      } catch {
        // ignore stop errors
      }

      // Restore env
      process.env = prevEnv

      // Record any unhandled rejections as errors
      for (const rejection of caughtRejections) {
        errors.push({
          message: rejection.message,
          stack: rejection.stack,
          ts: Date.now(),
          phase: "runtime",
        })
      }

      // Collect all tool calls
      const collectedToolCalls = toolWrappers.flatMap((w: { calls: TracedToolCall[] }) => w.calls)
      const endedAt = Date.now()

      return {
        scenarioId: scenario.id,
        responses,
        toolCalls: collectedToolCalls,
        errors,
        timing: { startedAt, endedAt, totalMs: endedAt - startedAt },
        metadata: {
          agentDir: tempDir,
          soulMd,
          configJson,
          toolNames: [...new Set(toolNames)],
        },
      }
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ts: Date.now(),
        phase: "runtime",
      })

      return {
        scenarioId: scenario.id,
        responses,
        toolCalls: [],
        errors,
        timing: { startedAt, endedAt: Date.now(), totalMs: Date.now() - startedAt },
        metadata: { agentDir: tempDir, soulMd: "", configJson: "{}", toolNames: [] },
      }
    } finally {
      process.removeListener("unhandledRejection", rejectionHandler)
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }

  async runSuite(scenarios: Scenario[]): Promise<ExecutionTrace[]> {
    const concurrency = this.config.concurrency

    if (concurrency <= 1) {
      return this.runSuiteSequential(scenarios)
    }

    console.log(`[paddock] running ${scenarios.length} scenarios with concurrency=${concurrency}`)
    return this.runSuiteParallel(scenarios, concurrency)
  }

  private async runSuiteSequential(scenarios: Scenario[]): Promise<ExecutionTrace[]> {
    const traces: ExecutionTrace[] = []

    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i]

      // Delay between scenarios to avoid rate limiting
      if (i > 0) {
        await sleep(this.config.scenarioDelayMs)
      }

      traces.push(await this.runAndLog(scenario, i + 1, scenarios.length))
    }

    return traces
  }

  private async runSuiteParallel(scenarios: Scenario[], concurrency: number): Promise<ExecutionTrace[]> {
    const traces: ExecutionTrace[] = new Array(scenarios.length)
    let nextIndex = 0

    const worker = async () => {
      while (nextIndex < scenarios.length) {
        const idx = nextIndex++
        const scenario = scenarios[idx]

        // Jitter to stagger starts and avoid thundering herd
        const jitter = Math.random() * this.config.scenarioDelayMs
        await sleep(jitter)

        traces[idx] = await this.runAndLog(scenario, idx + 1, scenarios.length)
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker())
    await Promise.all(workers)

    return traces
  }

  private async runAndLog(scenario: Scenario, num: number, total: number): Promise<ExecutionTrace> {
    console.log(`[paddock] running scenario ${num}/${total}: ${scenario.id} (${scenario.category}/${scenario.difficulty})`)

    try {
      const trace = await this.runScenario(scenario)
      const status = trace.errors.length === 0 ? "OK" : `${trace.errors.length} errors`
      console.log(`[paddock] scenario ${scenario.id}: ${status} | ${trace.responses.length} responses | ${trace.toolCalls.length} tool calls | ${trace.timing.totalMs}ms`)
      for (const err of trace.errors) {
        console.log(`[paddock]   ERROR [${err.phase}]: ${err.message.slice(0, 200)}`)
      }
      return trace
    } catch (err) {
      console.error(`[paddock] scenario ${scenario.id} crashed: ${err}`)
      return {
        scenarioId: scenario.id,
        responses: [],
        toolCalls: [],
        errors: [{
          message: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
          phase: "runtime",
        }],
        timing: { startedAt: Date.now(), endedAt: Date.now(), totalMs: 0 },
        metadata: { agentDir: "", soulMd: "", configJson: "{}", toolNames: [] },
      }
    }
  }
}
