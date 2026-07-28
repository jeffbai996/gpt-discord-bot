// Discord's desktop trace card can be substantially narrower than the message
// body when the reaction rail is visible. Keep every rendered row inside this
// conservative width so the code fence scrolls horizontally instead of wrapping
// a single logical result row onto a second line.
export const DEFAULT_TOOL_CALL_WIDTH = 58
export const DEFAULT_TOOL_OUTPUT_WIDTH = 54
const TRACE_FAILSAFE_GRACE_MS = 5 * 60_000
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const WIDE_RE = /\p{Extended_Pictographic}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u

export function displayWidth(value: string): number {
  let width = 0
  for (const { segment } of graphemes.segment(value)) {
    if (/^[\p{Mark}\p{Format}]+$/u.test(segment)) continue
    width += WIDE_RE.test(segment) ? 2 : 1
  }
  return width
}

export function truncateDisplayWidth(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value
  let out = ''
  let width = 0
  for (const { segment } of graphemes.segment(value)) {
    const next = displayWidth(segment)
    if (width + next > maxWidth - 1) break
    out += segment
    width += next
  }
  return out + '…'
}

export function resolveTraceFailsafeMs(
  raw: string | undefined,
  turnTimeoutMs: number,
): number {
  const parsed = Number(raw)
  const configured = Number.isFinite(parsed) && parsed >= 0 ? parsed : 180_000
  const safeTurnWindow = Math.max(0, turnTimeoutMs) + TRACE_FAILSAFE_GRACE_MS
  return Math.max(configured, safeTurnWindow)
}

export function formatResultTraceLine(
  resultPreview: string,
  resultLines: number,
  previewWidth: number,
): string {
  const prefix = ' ⎿ '
  const cap = Math.max(1, previewWidth)
  const flattened = resultPreview.replace(/\n/g, ' ')
  const tag = resultLines > 1 ? `[${resultLines} lines]` : ''

  if (!tag) {
    const preview = flattened.length > cap
      ? flattened.slice(0, cap - 1) + '…'
      : flattened
    return prefix + preview
  }

  // Preserve the old preview-row ceiling: OUT_W characters of payload plus
  // the marker prefix. The count occupies unused space at the right edge; if
  // necessary, trim the preview rather than widening Discord's code fence.
  const available = Math.max(1, cap - tag.length - 1)
  const preview = flattened.length > available
    ? flattened.slice(0, Math.max(0, available - 1)) + '…'
    : flattened
  const gap = ' '.repeat(Math.max(1, cap - preview.length - tag.length))
  return `${prefix}${preview}${gap}${tag}`
}
