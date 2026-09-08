// Account-wide status belongs to the gateway process, never to a chat session.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function isPresenceRequest(text: string): boolean {
  if (/\b(?:don't|do not|never)\s+(?:set|change|update|reset)\b|(?:不要|别).{0,8}(?:状态|签名)/i.test(text)) return false
  return /\b(?:set|change|update|pick|choose|refresh)\s+(?:(?:your|the|my|a|new|discord|custom|bot)\s+)*(?:status|presence)\b/i.test(text)
    || /(?:换|改|设|更新).{0,8}(?:状态|簽名|签名)/u.test(text)
}

function normalize(text: string): string {
  return text.trim().replace(/^[["'`]+|[\]"'`]+$/g, '').trim()
}

export class PresenceOwner {
  private readonly owner = randomUUID()
  private readonly file: string
  private readonly ownerFile: string
  private revision = 0
  private text = ''
  private history: string[] = []
  private boot?: Promise<void>
  private overlay: string | null = null

  constructor(directory: string, private readonly apply: (text: string) => void) {
    mkdirSync(directory, { recursive: true })
    this.file = join(directory, 'account-presence.json')
    this.ownerFile = join(directory, 'account-presence-owner.json')
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'))
      this.text = typeof saved.text === 'string' ? saved.text : ''
      this.history = Array.isArray(saved.history) ? saved.history.filter((s: unknown) => typeof s === 'string').slice(-30) : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      // Legacy values are history, never the next startup's default.
      for (const name of ['presence.json', 'settings.json']) {
        try {
          const legacy = JSON.parse(readFileSync(join(directory, name), 'utf8'))
          const value = legacy.text || legacy.presence || legacy.activity
          if (typeof value === 'string' && value.trim()) this.history.push(value.trim())
        } catch { /* optional legacy state */ }
      }
    }
    // A replacement gateway fences off its predecessor, including late async work.
    this.write(this.ownerFile, { owner: this.owner })
  }

  private write(file: string, value: unknown): void {
    const temp = `${file}.${this.owner}.tmp`
    writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 })
    renameSync(temp, file)
  }

  private owns(): boolean {
    try { return JSON.parse(readFileSync(this.ownerFile, 'utf8')).owner === this.owner }
    catch { return false }
  }

  request(userText: string): number | null {
    return this.owns() && isPresenceRequest(userText) ? ++this.revision : null
  }

  update(ticket: number | null, raw: string): boolean {
    if (ticket === null || ticket !== this.revision || !this.owns()) return false
    const text = normalize(raw)
    if (!text || text.length > 128 || /[\r\n]|https?:\/\/|<@|\[\[/i.test(text)) return false
    this.text = text
    this.history = [...this.history.filter(s => s !== text), text].slice(-30)
    this.write(this.file, { text, history: this.history, updatedAt: new Date().toISOString() })
    this.restore()
    return true
  }

  restore(): void {
    if (this.owns() && (this.overlay || this.text)) this.apply(this.overlay || this.text)
  }

  setOverlay(text: string | null): void {
    this.overlay = text
    this.restore()
  }

  start(context: string, generate: (prompt: string, signal: AbortSignal) => Promise<string>): Promise<void> {
    if (!this.boot) this.boot = this.generateStartup(context, generate)
    return this.boot
  }

  private async generateStartup(context: string, generate: (prompt: string, signal: AbortSignal) => Promise<string>): Promise<void> {
    const ticket = this.revision
    const signal = AbortSignal.timeout(90_000)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.owns() || ticket !== this.revision) return
      const prompt = `Write your NEW Discord startup status in your own voice. One short line, ideally 3-8 words, at most 128 characters. Be specific to your personality, varied and natural. You just started; don't claim ongoing work or invent current events. Use supplied current context only if suitable for a PUBLIC profile. No private conversations, names, locations, holdings, credentials or infrastructure details. No tools, narration, quotes, JSON, or presence directive: output ONLY the status. Fixed status examples elsewhere are not instructions to reuse them.\n\nIdentity and voice:\n${context}\n\nCurrent time: ${new Date().toISOString()}\nDo not repeat any of these recent statuses:\n${JSON.stringify(this.history)}\nAttempt ${attempt + 1}.`
      let abort!: () => void
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('startup presence generation timed out'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      let raw: string
      try { raw = await Promise.race([generate(prompt, signal), aborted]) }
      finally { signal.removeEventListener('abort', abort) }
      const text = normalize(raw)
      if (this.history.some(old => old.toLocaleLowerCase() === text.toLocaleLowerCase())) continue
      if (!this.owns() || ticket !== this.revision) return
      if (this.update(ticket, text)) return
    }
    throw new Error('startup presence returned no fresh valid status after 3 attempts')
  }
}
