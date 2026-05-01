import type { TokenUsage } from "../types"

export interface FormattedUsage {
  provider: string
  /** un-cached input */
  input: string
  /** "cache_read / cache_write" or "—" when both are zero */
  cache: string
  /** "visible / thinking" or just visible when no thinking surfaced */
  output: string
  total: string
}

export function formatTokenUsage(usage: Record<string, TokenUsage>): { lines: FormattedUsage[]; grandTotal?: FormattedUsage } {
  const entries = Object.entries(usage)
  if (entries.length === 0) return { lines: [] }

  const fmt = (n: number) => n.toLocaleString()
  const cacheCell = (u: TokenUsage) => {
    const r = u.cacheReadTokens ?? 0
    const w = u.cacheCreationTokens ?? 0
    if (r === 0 && w === 0) return "—"
    return `${fmt(r)} / ${fmt(w)}`
  }
  const outputCell = (u: TokenUsage) => {
    const t = u.thinkingTokens ?? 0
    return t === 0 ? fmt(u.outputTokens) : `${fmt(u.outputTokens)} / ${fmt(t)}`
  }

  const lines = entries.map(([provider, u]) => ({
    provider,
    input: fmt(u.inputTokens),
    cache: cacheCell(u),
    output: outputCell(u),
    total: fmt(u.totalTokens),
  }))

  if (entries.length <= 1) return { lines }

  // Grand totals: accumulate every bucket so the printed total reconciles
  // with the per-row totals (which are sum-of-5-buckets, post-breakdown).
  let gIn = 0, gCacheR = 0, gCacheW = 0, gOut = 0, gThink = 0, gTotal = 0
  for (const [, u] of entries) {
    gIn += u.inputTokens
    gCacheR += u.cacheReadTokens ?? 0
    gCacheW += u.cacheCreationTokens ?? 0
    gOut += u.outputTokens
    gThink += u.thinkingTokens ?? 0
    gTotal += u.totalTokens
  }
  const grandCache = (gCacheR === 0 && gCacheW === 0) ? "—" : `${fmt(gCacheR)} / ${fmt(gCacheW)}`
  const grandOutput = gThink === 0 ? fmt(gOut) : `${fmt(gOut)} / ${fmt(gThink)}`

  return {
    lines,
    grandTotal: {
      provider: "total",
      input: fmt(gIn),
      cache: grandCache,
      output: grandOutput,
      total: fmt(gTotal),
    },
  }
}
