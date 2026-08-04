/**
 * In-flight token telemetry — the live needle.
 *
 * Codex reports a turn's usage once, at turn end. The fleet tachometer samples
 * every 5s, so gpt's rate was a whole turn's output divided by the minutes of
 * plateau that produced it: a permanent ~1 tok/s that never cleared the
 * "starting" floor, while every Claude bot showed real movement.
 *
 * Codex's session rollout does better. It writes `token_count` rows DURING the
 * turn — one per model roundtrip, ~5-12s apart — and each carries a
 * `last_token_usage` block that is that roundtrip's delta (verified on real
 * rollouts: the deltas sum exactly to the session total). codex-chat already
 * tails that file for reasoning summaries, so the transport was already there.
 *
 * What this module does NOT do is touch cache-stats. Those cumulative totals
 * are the billing truth behind /gpt stats and every $ readout; adding partial
 * amounts there and reconciling at turn end is how you get a double count in
 * the one place that must not have one. Instead the in-flight bytes live in
 * their own file, and the sampler adds them to the persisted total:
 *
 *     effective = global-stats (completed turns) + live-usage (this turn)
 *
 * At turn end the completed total absorbs the turn and this file clears, so
 * the sum moves continuously and never counts the same token twice.
 */
import { renameSync, writeFileSync } from 'node:fs'

interface TurnProgress {
  output: number
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
      turns: Object.fromEntries([...turns].map(([k, v]) => [k, { output: v.output, ts: v.ts }])),
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

/** Add one model roundtrip's OUTPUT tokens to the turn currently in flight. */
export function noteRoundtrip(turnKey: string, outputDelta: number): void {
  if (!Number.isFinite(outputDelta) || outputDelta <= 0) return
  const prev = turns.get(turnKey)
  turns.set(turnKey, { output: (prev?.output ?? 0) + outputDelta, ts: Date.now() })
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

export function liveSnapshot(): { output: number; turns: number } {
  let output = 0
  for (const t of turns.values()) output += t.output
  return { output, turns: turns.size }
}

// Test-only: reset all state.
export function _reset(): void {
  turns.clear()
  _file = null
}
