/**
 * In-flight token telemetry — the live needle.
 *
 * Codex reports a turn's final usage once, at turn end. The fleet tachometer
 * samples every 5s, so gpt's tokens and dollars used to arrive as a whole-turn
 * lump after the work had already happened.
 *
 * Codex's session rollout does better. It writes `token_count` rows DURING the
 * turn — one per model roundtrip, ~5-12s apart — and each carries a
 * `last_token_usage` block that is that roundtrip's delta (verified on real
 * rollouts: the deltas sum exactly to the session total). codex-chat already
 * tails that file for reasoning summaries, so the transport was already there.
 *
 * What this module does NOT do is touch cache-stats. Those cumulative totals
 * are the completed-turn truth behind /gpt stats; adding partial amounts there
 * and reconciling at turn end is how you get a double count in the one place
 * that must not have one. Instead every in-flight token lane lives in its own
 * file, and the sampler adds it to the persisted total:
 *
 *     effective = global-stats (completed turns) + live-usage (this turn)
 *
 * At turn end the completed total absorbs the turn and this file clears, so
 * the sum moves continuously and never counts the same token twice.
 */
import { renameSync, writeFileSync } from 'node:fs'

export interface LiveUsageDelta {
  input: number
  cachedInput: number
  output: number
  reasoning: number
}

interface TurnProgress extends LiveUsageDelta {
  model: string
  ts: number
}

const turns = new Map<string, TurnProgress>()
let _file: string | null = null

export function initLiveUsage(file: string): void {
  _file = file
  save()
}

function save(): void {
  if (!_file) return
  try {
    const payload = {
      turns: Object.fromEntries([...turns].map(([k, v]) => [k, {
        input: v.input,
        cachedInput: v.cachedInput,
        output: v.output,
        reasoning: v.reasoning,
        model: v.model,
        ts: v.ts,
      }])),
      ts: Date.now(),
    }
    // Write-then-rename: the sampler reads this file on its own schedule and a
    // half-written JSON row would read as "no in-flight work" — a visible dip
    // in the needle rather than a harmless miss.
    const tmp = `${_file}.tmp`
    writeFileSync(tmp, JSON.stringify(payload))
    renameSync(tmp, _file)
  } catch { /* best-effort: telemetry must never break a turn */ }
}

/** Add one model roundtrip's reported usage to the turn currently in flight. */
export function noteRoundtrip(
  turnKey: string,
  delta: number | LiveUsageDelta,
  model = 'gpt-5.x',
): void {
  const usage: LiveUsageDelta = typeof delta === 'number'
    ? { input: 0, cachedInput: 0, output: delta, reasoning: 0 }
    : delta
  const clean = (value: number) => Number.isFinite(value) && value > 0 ? value : 0
  const input = clean(usage.input)
  const cachedInput = Math.min(input, clean(usage.cachedInput))
  const output = clean(usage.output)
  const reasoning = Math.min(output, clean(usage.reasoning))
  if (!(input || output)) return
  const prev = turns.get(turnKey)
  turns.set(turnKey, {
    input: (prev?.input ?? 0) + input,
    cachedInput: (prev?.cachedInput ?? 0) + cachedInput,
    output: (prev?.output ?? 0) + output,
    reasoning: (prev?.reasoning ?? 0) + reasoning,
    model: model || prev?.model || 'gpt-5.x',
    ts: Date.now(),
  })
  save()
}

/**
 * Turn finished and is BOOKED. Called after the completed total absorbs it, so
 * the two never both hold it and never both drop it.
 *
 * Not called when the process exits: that fires well before the turn is booked,
 * and the gap showed up on the live counter as a dip and then a spike — the
 * exact one-lump shape this module exists to remove.
 */
export function clearTurn(turnKey: string): void {
  if (!turns.delete(turnKey)) return
  save()
}

/**
 * Turn starting. Drops anything left on this thread by a turn that died before
 * it could be booked — otherwise the new turn accumulates on top of a corpse
 * and reads double until the staleness guard expires it.
 */
export function beginTurn(turnKey: string): void {
  clearTurn(turnKey)
}

export function liveSnapshot(): LiveUsageDelta & { turns: number } {
  const usage = { input: 0, cachedInput: 0, output: 0, reasoning: 0 }
  for (const t of turns.values()) {
    usage.input += t.input
    usage.cachedInput += t.cachedInput
    usage.output += t.output
    usage.reasoning += t.reasoning
  }
  return { ...usage, turns: turns.size }
}

// Test-only: reset all state.
export function _reset(): void {
  turns.clear()
  _file = null
}
