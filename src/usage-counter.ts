export interface CounterUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

export function formatUsageCounter(
  mode: 'off' | 'token' | 'both',
  usage: CounterUsage,
  durationMs: number,
): string {
  if (mode === 'off') return ''

  const n = (value: number) => value.toLocaleString('en-US')
  const right = (value: number, width: number) => n(value).padStart(width)
  // Cached prompt prefixes are replayed on every agent step and dominate the
  // raw input total on tool-heavy turns. Headline genuinely new input; keep the
  // cache shard visible below so the full provider accounting is still honest.
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
  const seconds = durationMs / 1000
  const rate = seconds > 0 ? usage.outputTokens / seconds : 0
  const top = ` input ↑ ${right(uncachedInput, 7)}      ${'output ↓'.padStart(11)} ${right(usage.outputTokens, 5)}      ◷ ${seconds.toFixed(1)} s`
  if (mode === 'token') return `\n\n-# \`${top} \``

  const bottom = ` cache ↑ ${right(usage.cachedInputTokens, 7)}      reasoning ↓ ${right(usage.reasoningTokens, 5)}      » ${rate.toFixed(1).padStart(5)} t/s `
  return `\n\n-# \`${top}\n${bottom}\``
}
