// One scannable log line per codex turn. The codex path was silent (stderr →
// /dev/null, no logging), so mid-turn deaths read as "for some reason" — this
// makes each turn's outcome one `journalctl -u gpt` away. (Jeff 2026-07-05)

export type TurnOutcome = 'completed' | 'timeout' | 'stopped' | 'error' | 'empty'

export interface TurnOutcomeInfo {
  outcome: TurnOutcome
  durationMs: number
  lines: number          // JSONL event lines seen from codex --json
  replyChars: number     // length of the final reply (0 = nothing produced)
  timedOut: boolean
  stoppedByUser: boolean
  detail?: string        // optional extra (e.g. error message)
}

function humanMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** Format a single-line turn-outcome record for the service journal. */
export function formatTurnOutcome(info: TurnOutcomeInfo): string {
  const parts = [
    '[codex-turn]',
    info.outcome,
    humanMs(info.durationMs),
    `${info.lines} lines`,
    `${info.replyChars} chars`,
  ]
  if (info.detail) parts.push(`— ${info.detail}`)
  return parts.join(' ')
}
