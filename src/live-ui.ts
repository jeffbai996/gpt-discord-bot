interface LiveWorkMessageOptions {
  effortLabel: string
  detail?: string
  footer?: string
  maxLength?: number
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatHeartbeatFooter(elapsedMs: number, idleMs: number): string {
  const activity = idleMs < 1_000
    ? 'activity just now'
    : `last activity ${formatDuration(idleMs)} ago`
  return `\`\`\`\n✻ still working · ${formatDuration(elapsedMs)} elapsed · ${activity}\n\`\`\``
}

export function formatLiveWorkMessage({
  effortLabel,
  detail = '',
  footer = '',
  maxLength = 1900,
}: LiveWorkMessageOptions): string {
  const header = `💭 ✻ **${effortLabel}…**`
  const cleanDetail = detail.trim()
  const cleanFooter = footer.trim()
  const suffix = cleanFooter ? `\n\n${cleanFooter}` : ''
  if (!cleanDetail) return header + suffix

  const prefix = `${header}\n`
  const available = Math.max(1, maxLength - prefix.length - suffix.length)
  const clippedDetail = cleanDetail.length > available
    ? cleanDetail.slice(0, Math.max(0, available - 1)) + '…'
    : cleanDetail
  return prefix + clippedDetail + suffix
}
