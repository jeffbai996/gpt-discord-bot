const DEFAULT_INTERVAL_MS = 1500
const DEFAULT_END_LINGER_MS = 10_000
const DEFAULT_PROGRESS_DWELL_CAP_MS = 15_000

export function resolveLiveUpdateInterval(raw: string | undefined): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_INTERVAL_MS
}

export function resolveLiveEndLinger(raw: string | undefined): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_END_LINGER_MS
}

export function shouldLingerLiveEnd(input: {
  isRegeneration: boolean
  hasLiveState: boolean
}): boolean {
  return !input.isRegeneration && input.hasLiveState
}

/** Give substantial live narration enough screen time before replacing it. */
export function liveProgressDwellMs(
  text: string,
  capMs = DEFAULT_PROGRESS_DWELL_CAP_MS,
): number {
  const clean = text.trim()
  if (clean.length < 240 && !clean.includes('\n')) return 0
  return Math.min(Math.max(0, capMs), Math.max(4_000, clean.length * 20))
}
