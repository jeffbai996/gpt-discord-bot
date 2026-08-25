export interface GlobalAdmissionSnapshot {
  running: number
  queued: number
  oldestWaitMs: number
  pausedForMemory: boolean
}

export interface GlobalTurnAdmissionOptions {
  maxActive: number
  highWaterBytes?: number
  lowWaterBytes?: number
  memoryBytes?: () => number | null
  pollMs?: number
  now?: () => number
  onStateChange?: (snapshot: GlobalAdmissionSnapshot) => void
}

export interface AdmissionRunHooks {
  onQueued?: (position: number) => void | Promise<void>
  beforeStart?: () => void | Promise<void>
  onCancelled?: () => void | Promise<void>
}

interface WaitingTurn<T> {
  key: string
  enqueuedAt: number
  ready: boolean
  cancelled: boolean
  job: () => Promise<T>
  beforeStart?: () => void | Promise<void>
  onCancelled?: () => void | Promise<void>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export class TurnAdmissionCancelledError extends Error {
  constructor() {
    super('queued turn cancelled')
    this.name = 'TurnAdmissionCancelledError'
  }
}

/**
 * Fleet-wide FIFO admission for expensive turns.
 *
 * Per-channel ordering remains owned by ChannelTurnRunner. This layer only
 * decides when a channel may consume one of the process-wide model slots.
 * Memory hysteresis blocks new starts without killing work already in flight.
 */
export class GlobalTurnAdmission {
  private readonly queue: Array<WaitingTurn<unknown>> = []
  private readonly idleWaiters = new Set<() => void>()
  private active = 0
  private memoryPaused = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: GlobalTurnAdmissionOptions) {
    if (!Number.isSafeInteger(options.maxActive) || options.maxActive <= 0) {
      throw new Error('maxActive must be a positive integer')
    }
    if (options.highWaterBytes !== undefined || options.lowWaterBytes !== undefined) {
      const high = options.highWaterBytes ?? 0
      const low = options.lowWaterBytes ?? high
      if (!(high > 0 && low >= 0 && low < high)) {
        throw new Error('memory low-water must be non-negative and below high-water')
      }
    }
  }

  run<T>(key: string, job: () => Promise<T>, hooks: AdmissionRunHooks = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: WaitingTurn<T> = {
        key,
        enqueuedAt: this.now(),
        ready: true,
        cancelled: false,
        job,
        beforeStart: hooks.beforeStart,
        onCancelled: hooks.onCancelled,
        resolve,
        reject,
      }
      this.queue.push(entry as WaitingTurn<unknown>)

      const canStartNow = this.queue.length === 1
        && this.active < this.options.maxActive
        && !this.refreshMemoryPressure()
      if (!canStartNow && hooks.onQueued) {
        entry.ready = false
        const position = this.queue.length
        void Promise.resolve(hooks.onQueued(position))
          .catch(() => {})
          .finally(() => {
            if (entry.cancelled) {
              void Promise.resolve(entry.onCancelled?.()).catch(() => {})
              return
            }
            entry.ready = true
            this.pump()
          })
      }
      this.emitState()
      this.pump()
    })
  }

  cancel(key: string): number {
    let cancelled = 0
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const entry = this.queue[index]
      if (entry.key !== key) continue
      this.queue.splice(index, 1)
      entry.cancelled = true
      if (entry.ready) void Promise.resolve(entry.onCancelled?.()).catch(() => {})
      entry.reject(new TurnAdmissionCancelledError())
      cancelled++
    }
    if (cancelled) {
      this.emitState()
      this.resolveIdleIfNeeded()
    }
    return cancelled
  }

  hasQueued(key: string): boolean {
    return this.queue.some(entry => entry.key === key)
  }

  snapshot(): GlobalAdmissionSnapshot {
    const oldest = this.queue[0]
    return {
      running: this.active,
      queued: this.queue.length,
      oldestWaitMs: oldest ? Math.max(0, this.now() - oldest.enqueuedAt) : 0,
      pausedForMemory: this.memoryPaused,
    }
  }

  isIdle(): boolean {
    return this.active === 0 && this.queue.length === 0
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.add(resolve))
  }

  private pump(): void {
    if (this.refreshMemoryPressure()) {
      this.schedulePressurePoll()
      this.emitState()
      return
    }
    this.clearPressurePoll()
    while (this.active < this.options.maxActive && this.queue.length > 0) {
      const entry = this.queue[0]
      if (!entry.ready) break
      this.queue.shift()
      this.active++
      this.emitState()
      void this.start(entry)
    }
    this.resolveIdleIfNeeded()
  }

  private async start(entry: WaitingTurn<unknown>): Promise<void> {
    try {
      await entry.beforeStart?.()
      entry.resolve(await entry.job())
    } catch (error) {
      entry.reject(error)
    } finally {
      this.active--
      this.emitState()
      this.pump()
    }
  }

  private refreshMemoryPressure(): boolean {
    if (!this.options.memoryBytes || this.options.highWaterBytes === undefined) {
      this.memoryPaused = false
      return false
    }
    const current = this.options.memoryBytes()
    if (current === null || !Number.isFinite(current)) {
      this.memoryPaused = false
      return false
    }
    if (this.memoryPaused) {
      if (current <= (this.options.lowWaterBytes ?? 0)) this.memoryPaused = false
    } else if (current >= this.options.highWaterBytes) {
      this.memoryPaused = true
    }
    return this.memoryPaused
  }

  private schedulePressurePoll(): void {
    if (this.pollTimer || this.queue.length === 0) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.pump()
    }, this.options.pollMs ?? 2_000)
  }

  private clearPressurePoll(): void {
    if (!this.pollTimer) return
    clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return
    this.clearPressurePoll()
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  private emitState(): void {
    try { this.options.onStateChange?.(this.snapshot()) } catch {}
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
