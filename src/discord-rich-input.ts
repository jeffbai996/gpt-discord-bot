import type { AttachmentInput } from './attachments.ts'

interface MediaAsset {
  url?: string | null
  proxyURL?: string | null
  contentType?: string | null
}

interface ValueIterable<T> {
  values(): IterableIterator<T>
}

interface RichMessageLike {
  content?: string | null
  embeds?: ValueIterable<{
    title?: string | null
    description?: string | null
    url?: string | null
    provider?: { name?: string | null } | null
    thumbnail?: MediaAsset | null
    image?: MediaAsset | null
    video?: MediaAsset | null
  }> | null
  stickers?: ValueIterable<{
    id: string
    name: string
    format?: number
    url?: string
  }> | null
  attachments?: ValueIterable<{
    name: string
    url: string
    size: number
    contentType: string | null
  }> | null
  messageSnapshots?: ValueIterable<RichMessageLike> | null
  poll?: {
    question?: { text?: string | null } | null
    answers?: ValueIterable<{
      id?: number
      text?: string | null
      voteCount?: number
      emoji?: { name?: string | null } | null
    }> | null
    allowMultiselect?: boolean
    expiresTimestamp?: number | null
    resultsFinalized?: boolean
  } | null
}

function iterable<T>(value: ValueIterable<T> | null | undefined): T[] {
  return value ? [...value.values()] : []
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i)
    return match?.[1]?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

function mimeFromUrl(url: string, fallback = 'image/png'): string {
  const ext = extensionFromUrl(url)
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'mp4' || ext === 'webm') return `video/${ext}`
  if (ext === 'png') return 'image/png'
  return fallback
}

function stickerExtension(format?: number): string | null {
  if (format === 4) return 'gif'
  if (format === 3) return null // Lottie JSON needs a renderer; keep metadata only.
  return 'png' // PNG and APNG both use Discord's .png endpoint.
}

function mediaName(prefix: string, url: string, fallbackExt = 'png'): string {
  return `${prefix}.${extensionFromUrl(url) || fallbackExt}`
}

function addUnique(out: AttachmentInput[], seen: Set<string>, attachment: AttachmentInput): void {
  if (!attachment.url || seen.has(attachment.url)) return
  seen.add(attachment.url)
  out.push(attachment)
}

/**
 * Turn Discord's non-attachment visual surfaces into ordinary attachment
 * inputs. In particular, pasted Discord CDN GIFs carry a dead/unsigned URL in
 * message.content while the embed contains a freshly signed proxy URL.
 */
export function extractRichMedia(message: RichMessageLike): AttachmentInput[] {
  const out: AttachmentInput[] = []
  const seen = new Set<string>()

  const visit = (source: RichMessageLike, snapshot = false) => {
    // Root attachments already flow through message.attachments. Snapshot
    // attachments do not, so recover only those here and avoid duplicate input.
    if (snapshot) for (const attachment of iterable(source.attachments)) {
        addUnique(out, seen, {
          name: attachment.name,
          url: attachment.url,
          size: attachment.size,
          contentType: attachment.contentType,
        })
      }

    for (const sticker of iterable(source.stickers)) {
      const ext = stickerExtension(sticker.format)
      if (!ext) continue
      const url = sticker.url || `https://cdn.discordapp.com/stickers/${sticker.id}.${ext}`
      addUnique(out, seen, {
        name: `sticker-${sticker.name}.${ext}`,
        url,
        size: 0,
        contentType: ext === 'gif' ? 'image/gif' : 'image/png',
      })
    }

    for (const [index, embed] of iterable(source.embeds).entries()) {
      // gifv embeds expose an MP4 plus a still thumbnail. Prefer motion; the
      // attachment pipeline samples video/GIF frames into a contact sheet.
      const asset = embed.video ?? embed.image ?? embed.thumbnail
      const url = asset?.proxyURL ?? asset?.url
      if (!url) continue
      const mime = asset?.contentType ?? mimeFromUrl(url, embed.video ? 'video/mp4' : 'image/png')
      addUnique(out, seen, {
        name: mediaName(`${snapshot ? 'forwarded-' : ''}embed-${index + 1}`, url, mime === 'video/mp4' ? 'mp4' : 'png'),
        url,
        size: 0,
        contentType: mime,
      })
    }

    for (const forwarded of iterable(source.messageSnapshots)) visit(forwarded, true)
  }

  visit(message)
  return out
}

export function formatRichContext(message: RichMessageLike): string {
  const blocks: string[] = []
  const stickers = iterable(message.stickers)
  if (stickers.length) {
    blocks.push('[Discord stickers — actual visual media is attached]\n' + stickers
      .map(sticker => `- ${sticker.name} (id ${sticker.id})`)
      .join('\n'))
  }

  const snapshots = iterable(message.messageSnapshots)
  for (const snapshot of snapshots) {
    const embeds = iterable(snapshot.embeds)
    blocks.push('[Discord forwarded-message snapshot — original author is unavailable]\n' + JSON.stringify({
      content: snapshot.content ?? '',
      attachments: iterable(snapshot.attachments).map(att => ({ name: att.name, content_type: att.contentType, size: att.size })),
      stickers: iterable(snapshot.stickers).map(sticker => ({ id: sticker.id, name: sticker.name })),
      embeds: embeds.map(embed => ({
        title: embed.title ?? null,
        description: embed.description ?? null,
        provider: embed.provider?.name ?? null,
        url: embed.url ?? null,
      })),
    }))
  }

  const poll = message.poll
  if (poll) {
    blocks.push('[Discord poll]\n' + JSON.stringify({
      question: poll.question?.text ?? '',
      answers: iterable(poll.answers).map(answer => ({
        id: answer.id ?? null,
        emoji: answer.emoji?.name ?? null,
        text: answer.text ?? '',
        votes: answer.voteCount ?? null,
      })),
      allow_multiselect: Boolean(poll.allowMultiselect),
      expires_at: poll.expiresTimestamp ? new Date(poll.expiresTimestamp).toISOString() : null,
      results_finalized: Boolean(poll.resultsFinalized),
    }))
  }

  return blocks.join('\n\n')
}
