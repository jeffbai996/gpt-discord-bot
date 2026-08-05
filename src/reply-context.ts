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

export interface ThreadContext {
  kind: 'created' | 'starter'
  threadId: string
  threadName: string | null
  parentChannelId: string | null
  starterContent: string
  source: ReplyContext | null
}

interface MessageLike {
  id?: string
  type?: number
  content?: string
  channelId?: string
  channel?: unknown
  thread?: { id: string; name?: string; parentId?: string | null } | null
  reference?: { messageId?: string | null; channelId?: string | null } | null
  client?: unknown
  fetchReference(): Promise<{
    id: string
    author: { id: string; username: string; bot: boolean }
    content: string
    attachments: { values(): IterableIterator<ReplyAttachment> }
  }>
}

const cache = new WeakMap<object, Promise<ReplyContext | null>>()
const pinCache = new WeakMap<object, Promise<PinContext | null>>()
const threadCache = new WeakMap<object, Promise<ThreadContext | null>>()

const CHANNEL_PINNED_MESSAGE = 6
const THREAD_CREATED = 18
const THREAD_STARTER_MESSAGE = 21

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
  if ([CHANNEL_PINNED_MESSAGE, THREAD_CREATED, THREAD_STARTER_MESSAGE].includes(message.type ?? -1)) {
    return Promise.resolve(null)
  }
  if (!message.reference?.messageId) return Promise.resolve(null)
  const cached = cache.get(message as object)
  if (cached) return cached

  const pending = fetchReferencedMessage(message)
  cache.set(message as object, pending)
  return pending
}

export function resolveThreadContext(message: MessageLike): Promise<ThreadContext | null> {
  if (message.type !== THREAD_CREATED && message.type !== THREAD_STARTER_MESSAGE) {
    return Promise.resolve(null)
  }
  const cached = threadCache.get(message as object)
  if (cached) return cached

  const pending = (async (): Promise<ThreadContext | null> => {
    const channel = message.channel as { name?: string; parentId?: string | null } | null | undefined
    const client = message.client as { channels?: { fetch(id: string): Promise<{ id: string; name?: string; parentId?: string | null } | null> } } | undefined
    if (message.type === THREAD_CREATED) {
      const threadId = message.thread?.id ?? message.reference?.channelId ?? message.id
      if (!threadId) return null
      let threadName = message.thread?.name ?? null
      let parentChannelId = message.thread?.parentId ?? message.channelId ?? null
      if (!threadName && client?.channels) {
        const thread = await client.channels.fetch(threadId).catch(() => null)
        threadName = thread?.name ?? null
        parentChannelId = thread?.parentId ?? parentChannelId
      }
      return {
        kind: 'created', threadId, threadName, parentChannelId,
        starterContent: message.content ?? '', source: null,
      }
    }

    const source = message.reference?.messageId ? await fetchReferencedMessage(message) : null
    return {
      kind: 'starter',
      threadId: message.channelId ?? message.id ?? 'unknown',
      threadName: channel?.name ?? null,
      parentChannelId: channel?.parentId ?? message.reference?.channelId ?? null,
      starterContent: '',
      source,
    }
  })()
  threadCache.set(message as object, pending)
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

export function formatThreadContext(context: ThreadContext | null): string {
  if (!context) return ''
  const thread = {
    thread_id: context.threadId,
    thread_name: context.threadName,
    parent_channel_id: context.parentChannelId,
  }
  if (context.kind === 'created') {
    return '[Discord thread event — the user created a thread]\n'
      + JSON.stringify({ ...thread, starter_content: context.starterContent })
  }
  return '[Discord thread starter — this thread was created from an earlier message]\n'
    + JSON.stringify({
      ...thread,
      source_message: context.source ? {
        message_id: context.source.messageId,
        author: context.source.authorName,
        author_id: context.source.authorId,
        content: context.source.content,
        attachments: context.source.attachments.map(({ name, contentType, size }) => ({
          name, content_type: contentType, size,
        })),
      } : null,
      source_unavailable: !context.source,
    })
}
