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
  const seconds = durationMs / 1000
  const rate = seconds > 0 ? usage.outputTokens / seconds : 0
  const inputWidth = Math.max(7, n(uncachedInput).length, n(usage.cachedInputTokens).length)
  const outputWidth = Math.max(5, n(usage.outputTokens).length, n(usage.reasoningTokens).length)
  const right = (value: number, width: number) => n(value).padStart(width)
  const firstTop = ` input ↑ ${right(uncachedInput, inputWidth)}`
  const firstBottom = usage.cachedInputTokens > 0
    ? ` cache ↑ ${right(usage.cachedInputTokens, inputWidth)}`
    : ''.padEnd(firstTop.length)
  const secondTop = `${'output ↓'.padStart(11)} ${right(usage.outputTokens, outputWidth)}`
  const secondBottom = usage.reasoningTokens > 0
    ? `reasoning ↓ ${right(usage.reasoningTokens, outputWidth)}`
    : ''.padEnd(secondTop.length)
  const top = `${firstTop}  ${secondTop}   ◷ ${seconds.toFixed(1)} s`
  if (mode === 'token') return `\n\n-# \`${top} \``

  if (usage.cachedInputTokens <= 0 && usage.reasoningTokens <= 0) {
    return `\n\n-# \`${top} \``
  }

  const bottom = `${firstBottom}  ${secondBottom}   » ${rate.toFixed(1).padStart(5)} t/s`
  // Discord cannot make a multiline inline-code pill. Render two stacked pills
  // and pad the shorter row inside its backticks so their boxes are equal-width.
  const rowWidth = Math.max(top.length, bottom.length)
  return `\n\n-# \`${top.padEnd(rowWidth)}\`\n-# \`${bottom.padEnd(rowWidth)}\``
}
