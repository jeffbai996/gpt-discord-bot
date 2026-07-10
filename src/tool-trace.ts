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
