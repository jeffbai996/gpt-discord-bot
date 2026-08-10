export const DEFAULT_MAX_MISSED_FRAMES = 250

/**
 * Discord polls raw audio every 20ms. Realtime audio arrives in bursts, so the
 * discord.js default of five missed frames tears down the resource after only
 * 100ms of temporary starvation and strands every later model audio delta.
 */
export function resolveMaxMissedFrames(
  configured = process.env.GPT_VOICE_MAX_MISSED_FRAMES,
): number {
  const parsed = Number.parseInt(configured ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MISSED_FRAMES
}
