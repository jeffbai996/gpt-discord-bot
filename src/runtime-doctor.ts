import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface DoctorCheck { name: string; ok: boolean; detail: string }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[] }

export interface MemoryDoctorSnapshot {
  messageCount: number
  latestMessageAt: string | null
  summaryCount: number
  latestSummaryAt: string | null
  maxPendingMessages: number
  summarizationThreshold: number
}

export interface SourceState {
  revision: string
  fingerprint: string
}

export interface DoctorRuntimeDeps {
  now?: () => number
  memory?: MemoryDoctorSnapshot | null | (() => MemoryDoctorSnapshot | null)
  backgroundModels?: {
    summarizerModel: string
    embeddingModel: string
    list: () => Promise<string[]>
  }
  deployment?: {
    boot: SourceState
    current: () => SourceState | Promise<SourceState>
  }
  slashCommands?: {
    expected: unknown
    fetchRemote: () => Promise<unknown[]>
  }
  ingestionMaxAgeMs?: number
}

function ageDetail(timestamp: string | null, now: number): { ok: boolean; text: string; ageMs: number } {
  if (!timestamp) return { ok: false, text: 'never', ageMs: Number.POSITIVE_INFINITY }
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return { ok: false, text: 'invalid timestamp', ageMs: Number.POSITIVE_INFINITY }
  const ageMs = Math.max(0, now - parsed)
  const minutes = Math.floor(ageMs / 60_000)
  const text = minutes < 60
    ? `${minutes}m ago`
    : minutes < 1_440
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
      : `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h ago`
  return { ok: true, text, ageMs }
}

const COMMAND_FIELDS = new Set([
  'type', 'name', 'description', 'required', 'choices', 'options',
  'channel_types', 'min_value', 'max_value', 'min_length', 'max_length',
  'autocomplete', 'default_member_permissions',
])

function normalizedCommand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedCommand)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!COMMAND_FIELDS.has(key) || item === undefined || item === null || item === false) continue
    const normalized = normalizedCommand(item)
    if (Array.isArray(normalized) && normalized.length === 0) continue
    out[key] = normalized
  }
  return out
}

export function slashCommandMatches(
  expected: unknown,
  remote: unknown[],
): boolean {
  const expectedName = expected && typeof expected === 'object'
    ? (expected as Record<string, unknown>).name
    : undefined
  const actual = remote.find(command => command && typeof command === 'object'
    && (command as Record<string, unknown>).name === expectedName)
  if (!actual) return false
  const normalizedActual = normalizedCommand(actual) as Record<string, unknown>
  const normalizedExpected = normalizedCommand(expected) as Record<string, unknown>
  // Discord adds the top-level chat-input command type even though the builder
  // omits its default. Nested option types remain part of the compared schema.
  delete normalizedActual.type
  delete normalizedExpected.type
  return JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected)
}

export async function appendRuntimeChecks(
  checks: DoctorCheck[],
  deps: DoctorRuntimeDeps,
): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  if ('memory' in deps) {
    const memory = typeof deps.memory === 'function' ? deps.memory() : deps.memory
    if (!memory) {
      checks.push({ name: 'memory ingestion', ok: false, detail: 'memory store unavailable' })
      checks.push({ name: 'summary state', ok: false, detail: 'memory store unavailable' })
    } else {
      const latest = ageDetail(memory.latestMessageAt, now)
      const maxAge = deps.ingestionMaxAgeMs ?? 24 * 60 * 60 * 1_000
      checks.push({
        name: 'memory ingestion',
        ok: memory.messageCount > 0 && latest.ok && latest.ageMs <= maxAge,
        detail: `${memory.messageCount} messages · latest ${latest.text}`,
      })
      const summaryAge = ageDetail(memory.latestSummaryAt, now)
      const due = memory.maxPendingMessages >= memory.summarizationThreshold
      checks.push({
        name: 'summary state',
        ok: !due,
        detail: `${memory.summaryCount} summaries · latest ${summaryAge.text} · `
          + `${memory.maxPendingMessages}/${memory.summarizationThreshold} pending max/channel`,
      })
    }
  }

  if (deps.backgroundModels) {
    try {
      const models = await deps.backgroundModels.list()
      const available = new Set(models)
      checks.push({ name: 'model endpoint', ok: true, detail: `${models.length} models reachable` })
      checks.push({
        name: 'summary model',
        ok: available.has(deps.backgroundModels.summarizerModel),
        detail: `${deps.backgroundModels.summarizerModel} · ${available.has(deps.backgroundModels.summarizerModel) ? 'available' : 'MISSING'}`,
      })
      checks.push({
        name: 'embedding model',
        ok: available.has(deps.backgroundModels.embeddingModel),
        detail: `${deps.backgroundModels.embeddingModel} · ${available.has(deps.backgroundModels.embeddingModel) ? 'available' : 'MISSING'}`,
      })
    } catch (error: any) {
      checks.push({ name: 'model endpoint', ok: false, detail: error?.message ?? String(error) })
      checks.push({ name: 'summary model', ok: false, detail: `${deps.backgroundModels.summarizerModel} · unchecked` })
      checks.push({ name: 'embedding model', ok: false, detail: `${deps.backgroundModels.embeddingModel} · unchecked` })
    }
  }

  if (deps.deployment) {
    try {
      const current = await deps.deployment.current()
      const ok = current.revision === deps.deployment.boot.revision
        && current.fingerprint === deps.deployment.boot.fingerprint
      checks.push({
        name: 'deployed source',
        ok,
        detail: ok
          ? `${current.revision.slice(0, 8)} · ${current.fingerprint}`
          : `boot ${deps.deployment.boot.revision.slice(0, 8)}+${deps.deployment.boot.fingerprint} · current ${current.revision.slice(0, 8)}+${current.fingerprint}`,
      })
    } catch (error: any) {
      checks.push({ name: 'deployed source', ok: false, detail: error?.message ?? String(error) })
    }
  }

  if (deps.slashCommands) {
    try {
      const remote = await deps.slashCommands.fetchRemote()
      const ok = slashCommandMatches(deps.slashCommands.expected, remote)
      checks.push({ name: 'remote slash', ok, detail: ok ? 'schema matches Discord' : 'Discord schema drift' })
    } catch (error: any) {
      checks.push({ name: 'remote slash', ok: false, detail: error?.message ?? String(error) })
    }
  }
}

const SOURCE_PATHS = ['src', 'tests', 'package.json', 'package-lock.json', '.env.example', 'systemd']

/** Fingerprint the exact source snapshot used by tsx without reading runtime secrets. */
export function captureSourceState(repoDir = process.cwd()): SourceState {
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const revision = git(['rev-parse', 'HEAD']).trim()
  const hash = createHash('sha256')
  const diff = git(['diff', '--binary', 'HEAD', '--', ...SOURCE_PATHS])
  hash.update(diff)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...SOURCE_PATHS])
    .split('\n').filter(Boolean).sort()
  for (const relative of untracked) {
    hash.update(relative)
    hash.update(fs.readFileSync(path.join(repoDir, relative)))
  }
  return {
    revision,
    fingerprint: diff || untracked.length ? `dirty:${hash.digest('hex').slice(0, 12)}` : 'clean',
  }
}
