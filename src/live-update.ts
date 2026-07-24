const DEFAULT_INTERVAL_MS = 1500
const DEFAULT_END_LINGER_MS = 5000

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
