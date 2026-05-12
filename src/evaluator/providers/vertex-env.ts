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
