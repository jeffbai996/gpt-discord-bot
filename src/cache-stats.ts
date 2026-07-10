/**
 * Rolling per-channel cache + token telemetry.
 *
 * OpenAI's automatic prompt-prefix caching has no manual surface — you can't
 * create / inspect / flush a cache from the API. Cached hits show up after
 * the fact in `usage.prompt_tokens_details.cached_tokens`. To give operators
 * visibility, we keep a small ring buffer of recent turns per channel and
 * compute hit-rate + averages on demand via /gpt cache info.
 *
 * Bounded memory: WINDOW_SIZE turns per channel, no eviction (per-channel
 * Map grows with active channels, which is fine — squad has <20 channels).
 */
import type { RespondResult } from './openai.ts'

const WINDOW_SIZE = 50  // last N turns per channel

interface TurnRecord {
  ts: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  model: string
}

const channelStats = new Map<string, TurnRecord[]>()

import { readFileSync, writeFileSync } from 'node:fs'

// Cumulative totals across all channels — for /gpt stats. Persisted to disk so they
// survive restarts (were in-memory only, resetting every redeploy — Jeff 2026-06-25).
interface GlobalTotals {
  turns: number; inputTokens: number; outputTokens: number
  cachedInputTokens: number; reasoningTokens: number
  byModel: Record<string, number>; bootTs: number; since: number
  days: Record<string, DailyTotals>
}

interface ModelDailyTotals {
  turns: number; inputTokens: number; outputTokens: number
  cachedInputTokens: number; reasoningTokens: number
}

interface DailyTotals extends ModelDailyTotals {
  byModel: Record<string, ModelDailyTotals>
}

const emptyDaily = (): DailyTotals => ({
  turns: 0, inputTokens: 0, outputTokens: 0,
  cachedInputTokens: 0, reasoningTokens: 0, byModel: {},
})

export function pacificDay(ts = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts))
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function pruneDays(days: Record<string, DailyTotals>, keep = 45): Record<string, DailyTotals> {
  return Object.fromEntries(Object.entries(days).sort(([a], [b]) => b.localeCompare(a)).slice(0, keep))
}

const globalTotals: GlobalTotals = {
  turns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0,
  byModel: {}, bootTs: Date.now(), since: Date.now(), days: {},
}
export function globalSnapshot(): GlobalTotals {
  return structuredClone(globalTotals)
}

// Persistence: bootTs stays per-process (drives uptime); the totals + `since` carry
// across restarts so /gpt stats reflects real cumulative usage, not just this boot.
let _statsFile: string | null = null
export function initGlobalStats(file: string): void {
  _statsFile = file
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    globalTotals.turns = d.turns ?? 0
    globalTotals.inputTokens = d.inputTokens ?? 0
    globalTotals.outputTokens = d.outputTokens ?? 0
    globalTotals.cachedInputTokens = d.cachedInputTokens ?? 0
    globalTotals.reasoningTokens = d.reasoningTokens ?? 0
    globalTotals.byModel = (d.byModel && typeof d.byModel === 'object') ? d.byModel : {}
    globalTotals.since = d.since ?? Date.now()
    globalTotals.days = (d.days && typeof d.days === 'object') ? pruneDays(d.days) : {}
  } catch { /* fresh / unreadable — start clean */ }
}
function saveGlobalStats(): void {
  if (!_statsFile) return
  try {
    writeFileSync(_statsFile, JSON.stringify({
      turns: globalTotals.turns, inputTokens: globalTotals.inputTokens, outputTokens: globalTotals.outputTokens,
      cachedInputTokens: globalTotals.cachedInputTokens, reasoningTokens: globalTotals.reasoningTokens,
      byModel: globalTotals.byModel, since: globalTotals.since, days: globalTotals.days,
    }))
  } catch { /* best-effort */ }
}

export function recordTurn(channelId: string, result: RespondResult): void {
  if (!result.usage) return
  const buf = channelStats.get(channelId) ?? []
  buf.push({
    ts: Date.now(),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    model: result.modelUsed,
  })
  if (buf.length > WINDOW_SIZE) buf.splice(0, buf.length - WINDOW_SIZE)
  channelStats.set(channelId, buf)

  globalTotals.turns++
  globalTotals.inputTokens += result.usage.inputTokens
  globalTotals.outputTokens += result.usage.outputTokens
  globalTotals.cachedInputTokens += result.usage.cachedInputTokens
  globalTotals.reasoningTokens += result.usage.reasoningTokens
  globalTotals.byModel[result.modelUsed] = (globalTotals.byModel[result.modelUsed] ?? 0) + 1

  const dayKey = pacificDay()
  const day = globalTotals.days[dayKey] ?? emptyDaily()
  const model = day.byModel[result.modelUsed] ?? {
    turns: 0, inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, reasoningTokens: 0,
  }
  for (const totals of [day, model]) {
    totals.turns++
    totals.inputTokens += result.usage.inputTokens
    totals.outputTokens += result.usage.outputTokens
    totals.cachedInputTokens += result.usage.cachedInputTokens
    totals.reasoningTokens += result.usage.reasoningTokens
  }
  day.byModel[result.modelUsed] = model
  globalTotals.days[dayKey] = day
  globalTotals.days = pruneDays(globalTotals.days)
  saveGlobalStats()
}

export interface CacheSnapshot {
  turns: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  cacheHitRate: number  // 0-1, cached / input
  oldestTs: number | null
  newestTs: number | null
  models: string[]      // distinct models seen in window
}

export function snapshot(channelId: string): CacheSnapshot {
  const buf = channelStats.get(channelId) ?? []
  if (buf.length === 0) {
    return {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      cacheHitRate: 0,
      oldestTs: null,
      newestTs: null,
      models: [],
    }
  }
  let inp = 0, out = 0, cached = 0, reason = 0
  const models = new Set<string>()
  for (const t of buf) {
    inp += t.inputTokens
    out += t.outputTokens
    cached += t.cachedInputTokens
    reason += t.reasoningTokens
    models.add(t.model)
  }
  return {
    turns: buf.length,
    inputTokens: inp,
    outputTokens: out,
    cachedInputTokens: cached,
    reasoningTokens: reason,
    cacheHitRate: inp > 0 ? cached / inp : 0,
    oldestTs: buf[0].ts,
    newestTs: buf[buf.length - 1].ts,
    models: [...models],
  }
}

// Test-only: reset all state.
export function _reset(): void {
  channelStats.clear()
  _statsFile = null
  globalTotals.turns = 0
  globalTotals.inputTokens = 0
  globalTotals.outputTokens = 0
  globalTotals.cachedInputTokens = 0
  globalTotals.reasoningTokens = 0
  globalTotals.byModel = {}
  globalTotals.bootTs = Date.now()
  globalTotals.since = Date.now()
  globalTotals.days = {}
}
