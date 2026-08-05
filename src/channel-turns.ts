/** FIFO per-channel runner whose liveness includes queued batches and cleanup. */
export type SubmitOutcome = 'queued' | 'drained'

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

interface ChannelState<T> {
  running: boolean
  queue: T[]
}

export class ChannelTurnRunner<T> {
  private readonly states = new Map<string, ChannelState<T>>()
  private readonly idleWaiters = new Set<() => void>()

  constructor(
    private readonly processBatch: (channelId: string, batch: T[]) => Promise<void>,
    private readonly shouldClearQueue: (channelId: string) => boolean = () => false,
    private readonly settleMs = 0,
  ) {}

  async submit(channelId: string, item: T): Promise<SubmitOutcome> {
    const existing = this.states.get(channelId)
    if (existing?.running) {
      existing.queue.push(item)
      return 'queued'
    }

    const state: ChannelState<T> = existing ?? { running: false, queue: [] }
    state.running = true
    this.states.set(channelId, state)
    let firstError: unknown
    try {
      try {
        await this.processBatch(channelId, [item])
      } catch (error) {
        firstError = error
      }
      if (this.shouldClearQueue(channelId)) state.queue.length = 0
      while (state.queue.length) {
        await this.waitForQuietQueue(state)
        if (this.shouldClearQueue(channelId)) {
          state.queue.length = 0
          break
        }
        const batch = state.queue.splice(0, state.queue.length)
        try {
          await this.processBatch(channelId, batch)
        } catch (error) {
          firstError ??= error
        }
        if (this.shouldClearQueue(channelId)) state.queue.length = 0
      }
      if (firstError !== undefined) throw firstError
      return 'drained'
    } finally {
      state.running = false
      if (!state.queue.length) this.states.delete(channelId)
      this.resolveIdleIfNeeded()
    }
  }

  enqueue(channelId: string, item: T): number {
    const state = this.states.get(channelId)
    if (!state?.running) return 0
    state.queue.push(item)
    return state.queue.length
  }

  isRunning(channelId: string): boolean {
    return this.states.get(channelId)?.running === true
  }

  queueDepth(channelId: string): number {
    return this.states.get(channelId)?.queue.length ?? 0
  }

  totalQueueDepth(): number {
    let total = 0
    for (const state of this.states.values()) total += state.queue.length
    return total
  }

  activeChannels(): number {
    return this.states.size
  }

  isIdle(): boolean {
    return this.states.size === 0
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.add(resolve))
  }

  private async waitForQuietQueue(state: ChannelState<T>): Promise<void> {
    if (this.settleMs <= 0) return
    while (state.queue.length) {
      const depth = state.queue.length
      await delay(this.settleMs)
      if (state.queue.length === depth) return
    }
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}
