import type { Scenario, ExecutionTrace } from "../types"

/**
 * Runs scenarios against an agent and produces execution traces.
 *
 * Implementations:
 * - FilesystemAgentRunner: boots the agent runtime in-process by importing
 *   from a local repo path (used by paddock CLI/MCP standalone).
 * - HttpAgentRunner: talks to a running agent over HTTP (used by ranch).
 */
export interface IAgentRunner {
  runScenario(scenario: Scenario): Promise<ExecutionTrace>
  runSuite(scenarios: Scenario[]): Promise<ExecutionTrace[]>
}
