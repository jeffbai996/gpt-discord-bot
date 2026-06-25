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

class ChannelSessions {
  private map = new Map<string, string>()

  constructor() {
    this.load()
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
   *  Returns true if there was one to clear. */
  clear(channelId: string): boolean {
    const had = this.map.delete(channelId)
    if (had) this.save()
    return had
  }
}

export const channelSessions = new ChannelSessions()
