import type { JudgeProvider, JudgeProviderConfig } from "../../types"
import { ClaudeJudgeProvider } from "./claude"
import { GeminiJudgeProvider } from "./gemini"
import { OpenAIJudgeProvider } from "./openai"

export function createJudgeProvider(config: JudgeProviderConfig): JudgeProvider {
  switch (config.type) {
    case "claude":
      // Claude and Gemini providers accept `undefined` for apiKey and fall
      // back to Vertex AI mode (ADC/WIF) when the right env is set. The
      // provider constructor itself throws if neither path is available.
      return new ClaudeJudgeProvider(config.apiKey, config.model)
    case "gemini":
      return new GeminiJudgeProvider(config.apiKey, config.model)
    case "openai":
      // OpenAI has no Vertex equivalent — apiKey is required.
      if (!config.apiKey) {
        throw new Error("OpenAI judge requires an apiKey (OPENAI_API_KEY). OpenAI is not available via Vertex AI.")
      }
      return new OpenAIJudgeProvider(config.apiKey, config.model)
    default:
      throw new Error(`Unknown judge provider type: ${(config as any).type}`)
  }
}
