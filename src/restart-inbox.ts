import fs from 'node:fs'
import path from 'node:path'

interface DeferredMessage {
  channelId: string
  messageId: string
}

/**
 * Durable handoff for the few Discord messages that can arrive after intake
 * closes but before systemd replaces the process.
 */
export class RestartInbox {
  private items: DeferredMessage[]

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.items = Array.isArray(parsed) ? parsed : []
    } catch {
      this.items = []
    }
  }

  defer(channelId: string, messageId: string): void {
    if (this.items.some(item => item.messageId === messageId)) return
    this.items.push({ channelId, messageId })
    this.flush()
  }

  async replay(
    handle: (channelId: string, messageId: string) => Promise<void>,
  ): Promise<number> {
    let replayed = 0
    for (const item of [...this.items]) {
      try {
        await handle(item.channelId, item.messageId)
        this.items = this.items.filter(candidate => candidate.messageId !== item.messageId)
        this.flush()
        replayed++
      } catch {
        // Keep transient Discord/API failures for the next boot.
      }
    }
    return replayed
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.items))
    fs.renameSync(tmp, this.file)
  }
}
