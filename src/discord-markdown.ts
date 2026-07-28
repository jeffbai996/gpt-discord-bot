// Prevent one missing inline-code delimiter from swallowing the rest of a
// Discord reply. Multiline inline code is not useful Discord markup, so close
// an unmatched span at the line boundary while leaving fenced blocks alone.
export function closeDanglingInlineCode(text: string): string {
  let inFence = false

  return text.split('\n').map((line) => {
    let inlineTicks = 0
    for (let i = 0; i < line.length; i += 1) {
      if (line.startsWith('```', i)) {
        inFence = !inFence
        i += 2
        continue
      }
      if (!inFence && line[i] === '`' && line[i - 1] !== '\\') inlineTicks += 1
    }
    return !inFence && inlineTicks % 2 === 1 ? `${line}\`` : line
  }).join('\n')
}
