import type { JudgeProvider, JudgeProviderConfig } from "../../types"
import { ClaudeJudgeProvider } from "./claude"
import { GeminiJudgeProvider } from "./gemini"
import { OpenAIJudgeProvider } from "./openai"

export function createJudgeProvider(config: JudgeProviderConfig): JudgeProvider {
  switch (config.type) {
    case "claude":
      return new ClaudeJudgeProvider(config.apiKey, config.model)
    case "gemini":
      return new GeminiJudgeProvider(config.apiKey, config.model)
    case "openai":
      return new OpenAIJudgeProvider(config.apiKey, config.model)
    default:
      throw new Error(`Unknown judge provider type: ${(config as any).type}`)
  }
}
