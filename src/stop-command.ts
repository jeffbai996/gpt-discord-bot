export function isHardStopMessage(content: string): boolean {
  const normalized = content.trim().replace(/\uFE0F/g, '')
  return normalized === '❌' || normalized.toLowerCase() === 'x'
}
