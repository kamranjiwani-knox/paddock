import type {
  ClaudeVertexJudgeConfig,
  GeminiVertexJudgeConfig,
} from "../../types"

/**
 * Shared Vertex AI mode detection for Claude and Gemini judges.
 *
 * Returns `{ projectId, region }` when Vertex env is set, or `null` for
 * direct-API mode. Both `ClaudeJudgeProvider` and `GeminiJudgeProvider`
 * call this so detection logic lives in one place.
 *
 * Activation requires both:
 *   - `VERTEX_PROJECT_ID` — GCP project where the Vertex AI API is enabled
 *   - `VERTEX_REGION` — GCP region, e.g. `us-east5`
 *
 * The env var names are deliberately platform-named (`VERTEX_*`) rather than
 * vendor-named (`GOOGLE_VERTEX_*` / `ANTHROPIC_VERTEX_*`) because Vertex
 * hosts both Claude (via `@anthropic-ai/vertex-sdk`) and Gemini (via
 * `@google/genai`) in this mode — a single platform-named env pair gates
 * both judges symmetrically.
 *
 * Returning a normalized `{ projectId, region }` lets the judge classes
 * pass directly to either SDK constructor —
 * `AnthropicVertex({ projectId, region })` for Claude and
 * `GoogleGenAI({ vertexai: true, project, location })` for Gemini.
 */
export function detectVertexMode(): { projectId: string; region: string } | null {
  const projectId = process.env.VERTEX_PROJECT_ID
  const region = process.env.VERTEX_REGION
  if (projectId && region) return { projectId, region }
  return null
}

type VertexJudgeConfig = ClaudeVertexJudgeConfig | GeminiVertexJudgeConfig

/**
 * Parse the optional `VERTEX_JUDGES` env value into typed Vertex judge
 * configs. The env value is a comma-separated list of model IDs; paddock
 * infers the provider from the model-name prefix:
 *
 *   - `claude-*`  → `claude-vertex` (routes through `@anthropic-ai/vertex-sdk`)
 *   - `gemini-*`  → `gemini-vertex` (routes through `@google/genai`)
 *
 * OpenAI / GPT models are explicitly rejected because OpenAI has no Vertex
 * AI offering. To add an OpenAI judge in Vertex mode, set `OPENAI_API_KEY`
 * separately — the OpenAI judge runs direct alongside the Vertex ones.
 *
 * Whitespace around commas is trimmed; empty entries are filtered.
 * Duplicate model IDs are allowed (the orchestrator's `${name}/${model}`
 * usage key collapses them naturally).
 *
 * Throws a fail-fast Error at config-build time for any unrecognized or
 * disallowed prefix — paddock prefers a clear error at startup to a less
 * obvious failure deep inside an SDK call later.
 */
export function parseVertexJudges(
  raw: string,
  vertex: { projectId: string; region: string },
): VertexJudgeConfig[] {
  const models = raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
  if (models.length === 0) {
    throw new Error("VERTEX_JUDGES is set but contains no valid model IDs after trimming whitespace.")
  }
  return models.map((model): VertexJudgeConfig => {
    if (model.startsWith("claude-")) {
      return {
        type: "claude-vertex",
        model,
        projectId: vertex.projectId,
        region: vertex.region,
      }
    }
    if (model.startsWith("gemini-")) {
      return {
        type: "gemini-vertex",
        model,
        projectId: vertex.projectId,
        region: vertex.region,
      }
    }
    if (/^(gpt|o\d)-/.test(model)) {
      throw new Error(
        `VERTEX_JUDGES contains "${model}" — OpenAI / GPT models are not available on Google Cloud Vertex AI. ` +
          `To add an OpenAI judge alongside the Vertex ones, set OPENAI_API_KEY (the OpenAI judge always runs direct).`,
      )
    }
    throw new Error(
      `VERTEX_JUDGES contains "${model}" — unrecognized model-name prefix. ` +
        `Expected claude-* or gemini-*.`,
    )
  })
}
