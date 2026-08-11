import type { Message } from 'discord.js'

import { applyLifecycle, type LifecycleState } from './lifecycle.ts'

type LifecycleApplier = (message: Message, state: LifecycleState) => Promise<void>

const TERMINAL = new Set<LifecycleState>([
  'replied', 'truncated', 'blocked', 'errored', 'interrupted', 'denied', 'silenced',
])

/** Serializes one turn's reaction state and lets steering hand the indicator to
 * the newly-consumed Discord message without stale async reaction edits racing. */
export class TurnLifecycleTracker {
  private target: Message
  private state: LifecycleState | null = null
  private toolDepth = 0
  private terminal = false
  private chain: Promise<void> = Promise.resolve()

  constructor(target: Message, private readonly apply: LifecycleApplier = applyLifecycle) {
    this.target = target
  }

  transition(state: LifecycleState): Promise<void> {
    if (this.state === state) return this.chain
    this.state = state
    if (TERMINAL.has(state)) this.terminal = true
    const target = this.target
    return this.enqueue(() => this.apply(target, state))
  }

  moveTo(target: Message): Promise<void> {
    if (target.id === this.target.id) return this.chain
    const previous = this.target
    const state = this.state ?? 'received'
    this.target = target
    return this.enqueue(async () => {
      await this.apply(previous, 'silenced')
      await this.apply(target, state)
    })
  }

  reasoning(): Promise<void> {
    if (this.terminal || this.toolDepth > 0) return this.chain
    return this.transition('thinking')
  }

  toolStarted(): Promise<void> {
    if (this.terminal) return this.chain
    this.toolDepth += 1
    return this.transition('tooling')
  }

  toolEnded(): Promise<void> {
    if (this.toolDepth > 0) this.toolDepth -= 1
    if (this.terminal || this.toolDepth > 0) return this.chain
    return this.transition('thinking')
  }

  drain(): Promise<void> {
    return this.chain
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.catch(() => {}).then(operation)
    return this.chain
  }
}
