// Registry of in-flight codex turns per channel so /gpt stop can abort one that's
// stuck (e.g. a tool-calling loop). respondViaCodex registers a killer when it
// spawns and clears it when the turn ends; /gpt stop looks up the channel and
// fires the killer. A separate `stopped` flag lets the queue runner (runChannelTurn)
// know a turn was user-aborted so it drops any queued follow-ups too. (Jeff 2026-06-25)
//
// Barge-in (Jeff 2026-07-01/03): a new in-flight message can cut off the current
// turn and take over, but normal message barge-ins are deferred until a Codex
// lifecycle boundary. That avoids killing the model mid-thought/output while still
// stopping before the next tool action, where the queued replacement can run.
type Killer = () => void
type BusyTool = 'shell' | 'edit' | null
type PendingStop = { clearQueue: boolean }

// Grace period (ms): a turn younger than this is never barged. Protects both a
// just-started turn (no useful work to preserve yet is a wash — but avoids thrash on
// rapid double-sends) and, combined with the tool guard, a near-done turn.
export const BARGE_GRACE_MS = 4000

class ActiveTurns {
  private killers = new Map<string, Killer>()
  private stopped = new Set<string>()
  private startedAt = new Map<string, number>()
  private busyTool = new Map<string, BusyTool>()
  private pendingStops = new Map<string, PendingStop>()
  private idleWaiters = new Set<() => void>()

  /** respondViaCodex: record how to kill this channel's running turn. */
  register(channelId: string, kill: Killer): void {
    this.killers.set(channelId, kill)
    this.startedAt.set(channelId, Date.now())
  }

  /** respondViaCodex: the turn finished (or died) — forget its killer + liveness. */
  done(channelId: string): void {
    this.killers.delete(channelId)
    this.startedAt.delete(channelId)
    this.busyTool.delete(channelId)
    this.pendingStops.delete(channelId)
    this.resolveIdleIfNeeded()
  }

  /** codex-chat live loop: codex just STARTED a destructive tool (shell/file-edit) —
   *  barging now is unsafe. Cleared by clearBusy() on the item's completion. */
  setBusy(channelId: string, tool: Exclude<BusyTool, null>): void {
    this.busyTool.set(channelId, tool)
  }

  /** codex-chat live loop: the destructive tool finished — safe to barge again. */
  clearBusy(channelId: string): void {
    this.busyTool.set(channelId, null)
  }

  /** /gpt stop: kill the in-flight turn + mark the channel stopped so the queue
   *  drain bails. Returns true if a turn was actually running. */
  stop(channelId: string): boolean {
    return this.stopFor(channelId, { clearQueue: true })
  }

  /** Resolve Discord's command context defensively. Threads and their parent
   *  channels can produce different IDs depending on where autocomplete was
   *  invoked. Prefer an exact candidate; if there is exactly one turn running
   *  in the whole bot, that turn is unambiguous and safe to stop. */
  stopResolvable(channelIds: Array<string | null | undefined>): string | null {
    for (const channelId of channelIds) {
      if (channelId && this.killers.has(channelId)) {
        this.stop(channelId)
        return channelId
      }
    }
    if (this.killers.size !== 1) return null
    const [onlyChannelId] = this.killers.keys()
    this.stop(onlyChannelId)
    return onlyChannelId
  }

  /** Kill the in-flight turn. `clearQueue` controls whether the queue runner drops
   *  its remaining follow-ups: true for a user stop (❌ / /gpt stop — "abandon all"),
   *  false for a barge ("replace the running turn, keep any other queued messages").
   *  Returns true if a turn was actually running. */
  stopFor(channelId: string, opts: { clearQueue: boolean }): boolean {
    const k = this.killers.get(channelId)
    if (!k) return false
    if (opts.clearQueue) this.stopped.add(channelId)
    this.pendingStops.delete(channelId)
    try { k() } catch { /* best-effort */ }
    this.killers.delete(channelId)
    this.startedAt.delete(channelId)
    this.busyTool.delete(channelId)
    this.resolveIdleIfNeeded()
    return true
  }

  /** Normal message barge-in: mark the running turn to be killed at the next
   *  safe lifecycle boundary instead of SIGKILLing mid-output. */
  deferStopFor(channelId: string, opts: { clearQueue: boolean }): boolean {
    if (!this.killers.has(channelId)) return false
    this.pendingStops.set(channelId, opts)
    return true
  }

  /** codex-chat live loop: execute a pending deferred stop at a tool boundary. */
  stopIfPending(channelId: string): boolean {
    const pending = this.pendingStops.get(channelId)
    if (!pending) return false
    return this.stopFor(channelId, pending)
  }

  /** runChannelTurn: was this channel just stopped? Consumes the flag. */
  consumeStopped(channelId: string): boolean {
    if (this.stopped.has(channelId)) { this.stopped.delete(channelId); return true }
    return false
  }

  isActive(channelId: string): boolean {
    return this.killers.has(channelId)
  }

  isIdle(): boolean {
    return this.killers.size === 0
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.add(resolve))
  }

  /** Barge guard: safe to cut off this channel's in-flight turn iff a turn is
   *  running, it's past the grace window, and it's NOT mid a destructive tool call. */
  canBarge(channelId: string, now: number = Date.now()): boolean {
    if (!this.killers.has(channelId)) return false
    if (this.busyTool.get(channelId)) return false
    const started = this.startedAt.get(channelId)
    if (started === undefined) return false
    return now - started >= BARGE_GRACE_MS
  }

  /** A normal message is allowed to request a deferred barge once the grace
   *  window has passed, even if Codex is currently inside a destructive tool. */
  canRequestBarge(channelId: string, now: number = Date.now()): boolean {
    if (!this.killers.has(channelId)) return false
    const started = this.startedAt.get(channelId)
    if (started === undefined) return false
    return now - started >= BARGE_GRACE_MS
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

export const activeTurns = new ActiveTurns()
