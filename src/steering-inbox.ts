type SteeringHandler = (text: string) => Promise<boolean>

type PendingSteer = {
  text: string
  resolve: (accepted: boolean) => void
}

export class SteeringInbox {
  private handler: SteeringHandler | null = null
  private pending: PendingSteer[] = []
  private closed = false

  submit(text: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.handler) return this.handler(text)
    return new Promise(resolve => this.pending.push({ text, resolve }))
  }

  attach(handler: SteeringHandler): void {
    if (this.closed) return
    this.handler = handler
    const pending = this.pending.splice(0)
    void (async () => {
      for (const item of pending) item.resolve(await handler(item.text).catch(() => false))
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
}
