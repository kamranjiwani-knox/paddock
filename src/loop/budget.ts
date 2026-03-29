import type { Budget } from "../types"

export class BudgetTracker {
  private budget: Budget
  private startTime: number

  constructor(opts: {
    maxIterations: number
    maxTimeMs: number
    maxLlmCalls: number
  }) {
    this.startTime = Date.now()
    this.budget = {
      maxIterations: opts.maxIterations,
      maxTimeMs: opts.maxTimeMs,
      maxLlmCalls: opts.maxLlmCalls,
      currentIterations: 0,
      currentTimeMs: 0,
      currentLlmCalls: 0,
    }
  }

  recordLlmCall(): void {
    this.budget.currentLlmCalls++
    this.budget.currentTimeMs = Date.now() - this.startTime
  }

  recordIteration(): void {
    this.budget.currentIterations++
    this.budget.currentTimeMs = Date.now() - this.startTime
  }

  isExhausted(): boolean {
    this.budget.currentTimeMs = Date.now() - this.startTime
    return (
      this.budget.currentIterations >= this.budget.maxIterations ||
      this.budget.currentTimeMs >= this.budget.maxTimeMs ||
      this.budget.currentLlmCalls >= this.budget.maxLlmCalls
    )
  }

  remaining(): { iterations: number; timeMs: number; llmCalls: number } {
    this.budget.currentTimeMs = Date.now() - this.startTime
    return {
      iterations: this.budget.maxIterations - this.budget.currentIterations,
      timeMs: this.budget.maxTimeMs - this.budget.currentTimeMs,
      llmCalls: this.budget.maxLlmCalls - this.budget.currentLlmCalls,
    }
  }

  current(): Budget {
    this.budget.currentTimeMs = Date.now() - this.startTime
    return { ...this.budget }
  }

  formatStatus(): string {
    const r = this.remaining()
    return `iterations: ${this.budget.currentIterations}/${this.budget.maxIterations} | time: ${(this.budget.currentTimeMs / 1000).toFixed(0)}s/${(this.budget.maxTimeMs / 1000).toFixed(0)}s | llm calls: ${this.budget.currentLlmCalls}/${this.budget.maxLlmCalls}`
  }
}
