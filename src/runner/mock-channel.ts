export interface Message {
  id: string
  text: string
  from: string
  channel: string
  ts: number
  sessionId: string
  metadata?: Record<string, unknown>
}

export interface IChannelGateway {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(to: string, text: string): Promise<void>
  onMessage(handler: (msg: Message) => Promise<void>): void
  streamSend?(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void>
}

export interface SentMessage {
  to: string
  text: string
  ts: number
}

export class MockChannel implements IChannelGateway {
  readonly name = "mock"

  private handler: ((msg: Message) => Promise<void>) | null = null
  private sent: SentMessage[] = []
  private waiters: Array<(msg: SentMessage) => void> = []

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(to: string, text: string): Promise<void> {
    const msg: SentMessage = { to, text, ts: Date.now() }
    this.sent.push(msg)
    const waiter = this.waiters.shift()
    if (waiter) waiter(msg)
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
  }

  // ─── Eval-specific methods ───────────────────────────────

  async simulateIncoming(text: string, from = "eval-user"): Promise<void> {
    if (!this.handler) throw new Error("No message handler registered on MockChannel")
    await this.handler({
      id: crypto.randomUUID(),
      text,
      from,
      channel: "mock",
      ts: Date.now(),
      sessionId: `mock:${from}`,
    })
  }

  waitForResponse(timeoutMs = 30_000): Promise<SentMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onMsg)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new Error(`MockChannel: no response within ${timeoutMs}ms`))
      }, timeoutMs)

      const onMsg = (msg: SentMessage) => {
        clearTimeout(timer)
        resolve(msg)
      }

      this.waiters.push(onMsg)
    })
  }

  async waitForAllResponses(quietMs = 3_000, maxWaitMs = 60_000): Promise<string[]> {
    const responses: string[] = []
    const deadline = Date.now() + maxWaitMs

    while (Date.now() < deadline) {
      try {
        const remaining = Math.min(quietMs, deadline - Date.now())
        if (remaining <= 0) break
        const msg = await this.waitForResponse(remaining)
        responses.push(msg.text)
      } catch {
        break
      }
    }

    return responses
  }

  getSentMessages(): SentMessage[] {
    return [...this.sent]
  }

  clear(): void {
    this.sent = []
    this.waiters = []
  }
}
