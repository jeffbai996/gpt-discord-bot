// Registry of in-flight codex turns per channel so /gpt stop can abort one that's
// stuck (e.g. a tool-calling loop). respondViaCodex registers a killer when it
// spawns and clears it when the turn ends; /gpt stop looks up the channel and
// fires the killer. A separate `stopped` flag lets the queue runner (runChannelTurn)
// know a turn was user-aborted so it drops any queued follow-ups too. (Jeff 2026-06-25)
type Killer = () => void

class ActiveTurns {
  private killers = new Map<string, Killer>()
  private stopped = new Set<string>()

  /** respondViaCodex: record how to kill this channel's running turn. */
  register(channelId: string, kill: Killer): void {
    this.killers.set(channelId, kill)
  }

  /** respondViaCodex: the turn finished (or died) — forget its killer. */
  done(channelId: string): void {
    this.killers.delete(channelId)
  }

  /** /gpt stop: kill the in-flight turn + mark the channel stopped so the queue
   *  drain bails. Returns true if a turn was actually running. */
  stop(channelId: string): boolean {
    const k = this.killers.get(channelId)
    if (!k) return false
    this.stopped.add(channelId)
    try { k() } catch { /* best-effort */ }
    this.killers.delete(channelId)
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
}

export const activeTurns = new ActiveTurns()
