type SteeringHandler = (text: string) => Promise<boolean>
type SteeringAccepted = () => void | Promise<void>

type PendingSteer = {
  text: string
  onAccepted?: SteeringAccepted
  resolve: (accepted: boolean) => void
}

export class SteeringInbox {
  private handler: SteeringHandler | null = null
  private pending: PendingSteer[] = []
  private closed = false
  private reserved = 0

  constructor(private readonly maxAccepted = 4) {
    if (!Number.isSafeInteger(maxAccepted) || maxAccepted <= 0) {
      throw new Error('steering admission limit must be a positive integer')
    }
  }

  submit(text: string, onAccepted?: SteeringAccepted): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    // Reserve before awaiting either transport attachment or its RPC. Accepted
    // steers retain their slot for this turn; rejected ones release it and fall
    // back through the bounded channel queue.
    if (this.reserved >= this.maxAccepted) return Promise.resolve(false)
    this.reserved += 1
    const result = this.handler
      ? this.deliver(this.handler, text, onAccepted)
      : new Promise<boolean>(resolve => this.pending.push({ text, onAccepted, resolve }))
    return result.then(accepted => {
      if (!accepted) this.reserved -= 1
      return accepted
    }, () => {
      this.reserved -= 1
      return false
    })
  }

  attach(handler: SteeringHandler): void {
    if (this.closed) return
    this.handler = handler
    const pending = this.pending.splice(0)
    void (async () => {
      for (const item of pending) {
        item.resolve(await this.deliver(handler, item.text, item.onAccepted))
      }
    })()
  }

  close(): void {
    this.closed = true
    this.handler = null
    for (const item of this.pending.splice(0)) item.resolve(false)
  }

  detach(): void {
    if (!this.closed) this.handler = null
  }

  private async deliver(
    handler: SteeringHandler,
    text: string,
    onAccepted?: SteeringAccepted,
  ): Promise<boolean> {
    const accepted = await handler(text).catch(() => false)
    if (!accepted) return false
    await Promise.resolve(onAccepted?.()).catch(() => {})
    return true
  }
}
