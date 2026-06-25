import { readFileSync, writeFileSync } from 'node:fs'
import type { Client } from 'discord.js'

interface Deferred {
  channelId: string
  messageId: string
  action: 'strip' | 'delete'
  content?: string        // for 'strip': the body to edit the message down to
  dueAt: number
}

// Durable registry for deferred message edits/deletes — the thought-for-line strip
// and the collapse-card delete. These are 120s-later actions; a plain setTimeout dies
// on a process restart, so we ALSO persist them and re-arm on boot (Jeff 2026-06-25).
export class DeferredActions {
  private items: Deferred[] = []

  constructor(private readonly file: string) {
    try { this.items = JSON.parse(readFileSync(file, 'utf8')) } catch { this.items = [] }
  }

  private flush(): void {
    try { writeFileSync(this.file, JSON.stringify(this.items)) } catch { /* best-effort */ }
  }

  private async run(client: Client, d: Deferred): Promise<void> {
    try {
      const ch = await client.channels.fetch(d.channelId)
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(d.messageId)
        if (d.action === 'strip' && d.content !== undefined) await msg.edit(d.content)
        else if (d.action === 'delete') await msg.delete()
      }
    } catch { /* message gone / no access — nothing to do */ }
    this.items = this.items.filter(x => !(x.messageId === d.messageId && x.action === d.action))
    this.flush()
  }

  // Record + arm the in-process timer. Survives a restart via the registry + rearm().
  schedule(client: Client, d: Deferred): void {
    this.items.push(d)
    this.flush()
    setTimeout(() => { void this.run(client, d) }, Math.max(0, d.dueAt - Date.now()))
  }

  // On boot, re-arm timers the prior process left behind — past-due fire ~now,
  // future ones wait out their remaining time. So a redeploy can't strand them.
  rearm(client: Client): void {
    for (const d of [...this.items]) {
      setTimeout(() => { void this.run(client, d) }, Math.max(0, d.dueAt - Date.now()))
    }
  }
}
