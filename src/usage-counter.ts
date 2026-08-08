export interface CounterUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

// Discord's iPhone message gutter wraps this monospace pill before 50 visible
// columns once the subtext prefix and bubble padding are included.
const MOBILE_ROW_CEILING = 47
const COMPACT_SPEED_ROW_CEILING = 47

function compactNumber(value: number): string {
  if (value < 1_000) return value.toLocaleString('en-US')
  const divisor = value >= 1_000_000 ? 1_000_000 : 1_000
  const suffix = value >= 1_000_000 ? 'm' : 'k'
  return `${Number((value / divisor).toPrecision(3))}${suffix}`
}

export function formatUsageCounter(
  mode: 'off' | 'token' | 'both',
  usage: CounterUsage,
  durationMs: number,
): string {
  if (mode === 'off') return ''

  // Cached prompt prefixes are replayed on every agent step and dominate the
  // raw input total on tool-heavy turns. Headline genuinely new input; keep the
  // cache shard visible below so the full provider accounting is still honest.
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
  const seconds = durationMs / 1000
  const rate = seconds > 0 ? usage.outputTokens / seconds : 0
  const renderRows = (compact: boolean, wholeSpeeds = false, tight = false) => {
    const n = compact ? compactNumber : (value: number) => value.toLocaleString('en-US')
    const inputWidth = Math.max(compact ? 4 : 7, n(uncachedInput).length, n(usage.cachedInputTokens).length)
    const outputWidth = Math.max(4, n(usage.outputTokens).length, n(usage.reasoningTokens).length)
    const right = (value: number, width: number) => n(value).padStart(width)
    const firstTop = ` input ↑ ${right(uncachedInput, inputWidth)}`
    const firstBottom = usage.cachedInputTokens > 0
      ? ` cache ↑ ${right(usage.cachedInputTokens, inputWidth)}`
      : ''.padEnd(firstTop.length)
    const secondTop = `${'output ↓'.padStart(11)} ${right(usage.outputTokens, outputWidth)}`
    const secondBottom = usage.reasoningTokens > 0
      ? `reasoning ↓ ${right(usage.reasoningTokens, outputWidth)}`
      : ''.padEnd(secondTop.length)
    // Both speed figures sit in the same column of two stacked pills, so they
    // share one width. Padding only the throughput left the duration a
    // character to its left and the numbers visibly out of line.
    const durationRaw = seconds.toFixed(wholeSpeeds ? 0 : 1)
    const throughputRaw = rate.toFixed(wholeSpeeds ? 0 : 1)
    const speedWidth = Math.max(wholeSpeeds ? 2 : 4, durationRaw.length, throughputRaw.length)
    const duration = durationRaw.padStart(speedWidth)
    const throughput = throughputRaw.padStart(speedWidth)
    const columnGap = tight ? ' ' : '   '
    const speedGap = tight ? '  ' : '    '
    return {
      // Keep the unit attached to its value. Discord wraps inline-code pills at
      // ordinary spaces on narrow mobile bubbles; the old `54.1 s` / `27.7 t/s`
      // could strand the final unit on a tiny second-line pill.
      top: `${firstTop}${columnGap}${secondTop}${speedGap}◷ ${duration}s`,
      bottom: `${firstBottom}${columnGap}${secondBottom}${speedGap}» ${throughput}t/s`,
    }
  }

  let { top, bottom } = renderRows(false)
  if (Math.max(top.length, bottom.length) > MOBILE_ROW_CEILING) ({ top, bottom } = renderRows(false, false, true))
  if (Math.max(top.length, bottom.length) > MOBILE_ROW_CEILING) ({ top, bottom } = renderRows(false, true, true))
  if (Math.max(top.length, bottom.length) > MOBILE_ROW_CEILING) {
    ({ top, bottom } = renderRows(true, false, true))
    if (Math.max(top.length, bottom.length) > COMPACT_SPEED_ROW_CEILING) {
      ({ top, bottom } = renderRows(true, true, true))
    }
  }
  if (mode === 'token') return `\n\n-# \`${top} \``

  if (usage.cachedInputTokens <= 0 && usage.reasoningTokens <= 0) {
    return `\n\n-# \`${top} \``
  }

  // Discord cannot make a multiline inline-code pill. Render two stacked pills
  // and pad the shorter row inside its backticks so their boxes are equal-width.
  const rowWidth = Math.max(top.length, bottom.length)
  return `\n\n-# \`${top.padEnd(rowWidth)}\`\n-# \`${bottom.padEnd(rowWidth)}\``
}
