export function steeredMarker(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `↪ **Steered after ${minutes ? `${minutes}m ` : ''}${rest}s**`
}

export function renderSteeredMessage(content: string, elapsedMs: number): string {
  const [, ...rest] = content.split('\n')
  return [steeredMarker(elapsedMs), ...rest].join('\n').trim()
}
