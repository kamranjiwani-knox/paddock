/**
 * Shared Vertex AI mode detection for Claude and Gemini judges.
 *
 * Returns `{ projectId, region }` when Vertex env is set, or `null` for
 * direct-API mode. Both `ClaudeJudgeProvider` and `GeminiJudgeProvider`
 * call this so detection logic lives in one place.
 *
 * Two env-var pairs are accepted, in priority order:
 *
 *   1. `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`
 *      Google's canonical names, read natively by `@google/genai`. Preferred
 *      for new / public deployments because they're provider-agnostic and
 *      self-documenting (any GCP SDK would read the same pair).
 *
 *   2. `ANTHROPIC_VERTEX_PROJECT_ID` + `CLOUD_ML_REGION`
 *      Names the `@anthropic-ai/vertex-sdk` reads natively. Kept as a
 *      fallback so existing Knox env blocks (CMX, knoxai-agent) keep
 *      working without modification.
 *
 * Returning a normalized `{ projectId, region }` (rather than two
 * different shapes) lets the judge classes pass directly to either SDK
 * constructor — `AnthropicVertex({ projectId, region })` for Claude and
 * `GoogleGenAI({ vertexai: true, project, location })` for Gemini.
 */
export function detectVertexMode(): { projectId: string; region: string } | null {
  const genericProject = process.env.GOOGLE_CLOUD_PROJECT
  const genericLocation = process.env.GOOGLE_CLOUD_LOCATION
  if (genericProject && genericLocation) {
    return { projectId: genericProject, region: genericLocation }
  }
  const legacyProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID
  const legacyRegion = process.env.CLOUD_ML_REGION
  if (legacyProject && legacyRegion) {
    return { projectId: legacyProject, region: legacyRegion }
  }
  return null
}
