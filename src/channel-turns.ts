/** FIFO per-channel runner whose liveness includes queued batches and cleanup. */
export type SubmitOutcome =
  | 'queued'
  | 'drained'
  | 'rejected_channel'
  | 'rejected_global'
  | 'rejected_principal'

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

interface ChannelState<T> {
  running: boolean
  queue: T[]
}

export interface ChannelTurnLimits<T> {
  maxQueuedPerChannel?: number
  maxActiveChannels?: number
  maxOutstandingPerKey?: number
  keyForItem?: (item: T) => string | undefined
}

export class ChannelTurnRunner<T> {
  private readonly states = new Map<string, ChannelState<T>>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly outstandingByKey = new Map<string, number>()

  constructor(
    private readonly processBatch: (channelId: string, batch: T[]) => Promise<void>,
    private readonly shouldClearQueue: (channelId: string) => boolean = () => false,
    private readonly settleMs = 0,
    private readonly limits: ChannelTurnLimits<T> = {},
  ) {}

  async submit(channelId: string, item: T): Promise<SubmitOutcome> {
    const existing = this.states.get(channelId)
    if (existing?.running) {
      if (existing.queue.length >= (this.limits.maxQueuedPerChannel ?? Infinity)) {
        return 'rejected_channel'
      }
      if (!this.canAcceptPrincipal(item)) return 'rejected_principal'
      existing.queue.push(item)
      this.track(item, 1)
      return 'queued'
    }

    if (this.states.size >= (this.limits.maxActiveChannels ?? Infinity)) {
      return 'rejected_global'
    }
    if (!this.canAcceptPrincipal(item)) return 'rejected_principal'

    const state: ChannelState<T> = existing ?? { running: false, queue: [] }
    state.running = true
    this.states.set(channelId, state)
    this.track(item, 1)
    let firstError: unknown
    try {
      try {
        await this.processBatch(channelId, [item])
      } catch (error) {
        firstError = error
      } finally {
        this.track(item, -1)
      }
      if (this.shouldClearQueue(channelId)) this.clearQueue(state)
      while (state.queue.length) {
        await this.waitForQuietQueue(state)
        if (this.shouldClearQueue(channelId)) {
          this.clearQueue(state)
          break
        }
        const batch = state.queue.splice(0, state.queue.length)
        try {
          await this.processBatch(channelId, batch)
        } catch (error) {
          firstError ??= error
        } finally {
          for (const queued of batch) this.track(queued, -1)
        }
        if (this.shouldClearQueue(channelId)) this.clearQueue(state)
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
    if (state.queue.length >= (this.limits.maxQueuedPerChannel ?? Infinity)) return -1
    if (!this.canAcceptPrincipal(item)) return -1
    state.queue.push(item)
    this.track(item, 1)
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

  clearQueued(channelId: string): number {
    const state = this.states.get(channelId)
    if (!state) return 0
    const count = state.queue.length
    this.clearQueue(state)
    return count
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

  private canAcceptPrincipal(item: T): boolean {
    const key = this.limits.keyForItem?.(item)
    if (!key) return true
    return (this.outstandingByKey.get(key) ?? 0) < (this.limits.maxOutstandingPerKey ?? Infinity)
  }

  private track(item: T, delta: 1 | -1): void {
    const key = this.limits.keyForItem?.(item)
    if (!key) return
    const next = (this.outstandingByKey.get(key) ?? 0) + delta
    if (next > 0) this.outstandingByKey.set(key, next)
    else this.outstandingByKey.delete(key)
  }

  private clearQueue(state: ChannelState<T>): void {
    for (const item of state.queue) this.track(item, -1)
    state.queue.length = 0
  }
}
