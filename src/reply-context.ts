export interface ReplyAttachment {
  name: string
  url: string
  size: number
  contentType: string | null
}

export interface ReplyContext {
  messageId: string
  authorId: string
  authorName: string
  authorIsBot: boolean
  content: string
  attachments: ReplyAttachment[]
}

interface MessageLike {
  reference?: { messageId?: string | null } | null
  fetchReference(): Promise<{
    id: string
    author: { id: string; username: string; bot: boolean }
    content: string
    attachments: { values(): IterableIterator<ReplyAttachment> }
  }>
}

const cache = new WeakMap<object, Promise<ReplyContext | null>>()

export function resolveReplyContext(message: MessageLike): Promise<ReplyContext | null> {
  if (!message.reference?.messageId) return Promise.resolve(null)
  const cached = cache.get(message as object)
  if (cached) return cached

  const pending = message.fetchReference()
    .then(referenced => ({
      messageId: referenced.id,
      authorId: referenced.author.id,
      authorName: referenced.author.username,
      authorIsBot: referenced.author.bot,
      content: referenced.content,
      attachments: [...referenced.attachments.values()].map(att => ({
        name: att.name,
        url: att.url,
        size: att.size,
        contentType: att.contentType,
      })),
    }))
    .catch(() => null)
  cache.set(message as object, pending)
  return pending
}

export function formatReplyContext(context: ReplyContext | null): string {
  if (!context) return ''
  return '[Discord reply context — the user explicitly replied to this earlier message]\n'
    + JSON.stringify({
      message_id: context.messageId,
      author: context.authorName,
      author_id: context.authorId,
      content: context.content,
      attachments: context.attachments.map(att => ({
        name: att.name,
        content_type: att.contentType,
        size: att.size,
      })),
    })
}
