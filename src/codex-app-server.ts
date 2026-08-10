import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

type RpcWaiter = {
  resolve: (value: any) => void
  reject: (error: Error) => void
}
export class CodexAppServerClient {
  private nextId = 1
  private readonly pending = new Map<number, RpcWaiter>()
  private readonly lines
  private closed = false

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly onNotification: (message: any) => void = () => {},
  ) {
    this.lines = createInterface({ input })
    this.lines.on('line', line => this.consume(line))
    this.lines.on('close', () => this.close())
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error('codex app-server is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.output.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.closed) this.output.write(`${JSON.stringify({ method, params })}\n`)
  }

  async steer(threadId: string, expectedTurnId: string, text: string): Promise<boolean> {
    try {
      const response = await this.request('turn/steer', {
        threadId,
        expectedTurnId,
        input: [{ type: 'text', text }],
      })
      return response?.turnId === expectedTurnId
    } catch {
      return false
    }
  }

  close(error = new Error('codex app-server closed')): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  private consume(line: string): void {
    if (!line.trim()) return
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (typeof message?.id === 'number') {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(String(message.error.message ?? 'app-server error')))
      else waiter.resolve(message.result)
      return
    }
    if (typeof message?.method === 'string') this.onNotification(message)
  }
}
