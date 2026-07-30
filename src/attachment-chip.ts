import type { AttachmentInput, ProcessedAttachments } from './attachments.ts'

function shortCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value)
}

export function formatAttachmentChip(
  attachments: AttachmentInput[],
  result: ProcessedAttachments,
): string {
  const skipped = new Map(result.skipped.map(item => [item.name, item.reason]))
  return attachments.map(attachment => {
    const failure = skipped.get(attachment.name)
    if (failure) {
      const label = failure === 'too_large' ? 'too large'
        : failure === 'unsupported_type' ? 'unsupported'
        : failure === 'transcription_failed' ? 'transcription failed'
        : 'ingest failed'
      return `⚠️ ${attachment.name} · ${label}`
    }
    if (result.imageNames.includes(attachment.name)) {
      return `📎 ${attachment.name} · vision ready`
    }
    const transcript = result.transcripts.find(item => item.name === attachment.name)
    if (transcript) return `🎙️ ${attachment.name} · ${shortCount(transcript.characters)} chars transcribed`
    const document = result.documents.find(item => item.name === attachment.name)
    if (document) return `📄 ${attachment.name} · ${shortCount(document.characters)} chars extracted`
    return `📎 ${attachment.name} · ready`
  }).join('\n')
}
