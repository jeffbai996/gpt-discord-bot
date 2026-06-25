import { readFileSync, writeFileSync } from 'node:fs'
import type { Client } from 'discord.js'

interface Pending {
  channelId: string
  messageId: string        // the placeholder bubble
  userMessageId?: string   // the inbound message that triggered the turn
}

// Tiny on-disk registry of "live" placeholder messages (the 💭 thinking…/running…
// bubble shown while a turn runs). Tracked on creation, dropped when the turn
// resolves. Anything still on disk at boot belongs to a turn the previous process
// never finished (deploy / crash / OOM mid-turn) — sweep() edits those to a
// terminal "✗ Interrupted" marker so they don't sit as zombie placeholders.
export class PendingPlaceholders {
  private pending: Pending[] = []

  constructor(private readonly file: string) {
    try {
      this.pending = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      this.pending = []
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.pending))
    } catch {
      // best-effort: a lost registry only costs a zombie placeholder, not a crash
    }
  }

  track(channelId: string, messageId: string, userMessageId?: string): void {
    this.pending.push({ channelId, messageId, userMessageId })
    this.flush()
  }

  untrack(messageId: string): void {
    const before = this.pending.length
    this.pending = this.pending.filter(p => p.messageId !== messageId)
    if (this.pending.length !== before) this.flush()
  }

  // Edit every leftover placeholder to "✗ Interrupted" and clear the registry.
  // Snapshots + clears first so a partial failure (deleted message, lost channel
  // access) doesn't get re-swept on the next boot. Returns how many were swept.
  async sweep(client: Client): Promise<number> {
    const stale = this.pending
    this.pending = []
    this.flush()
    let swept = 0
    for (const p of stale) {
      try {
        const ch = await client.channels.fetch(p.channelId)
        if (ch && ch.isTextBased()) {
          const msg = await ch.messages.fetch(p.messageId)
          await msg.edit('✗ **Interrupted**')
          swept++
          // Stamp ❌ on the user's original message so the interruption is visible
          // even after they've scrolled past the placeholder (Jeff 2026-06-24).
          if (p.userMessageId) {
            try { const um = await ch.messages.fetch(p.userMessageId); await um.react('❌') } catch { /* msg gone */ }
          }
        }
      } catch {
        // message deleted / no access — nothing to clean up
      }
    }
    return swept
  }
}
