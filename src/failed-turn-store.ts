import fs from 'node:fs'
import path from 'node:path'

export interface FailedTurn {
  channelId: string
  sourceMessageId: string
  diagnostic: string
  consumed?: boolean
}

export class FailedTurnStore {
  private items: Record<string, FailedTurn>

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.items = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      this.items = {}
    }
  }

  get(errorMessageId: string): FailedTurn | undefined {
    return this.items[errorMessageId]
  }

  set(errorMessageId: string, turn: FailedTurn): void {
    this.items[errorMessageId] = turn
    this.flush()
  }

  // Claim synchronously before any Discord I/O; both buttons and reactions use this.
  // Retain a tombstone so late reactions cannot fall through to generic regenerate.
  claim(errorMessageId: string): FailedTurn | undefined {
    const turn = this.items[errorMessageId]
    if (!turn || turn.consumed) return undefined
    this.items[errorMessageId] = { ...turn, consumed: true }
    this.flush()
    return turn
  }

  delete(errorMessageId: string): void {
    if (!(errorMessageId in this.items)) return
    delete this.items[errorMessageId]
    this.flush()
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export function formatFailureDiagnostic(diagnostic: string): string {
  const prefix = 'Failure diagnostic (private):\n```text\n'
  const suffix = '\n```'
  const safe = diagnostic.replaceAll('```', '` ` `')
  return `${prefix}${safe.slice(0, 2_000 - prefix.length - suffix.length)}${suffix}`
}

export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
  return typeof error === 'string' ? error : JSON.stringify(error, null, 2)
}
