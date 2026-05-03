import type { Budget } from "../types"

export class BudgetTracker {
  private budget: Budget
  private startTime: number

  constructor(opts: {
    maxTimeMs: number
    maxLlmCalls: number
  }) {
    this.startTime = Date.now()
    this.budget = {
      maxTimeMs: opts.maxTimeMs,
      maxLlmCalls: opts.maxLlmCalls,
      currentTimeMs: 0,
      currentLlmCalls: 0,
    }
  }

  recordLlmCall(): void {
    this.budget.currentLlmCalls++
    this.budget.currentTimeMs = Date.now() - this.startTime
  }

  isExhausted(): boolean {
    this.budget.currentTimeMs = Date.now() - this.startTime
    return (
      this.budget.currentTimeMs >= this.budget.maxTimeMs ||
      this.budget.currentLlmCalls >= this.budget.maxLlmCalls
    )
  }

  remaining(): { timeMs: number; llmCalls: number } {
    this.budget.currentTimeMs = Date.now() - this.startTime
    return {
      timeMs: this.budget.maxTimeMs - this.budget.currentTimeMs,
      llmCalls: this.budget.maxLlmCalls - this.budget.currentLlmCalls,
    }
  }

  current(): Budget {
    this.budget.currentTimeMs = Date.now() - this.startTime
    return { ...this.budget }
  }

  formatStatus(): string {
    return `time: ${(this.budget.currentTimeMs / 1000).toFixed(0)}s/${(this.budget.maxTimeMs / 1000).toFixed(0)}s | llm calls: ${this.budget.currentLlmCalls}/${this.budget.maxLlmCalls}`
  }
}
