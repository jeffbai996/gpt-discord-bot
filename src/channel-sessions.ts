// Per-channel codex session map: remembers which codex session id each channel
// is conversing in, so each turn can `codex exec resume <id>` instead of a cold
// `codex exec` — giving gpt persistent context (its own prior reasoning + tool
// work), not a blank slate every turn. Persisted to disk so it survives restarts.
// Shared singleton: gpt.ts reads/writes it per turn, commands.ts clears it for
// /gpt clear. (Jeff 2026-06-25)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const STATE_DIR = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
const FILE = path.join(STATE_DIR, 'channel-sessions.json')
// Per-channel CUMULATIVE token totals from the last turn. codex's
// turn.completed.usage on a RESUMED session reports the WHOLE session's running
// totals, not the marginal turn — so the ↑/↓ counter kept growing every turn
// (Jeff 2026-06-25 "make sure the token up/down is accurate, it was
// accumulating"). We stash last turn's cumulative here so gpt.ts can show the
// per-turn DELTA (current cumulative − previous) instead of the raw cumulative.
const USAGE_FILE = path.join(STATE_DIR, 'channel-usage.json')

interface CumUsage { input: number; output: number; cachedInput: number; reasoning: number }

class ChannelSessions {
  private map = new Map<string, string>()
  private usage = new Map<string, CumUsage>()

  constructor() {
    this.load()
    this.loadUsage()
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, string>
      this.map = new Map(Object.entries(raw))
    } catch {
      /* no file yet / unreadable — start empty */
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(this.map)))
    } catch (e) {
      console.error('channel-sessions save failed:', e instanceof Error ? e.message : e)
    }
  }

  /** The codex session id this channel is conversing in, if any. */
  get(channelId: string): string | undefined {
    return this.map.get(channelId)
  }

  /** Record the session id returned by the latest codex turn for this channel. */
  set(channelId: string, sessionId: string): void {
    if (this.map.get(channelId) === sessionId) return
    this.map.set(channelId, sessionId)
    this.save()
  }

  /** Forget this channel's session → next turn starts a fresh codex session.
   *  Returns true if there was one to clear. Also resets the cumulative-usage
   *  baseline so the next (fresh) turn's delta isn't computed against a stale
   *  total. */
  clear(channelId: string): boolean {
    const had = this.map.delete(channelId)
    if (had) this.save()
    if (this.usage.delete(channelId)) this.saveUsage()
    return had
  }

  private loadUsage(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) as Record<string, CumUsage>
      this.usage = new Map(Object.entries(raw))
    } catch {
      /* no file yet — start empty */
    }
  }

  private saveUsage(): void {
    try {
      fs.writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(this.usage)))
    } catch (e) {
      console.error('channel-usage save failed:', e instanceof Error ? e.message : e)
    }
  }

  /** This turn's MARGINAL token usage, derived by subtracting last turn's stored
   *  cumulative from the new cumulative codex just reported, then recording the
   *  new cumulative for next time. On a fresh session (or right after /gpt
   *  clear) there's no stored baseline, so the delta == the reported value — but
   *  a fresh exec's turn.completed already IS the per-turn cost, so that's
   *  correct. Negative deltas (a session reset/compaction shrank the running
   *  total) clamp to the reported value rather than going negative. */
  usageDelta(channelId: string, cum: CumUsage): CumUsage {
    const prev = this.usage.get(channelId)
    this.usage.set(channelId, { ...cum })
    this.saveUsage()
    if (!prev) return { ...cum }
    const d = (a: number, b: number) => (a >= b ? a - b : a)
    return {
      input: d(cum.input, prev.input),
      output: d(cum.output, prev.output),
      cachedInput: d(cum.cachedInput, prev.cachedInput),
      reasoning: d(cum.reasoning, prev.reasoning),
    }
  }
}

export const channelSessions = new ChannelSessions()
