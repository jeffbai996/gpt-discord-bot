interface LiveWorkMessageOptions {
  effortLabel: string
  headline?: string
  reasoningTrace?: string[]
  detail?: string
  footer?: string
  spinnerGlyph?: string
  spinnerDots?: string
  maxLength?: number
}

function cleanReasoningLine(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^🧠\s*/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim()
}

export function reasoningTraceLines(parts: string[]): string[] {
  return parts
    .flatMap(part => part.split(/\r?\n/))
    .map(cleanReasoningLine)
    .filter(Boolean)
}

export function latestReasoningHeadline(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).filter(Boolean).at(-1) ?? ''
  return cleanReasoningLine(line)
}

export function formatReasoningSnapshot(
  text: string,
  header: string = '💭 **Thinking:**',
): string {
  const headline = latestReasoningHeadline(text).toLocaleLowerCase('en-US')
  return headline
    ? `${header}\n> 🧠 *${headline}*`
    : header
}

export function formatReasoningTraceSnapshot(
  parts: string[],
  header: string = '💭 **Thinking:**',
): string {
  const lines = reasoningTraceLines(parts)
    .map(line => `> 🧠 *${line.toLocaleLowerCase('en-US')}*`)
  return [header, ...lines].join('\n')
}

const HEARTBEAT_VERBS = [
  'cogitating',
  'pondering',
  'mulling',
  'noodling',
  'ruminating',
  'scheming',
] as const

const HEARTBEAT_GLYPHS = ['✻', '✢', '✱', '✶', '✷', '✸'] as const
const HEARTBEAT_VERB_FRAMES = 4
export function pickHeartbeatVerb(random: () => number = Math.random): string {
  return HEARTBEAT_VERBS[Math.floor(random() * HEARTBEAT_VERBS.length)] ?? HEARTBEAT_VERBS[0]
}

export function nextHeartbeatVerb(current: string): string {
  const index = HEARTBEAT_VERBS.indexOf(current as typeof HEARTBEAT_VERBS[number])
  return HEARTBEAT_VERBS[(index + 1) % HEARTBEAT_VERBS.length] ?? HEARTBEAT_VERBS[0]
}

export function pickHeartbeatGlyph(frame: number): string {
  const index = Math.max(0, Math.floor(frame)) % HEARTBEAT_GLYPHS.length
  return HEARTBEAT_GLYPHS[index] ?? HEARTBEAT_GLYPHS[0]
}

export function heartbeatVisual(frame: number, verb: string): { glyph: string; verb: string } {
  return {
    glyph: pickHeartbeatGlyph(frame),
    verb: frame > 0 && frame % HEARTBEAT_VERB_FRAMES === 0
      ? nextHeartbeatVerb(verb)
      : verb,
  }
}

export function shouldRenderHeartbeat(
  _elapsedMs: number,
  idleMs: number,
  delayMs: number,
): boolean {
  return idleMs >= delayMs
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatHeartbeatFooter(
  elapsedMs: number,
  _idleMs: number,
  verb: string,
  glyph: string = HEARTBEAT_GLYPHS[0],
): string {
  return `-# \` ${glyph} still ${verb} · ${formatDuration(elapsedMs)} \``
}

export function formatLiveWorkMessage({
  effortLabel,
  headline = '',
  reasoningTrace = [],
  detail = '',
  footer = '',
  spinnerGlyph = HEARTBEAT_GLYPHS[0],
  spinnerDots = '…',
  maxLength = 1900,
}: LiveWorkMessageOptions): string {
  const header = `💭 ${spinnerGlyph} **${effortLabel}${spinnerDots}**`
  const cleanHeadline = headline.trim().toLocaleLowerCase('en-US')
  const accumulated = reasoningTraceLines(reasoningTrace)
    .map(line => `> 🧠 *${line.toLocaleLowerCase('en-US')}*`)
  const reasoning = accumulated.length
    ? `\n${accumulated.join('\n')}`
    : cleanHeadline ? `\n> 🧠 *${cleanHeadline}*` : ''
  const cleanDetail = detail.trim()
  const cleanFooter = footer.trim()
  const suffix = cleanFooter ? `\n\n${cleanFooter}` : ''
  const heading = header + reasoning
  if (!cleanDetail) return heading + suffix

  const prefix = `${heading}\n`
  const available = Math.max(1, maxLength - prefix.length - suffix.length)
  const clippedDetail = cleanDetail.length > available
    ? cleanDetail.slice(0, Math.max(0, available - 1)) + '…'
    : cleanDetail
  return prefix + clippedDetail + suffix
}
