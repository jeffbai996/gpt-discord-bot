// Splits text into Discord-postable chunks (default 2000-char limit), preserving
// fenced code blocks across the split by closing + reopening with the same lang.
export function chunk(text: string, limit: number = 2000, mode: 'length' | 'newline' = 'newline'): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  let activeCodeLanguage: string | null = null
  let inCodeBlock = false

  while (remaining.length > 0) {
    // Continuation fences are rendering wrappers, not authored input. Keep them
    // out of `remaining` so they cannot flip the parser state on the next page.
    const opener = inCodeBlock
      ? `\`\`\`${activeCodeLanguage ?? ''}\n`
      : ''

    if (opener.length + remaining.length <= limit) {
      chunks.push(opener + remaining)
      break
    }

    // Reserve the worst-case boundary closer (newline + three backticks). This
    // costs four characters on prose pages but guarantees a later fence opened
    // inside this page can still be closed without exceeding Discord's cap.
    const bodyLimit = limit - opener.length - 4
    let splitAt = -1

    if (mode === 'newline') {
      const dbl = remaining.lastIndexOf('\n\n', bodyLimit)
      if (dbl > bodyLimit * 0.5) splitAt = dbl + 2

      if (splitAt === -1) {
        const sgl = remaining.lastIndexOf('\n', bodyLimit)
        if (sgl > bodyLimit * 0.5) splitAt = sgl + 1
      }

      if (splitAt === -1) {
        const sp = remaining.lastIndexOf(' ', bodyLimit)
        if (sp > 0) splitAt = sp + 1
      }
    }

    if (splitAt === -1) splitAt = bodyLimit

    let body = remaining.slice(0, splitAt)
    remaining = remaining.slice(splitAt)

    const backtickRegex = /```(.*?)(\n|$)/g
    let match: RegExpExecArray | null
    while ((match = backtickRegex.exec(body)) !== null) {
      inCodeBlock = !inCodeBlock
      if (inCodeBlock) {
        activeCodeLanguage = match[1].trim()
      } else {
        activeCodeLanguage = null
      }
    }

    if (inCodeBlock) {
      if (!body.endsWith('\n')) body += '\n'
      body += '```'
    }

    chunks.push(opener + body)
  }

  return chunks
}
