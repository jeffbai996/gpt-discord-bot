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
// Per-channel /clear cutoff timestamps — persisted so the cutoff survives restarts.
const CLEARED_FILE = path.join(STATE_DIR, 'channel-cleared.json')
const SECURITY_EPOCH_FILE = path.join(STATE_DIR, 'channel-session-security-epoch')

interface CumUsage { input: number; output: number; cachedInput: number; reasoning: number }

class ChannelSessions {
  private map = new Map<string, string>()
  private usage = new Map<string, CumUsage>()
  // Clear-cutoff: /clear stamps now; history fetch ignores messages at/before this.
  // Persisted so it survives restarts.
  private clearedAt = new Map<string, number>()
  markCleared(channelId: string) { this.clearedAt.set(channelId, Date.now()); this.saveCleared() }
  clearedSince(channelId: string): number { return this.clearedAt.get(channelId) ?? 0 }

  constructor() {
    this.load()
    this.loadUsage()
    this.loadCleared()
  }

  /**
   * One-time security migration for resumable Codex sessions. A session can
   * retain context that is no longer present in filtered Discord history, so a
   * history-authorization change must cold-start every channel once. Backups
   * make the migration recoverable without allowing the bot to resume them.
   */
  invalidateAllOnce(epoch: string): number {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(epoch)) {
      throw new Error('invalid channel-session security epoch')
    }
    try {
      if (fs.readFileSync(SECURITY_EPOCH_FILE, 'utf8').trim() === epoch) {
        this.hardenSecurityMigrationFiles(epoch)
        return 0
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    this.backupOnce(FILE, epoch)
    this.backupOnce(USAGE_FILE, epoch)
    const invalidated = this.map.size
    this.map.clear()
    this.usage.clear()
    fs.writeFileSync(FILE, '{}', { mode: 0o600 })
    fs.writeFileSync(USAGE_FILE, '{}', { mode: 0o600 })
    fs.writeFileSync(SECURITY_EPOCH_FILE, `${epoch}\n`, { mode: 0o600 })
    this.hardenSecurityMigrationFiles(epoch)
    return invalidated
  }

  private hardenSecurityMigrationFiles(epoch: string): void {
    for (const file of [
      FILE,
      USAGE_FILE,
      SECURITY_EPOCH_FILE,
      `${FILE}.${epoch}.bak`,
      `${USAGE_FILE}.${epoch}.bak`,
    ]) {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
    }
  }

  private backupOnce(file: string, epoch: string): void {
    if (!fs.existsSync(file)) return
    const backup = `${file}.${epoch}.bak`
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
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

  /** Last cumulative Codex usage reported for this channel's resumed session. */
  lastUsage(channelId: string): CumUsage | undefined {
    const u = this.usage.get(channelId)
    return u ? { ...u } : undefined
  }

  /** Record the session id returned by the latest codex turn for this channel. */
  set(channelId: string, sessionId: string): void {
    if (this.map.get(channelId) === sessionId) return
    this.map.set(channelId, sessionId)
    this.save()
  }

  /** USER-initiated clear (/clear): forget the codex session AND stamp the
   *  history cutoff so the conversation truly starts fresh. */
  clear(channelId: string): boolean {
    this.markCleared(channelId)
    return this.dropSession(channelId)
  }

  /** SESSION-only drop (rollover / codex error): forget the session pointer +
   *  usage baseline so the next turn cold-starts — WITHOUT stamping the history
   *  cutoff. The next turn re-grounds from Discord history, so hiding it would
   *  be self-defeating. Bugfix 2026-06-29: rollover/error called clear(), whose
   *  markCleared() stamped a cutoff that the history filter then used to drop
   *  ALL history (full amnesia on the ollama path; masked here by session
   *  resume but still wrong). Split the intents. */
  dropSession(channelId: string): boolean {
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

  private loadCleared(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(CLEARED_FILE, 'utf8')) as Record<string, number>
      this.clearedAt = new Map(Object.entries(raw))
    } catch { /* no file yet */ }
  }

  private saveCleared(): void {
    try {
      fs.writeFileSync(CLEARED_FILE, JSON.stringify(Object.fromEntries(this.clearedAt)))
    } catch (e) {
      console.error('channel-cleared save failed:', e instanceof Error ? e.message : e)
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
