// Registry of in-flight codex turns per channel so /gpt stop can abort one that's
// stuck (e.g. a tool-calling loop). respondViaCodex registers a killer when it
// spawns and clears it when the turn ends; /gpt stop looks up the channel and
// fires the killer. A separate `stopped` flag lets the queue runner (runChannelTurn)
// know a turn was user-aborted so it drops any queued follow-ups too. (Jeff 2026-06-25)
//
// Barge-in (Jeff 2026-07-01): a new in-flight message can cut off the current turn
// and take over — but only when it's SAFE. Two guards: a grace window (don't murder
// a turn that just started / is about to finish) and a tool-safety check (never barge
// while codex is mid shell/file-edit — SIGKILL there could leave a half-written file).
// `startedAt` + `busyTool` feed `canBarge()`; `stopFor()` kills without clearing the
// rest of the queue (a barge only replaces the killer, not the other queued messages).
type Killer = () => void
type BusyTool = 'shell' | 'edit' | null

// Grace period (ms): a turn younger than this is never barged. Protects both a
// just-started turn (no useful work to preserve yet is a wash — but avoids thrash on
// rapid double-sends) and, combined with the tool guard, a near-done turn.
export const BARGE_GRACE_MS = 4000

class ActiveTurns {
  private killers = new Map<string, Killer>()
  private stopped = new Set<string>()
  private startedAt = new Map<string, number>()
  private busyTool = new Map<string, BusyTool>()

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

  /** Kill the in-flight turn. `clearQueue` controls whether the queue runner drops
   *  its remaining follow-ups: true for a user stop (❌ / /gpt stop — "abandon all"),
   *  false for a barge ("replace the running turn, keep any other queued messages").
   *  Returns true if a turn was actually running. */
  stopFor(channelId: string, opts: { clearQueue: boolean }): boolean {
    const k = this.killers.get(channelId)
    if (!k) return false
    if (opts.clearQueue) this.stopped.add(channelId)
    try { k() } catch { /* best-effort */ }
    this.killers.delete(channelId)
    this.startedAt.delete(channelId)
    this.busyTool.delete(channelId)
    return true
  }

  /** runChannelTurn: was this channel just stopped? Consumes the flag. */
  consumeStopped(channelId: string): boolean {
    if (this.stopped.has(channelId)) { this.stopped.delete(channelId); return true }
    return false
  }

  isActive(channelId: string): boolean {
    return this.killers.has(channelId)
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
}

export const activeTurns = new ActiveTurns()
