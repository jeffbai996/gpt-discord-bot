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

  submit(text: string, onAccepted?: SteeringAccepted): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.handler) return this.deliver(this.handler, text, onAccepted)
    return new Promise(resolve => this.pending.push({ text, onAccepted, resolve }))
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
