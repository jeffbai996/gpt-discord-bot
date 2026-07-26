export const QUEUED_REACTION = '\u{1F557}'

interface RemovableReaction {
  users: {
    remove(userId: string): Promise<unknown>
  }
}

export interface QueueMarkerMessage {
  id: string
  react(emoji: string): Promise<RemovableReaction>
  reactions: {
    cache: {
      get(emoji: string): RemovableReaction | undefined
    }
  }
}

interface MarkedMessage {
  message: QueueMarkerMessage
  reaction?: RemovableReaction
}

/** Keeps exactly one bot-owned queue clock on the newest waiting message. */
export class LatestQueueMarker {
  private readonly latest = new Map<string, MarkedMessage>()
  private readonly operations = new Map<string, Promise<void>>()

  constructor(private readonly botUserId: () => string | undefined) {}

  mark(channelId: string, message: QueueMarkerMessage): Promise<void> {
    const previous = this.latest.get(channelId)
    const current: MarkedMessage = { message }
    this.latest.set(channelId, current)
    return this.schedule(channelId, async () => {
      await this.remove(previous)
      try {
        current.reaction = await message.react(QUEUED_REACTION)
      } catch {
        // Queue visibility is best-effort; generation must never fail with it.
      }
    })
  }

  clear(channelId: string): Promise<void> {
    const current = this.latest.get(channelId)
    this.latest.delete(channelId)
    return this.schedule(channelId, () => this.remove(current))
  }

  private schedule(channelId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(channelId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.operations.set(channelId, next)
    void next.finally(() => {
      if (this.operations.get(channelId) === next) this.operations.delete(channelId)
    })
    return next
  }

  private async remove(marked: MarkedMessage | undefined): Promise<void> {
    const botId = this.botUserId()
    if (!marked || !botId) return
    const reaction = marked.reaction ?? marked.message.reactions.cache.get(QUEUED_REACTION)
    try {
      await reaction?.users.remove(botId)
    } catch {
      // Stale/deleted messages should not block the queued turn.
    }
  }
}
