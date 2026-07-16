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
  // Cached prompt prefixes are replayed on every agent step and dominate the
  // raw input total on tool-heavy turns. Headline genuinely new input; keep the
  // cache shard visible below so the full provider accounting is still honest.
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
  const parts = [
    `↑ ${n(uncachedInput)}`,
    `↓ ${n(usage.outputTokens)}`,
    `◷ ${(durationMs / 1000).toFixed(1)}s`,
  ]
  const sub = [
    ...(usage.cachedInputTokens > 0 ? [`cache ↑ ${n(usage.cachedInputTokens)}`] : []),
    ...(usage.reasoningTokens > 0 ? [`reasoning ↓ ${n(usage.reasoningTokens)}`] : []),
  ]
  const subLine = mode === 'both' && sub.length ? `\n-# \` ${sub.join(' · ')} \`` : ''
  return `\n\n-# \` ${parts.join(' · ')} \`${subLine}`
}
