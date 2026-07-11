interface LiveWorkMessageOptions {
  effortLabel: string
  detail?: string
  footer?: string
  maxLength?: number
}

function quoteDetail(text: string): string {
  return text.split('\n').map(line => `> ${line}`).join('\n')
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

  const prefix = `${header}\n\n`
  const quoteOverhead = cleanDetail.split('\n').length * 2
  const available = Math.max(1, maxLength - prefix.length - suffix.length - quoteOverhead)
  const clippedDetail = cleanDetail.length > available
    ? cleanDetail.slice(0, Math.max(0, available - 1)) + '…'
    : cleanDetail
  return prefix + quoteDetail(clippedDetail) + suffix
}
