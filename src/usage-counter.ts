export interface CounterUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

const MOBILE_ROW_CEILING = 50
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
    const duration = seconds.toFixed(wholeSpeeds ? 0 : 1)
    const throughput = rate.toFixed(wholeSpeeds ? 0 : 1).padStart(wholeSpeeds ? 2 : 4)
    const columnGap = tight ? ' ' : '   '
    const speedGap = tight ? '  ' : '    '
    return {
      top: `${firstTop}${columnGap}${secondTop}${speedGap}◷ ${duration} s`,
      bottom: `${firstBottom}${columnGap}${secondBottom}${speedGap}» ${throughput} t/s`,
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
