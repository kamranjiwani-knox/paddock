import type { TokenUsage } from "../types"

export interface FormattedUsage {
  provider: string
  input: string
  output: string
  total: string
}

export function formatTokenUsage(usage: Record<string, TokenUsage>): { lines: FormattedUsage[]; grandTotal?: FormattedUsage } {
  const entries = Object.entries(usage)
  if (entries.length === 0) return { lines: [] }

  const lines = entries.map(([provider, u]) => ({
    provider,
    input: u.inputTokens.toLocaleString(),
    output: u.outputTokens.toLocaleString(),
    total: u.totalTokens.toLocaleString(),
  }))

  if (entries.length <= 1) return { lines }

  let grandIn = 0, grandOut = 0
  for (const [, u] of entries) {
    grandIn += u.inputTokens
    grandOut += u.outputTokens
  }

  return {
    lines,
    grandTotal: {
      provider: "total",
      input: grandIn.toLocaleString(),
      output: grandOut.toLocaleString(),
      total: (grandIn + grandOut).toLocaleString(),
    },
  }
}
