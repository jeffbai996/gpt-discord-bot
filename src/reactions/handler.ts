import type { MessageReaction, PartialMessageReaction, User, PartialUser, Client, Message } from 'discord.js'
import { actionFor } from './vocabulary.ts'
import * as actions from './actions.ts'
import type { ActionContext } from './actions.ts'

export interface HandlerDeps {
  client: Client
  buildContext: (message: Message, reactor: User) => ActionContext
  access: { canReact: (userId: string, channelId: string, parentChannelId?: string | null) => boolean }
}

export async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  deps: HandlerDeps
): Promise<void> {
  // Reactions on uncached messages arrive partial; resolve before reading
  // .author or other fields.
  if (reaction.partial) {
    try { await reaction.fetch() } catch { return }
  }
  if (user.partial) {
    try { await user.fetch() } catch { return }
  }

  const message = reaction.message
  if (message.author?.id !== deps.client.user?.id) return  // not our message
  if ((user as User).bot) return                            // ignore other bots
  const parentChannelId = typeof message.channel.isThread === 'function' && message.channel.isThread()
    ? message.channel.parentId
    : null
  if (!deps.access.canReact(user.id, message.channelId, parentChannelId)) return

  const emoji = reaction.emoji.name
  if (!emoji) return
  const action = actionFor(emoji)
  if (!action) return

  const ctx = deps.buildContext(message as Message, user as User)

  try {
    switch (action) {
      case 'regenerate': await actions.regenerate(ctx); break
      case 'expand': await actions.expand(ctx); break
      case 'pin': await actions.pin(ctx); break
      case 'delete': await actions.deleteMessage(ctx); break
      case 'mute': await actions.mute(ctx); break
      case 'unmute': await actions.unmute(ctx); break
      case 'markForEdit': await actions.markForEdit(ctx); break
    }
  } catch (e) {
    console.error(`[reactions] action ${action} failed:`, e)
  }
}
