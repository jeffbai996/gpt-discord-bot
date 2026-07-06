export function stripToolTraceCard(t: string): string {
  if (!t) return t

  const unquote = (line: string): string => line.replace(/^(?:>\s?)*/, '').trimEnd()
  const isTraceHeader = (line: string): boolean => {
    const bare = unquote(line).trim()
    return /^(?:🔧\s*)?\*{0,2}Tool trace(?: \d+\/\d+)?\*{0,2}(?:\s+\(edited\))?$/i.test(bare)
  }
  const isFence = (line: string): boolean => /^```(?:diff)?\s*$/i.test(unquote(line).trim())
  const isTraceBodyLine = (line: string): boolean => {
    const bare = unquote(line).trimEnd()
    return bare === ''
      || /^diff$/i.test(bare)
      || /^[+-]\s*●\s+/.test(bare)
      || /^\s*⎿\s+/.test(bare)
      || /^\.\.\. \(\d+ more lines\)$/.test(bare)
      || /^[+-](?!#)/.test(bare)
  }

  const lines = t.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    // Continuation cards have no "Tool trace" header — they open straight on a
    // ```diff fence whose body is trace rows (Jeff 2026-07-05 pagination change).
    // Treat a bare trace fence as a headerless trace card so history still drops it.
    const isTraceRow = (line: string): boolean => {
      const bare = unquote(line).trimEnd()
      return /^[+-]\s*●\s+/.test(bare) || /^\s*⎿\s+/.test(bare)
    }
    const bareTraceFence = isFence(lines[i])
      && i + 1 < lines.length
      && isTraceRow(lines[i + 1])
    if (isTraceHeader(lines[i]) || bareTraceFence) {
      if (isTraceHeader(lines[i])) i++
      while (i < lines.length) {
        if (isFence(lines[i])) {
          i++
          while (i < lines.length && !isFence(lines[i])) i++
          if (i < lines.length) i++
          break
        }
        if (isTraceHeader(lines[i])) {
          i++
          continue
        }
        if (isTraceBodyLine(lines[i])) {
          i++
          continue
        }
        if (lines[i].startsWith('>')) { i++; continue }
        break
      }
      while (i < lines.length && lines[i].trim() === '') i++
      continue
    }
    out.push(lines[i])
    i++
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
