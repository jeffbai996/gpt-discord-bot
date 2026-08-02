const DEFAULT_INTERVAL_MS = 1500
const DEFAULT_END_LINGER_MS = 30_000
const DEFAULT_PROGRESS_DWELL_CAP_MS = 30_000
const MIN_PROGRESS_DWELL_MS = 10_000
const READING_MS_PER_WORD = 300

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
  const words = clean.split(/\s+/).filter(Boolean).length
  return Math.min(
    Math.max(0, capMs),
    Math.max(MIN_PROGRESS_DWELL_MS, words * READING_MS_PER_WORD),
  )
}

export function advanceLiveProgressDwell(input: {
  text: string
  lastText: string
  renderedAt: number
  holdUntil: number
}): { lastText: string; holdUntil: number } {
  if (input.text === input.lastText) {
    return { lastText: input.lastText, holdUntil: input.holdUntil }
  }
  return {
    lastText: input.text,
    holdUntil: input.renderedAt + liveProgressDwellMs(input.text),
  }
}
