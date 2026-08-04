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

export interface PinContext {
  messageId: string
  message: ReplyContext | null
}

interface MessageLike {
  type?: number
  reference?: { messageId?: string | null } | null
  fetchReference(): Promise<{
    id: string
    author: { id: string; username: string; bot: boolean }
    content: string
    attachments: { values(): IterableIterator<ReplyAttachment> }
  }>
}

const cache = new WeakMap<object, Promise<ReplyContext | null>>()
const pinCache = new WeakMap<object, Promise<PinContext | null>>()

const CHANNEL_PINNED_MESSAGE = 6

async function fetchReferencedMessage(message: MessageLike): Promise<ReplyContext | null> {
  return message.fetchReference().then(referenced => ({
    messageId: referenced.id,
    authorId: referenced.author.id,
    authorName: referenced.author.username,
    authorIsBot: referenced.author.bot,
    content: referenced.content,
    attachments: [...referenced.attachments.values()].map(att => ({ ...att })),
  })).catch(() => null)
}

export function resolveReplyContext(message: MessageLike): Promise<ReplyContext | null> {
  if (message.type === CHANNEL_PINNED_MESSAGE) return Promise.resolve(null)
  if (!message.reference?.messageId) return Promise.resolve(null)
  const cached = cache.get(message as object)
  if (cached) return cached

  const pending = fetchReferencedMessage(message)
  cache.set(message as object, pending)
  return pending
}

export function resolvePinContext(message: MessageLike): Promise<PinContext | null> {
  if (message.type !== CHANNEL_PINNED_MESSAGE || !message.reference?.messageId) {
    return Promise.resolve(null)
  }
  const cached = pinCache.get(message as object)
  if (cached) return cached
  const messageId = message.reference.messageId
  const pending = fetchReferencedMessage(message).then(referenced => ({ messageId, message: referenced }))
  pinCache.set(message as object, pending)
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

export function formatPinContext(context: PinContext | null): string {
  if (!context) return ''
  if (!context.message) {
    return `[Discord pin event — the user pinned message ${context.messageId}, but its content is unavailable]`
  }
  return '[Discord pin event — the user pinned this message]\n'
    + JSON.stringify({
      message_id: context.message.messageId,
      author: context.message.authorName,
      author_id: context.message.authorId,
      content: context.message.content,
      attachments: context.message.attachments.map(({ name, contentType, size }) => ({
        name, content_type: contentType, size,
      })),
    })
}
