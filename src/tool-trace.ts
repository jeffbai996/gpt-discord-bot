// Discord's code-block chrome consumes about six cells at Jeff's client width.
// Cap rendered rows at 74 display cells so the text clears the copy control
// instead of making an 80-cell fence overflow the message body.
export const DEFAULT_TOOL_CALL_WIDTH = 74
export const DEFAULT_TOOL_OUTPUT_WIDTH = 70
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

export function formatUnifiedDiffTrace(
  unified: string,
): { badge: string; body: string[] } {
  let adds = 0
  let dels = 0
  const rows: Array<{ marker: '+' | '-' | ' '; lineNo: number | null; text: string }> = []
  let oldLine = 0
  let newLine = 0

  for (const line of unified.replace(/\n+$/, '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      adds++
      rows.push({ marker: '+', lineNo: newLine || null, text: line.slice(1) })
      if (newLine) newLine++
    } else if (line.startsWith('-')) {
      dels++
      rows.push({ marker: '-', lineNo: oldLine || null, text: line.slice(1) })
      if (oldLine) oldLine++
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line
      rows.push({ marker: ' ', lineNo: newLine || oldLine || null, text })
      if (oldLine) oldLine++
      if (newLine) newLine++
    }
  }

  const width = Math.max(2, ...rows.map(row => (
    row.lineNo ? String(row.lineNo).length : 0
  )))
  const body = rows.map((row) => {
    const lineNo = row.lineNo
      ? String(row.lineNo).padStart(width)
      : ' '.repeat(width)
    // Context rows already use a literal space as their diff marker. Do not
    // add the colored-row separator too, or padTraceLine shifts their number
    // one cell right compared with +/- rows.
    const separator = row.marker === ' ' ? '' : ' '
    return `${row.marker}${separator}${lineNo} ${row.text}`
  })
  return { badge: `[+${adds}, -${dels}]`, body }
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
    const preview = truncateDisplayWidth(flattened, cap)
    return prefix + preview
  }

  // Preserve the old preview-row ceiling: OUT_W characters of payload plus
  // the marker prefix. The count occupies unused space at the right edge; if
  // necessary, trim the preview rather than widening Discord's code fence.
  const tagWidth = displayWidth(tag)
  const available = Math.max(1, cap - tagWidth - 1)
  const preview = truncateDisplayWidth(flattened, available)
  const gap = ' '.repeat(Math.max(1, cap - displayWidth(preview) - tagWidth))
  return `${prefix}${preview}${gap}${tag}`
}
