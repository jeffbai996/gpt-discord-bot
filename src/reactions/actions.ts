import type { Message, User, Client } from 'discord.js'
import type { AccessManager } from '../access.ts'
import type { PersonaLoader } from '../persona.ts'
import type { PendingEditsStore } from './pending-edits.ts'
import type { PinnedFactsStore } from '../pinned-facts.ts'

export interface ActionContext {
  message: Message       // the bot message that was reacted to
  reactor: User
  client: Client
  access: AccessManager
  persona: PersonaLoader
  pendingEdits: PendingEditsStore
  pinnedFacts: PinnedFactsStore
  // Re-runs the message-handling pipeline against an earlier user message.
  // - targetMessage non-null → edit that bot message in place rather than
  //   posting a fresh reply (used by 🔁 regenerate so the chat doesn't clutter).
  // - expansion=true → inject a "go deeper / add detail" preamble so the model
  //   produces a follow-up rather than a re-roll (used by 🔍 expand).
  rerunHandler: (
    originalUserMessage: Message,
    targetMessage: Message | null,
    expansion: boolean
  ) => Promise<void>
}

export async function pin(ctx: ActionContext): Promise<void> {
  const channelName = (ctx.message.channel as any).name ?? 'dm'
  await ctx.pinnedFacts.append(ctx.message.channelId, channelName, ctx.message.content)
  await ctx.message.react('✅').catch(() => {})
}

export async function deleteMessage(ctx: ActionContext): Promise<void> {
  await ctx.message.delete().catch(e => console.error('[reactions] delete failed:', e))
}

export async function mute(ctx: ActionContext): Promise<void> {
  // Mute = require explicit mention to engage. Preserves all other channel
  // flags (model override, reasoning, trace, thinking, counter, engine).
  const channel = ctx.access.channelConfig(ctx.message.channelId)
  if (!channel) return  // never been configured; nothing to mute
  await ctx.access.setChannel(ctx.message.channelId, true, true, ctx.access.channelFlags(ctx.message.channelId))
  await ctx.message.react('🤐').catch(() => {})
}

export async function unmute(ctx: ActionContext): Promise<void> {
  const channel = ctx.access.channelConfig(ctx.message.channelId)
  if (!channel) return
  await ctx.access.setChannel(ctx.message.channelId, true, false, ctx.access.channelFlags(ctx.message.channelId))
  await ctx.message.react('🗣️').catch(() => {})
}

export async function markForEdit(ctx: ActionContext): Promise<void> {
  ctx.pendingEdits.set(ctx.message.channelId, ctx.message.id)
  await ctx.message.react('⏳').catch(() => {})
}

export async function regenerate(ctx: ActionContext): Promise<void> {
  const original = await ctx.message.fetchReference().catch(() => null)
  if (!original) {
    await ctx.message.react('🤷').catch(() => {})
    return
  }
  await ctx.rerunHandler(original, ctx.message, false)
}

export async function expand(ctx: ActionContext): Promise<void> {
  const original = await ctx.message.fetchReference().catch(() => null)
  if (!original) {
    await ctx.message.react('🤷').catch(() => {})
    return
  }
  await ctx.rerunHandler(original, null, true)
}
