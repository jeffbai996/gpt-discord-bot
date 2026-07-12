/**
 * `/gpt voice …` subcommand group + per-guild session manager.
 *
 * /gpt voice join         — bot joins YOUR voice channel, starts realtime v2v
 * /gpt voice leave        — bot leaves and tears the session down
 * /gpt voice speak <text> — say a specific line verbatim (text -> voice-back)
 *
 * Lives under /gpt (not a standalone /voice) so all bot controls share one
 * command surface. Owner-gated: realtime voice is billed per audio-minute.
 */

import type {
  ChatInputCommandInteraction, GuildMember, SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js'

import { VoiceSession } from './session.ts'
import type { RealtimeTool, ToolCall } from './realtime.ts'
import type { PersonaLoader } from '../persona.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { DeferredToolJob } from '../tools/registry.ts'

// Appended to the bot's real persona for a live call. Mirrors gemma's voice
// override: the text persona's "stay silent / opt out" etiquette is a bug on a
// call (the first smoke test made the model conclude silence was polite → mute
// bot), so suspend it and demand short, spoken, tool-aware replies.
const VOICE_OVERRIDE = `
IMPORTANT — you are on a LIVE VOICE CALL right now. Any rules above about staying \
silent, opting out of replies, or skipping acknowledgments apply ONLY to text \
channels and are suspended for this call. On a call, silence is a malfunction: \
ALWAYS respond out loud to anything the speaker says, including greetings, mic \
tests, and small talk. Keep replies short, natural, and conversational — you are \
speaking, not writing. No markdown, no lists, no emoji. You can use tools, but \
keep the conversation flowing: don't announce that you're searching, just answer \
once you have the result. For substantial coding, repository, testing, commit, \
or deployment work, call codex_helper with a self-contained order. It returns \
immediately: briefly say the job is running and keep talking normally. When its \
background completion arrives, report the actual outcome out loud without \
pretending you did work that the result does not confirm.`.trim()

// Tools too slow for a live call (multi-second = dead air that feels broken).
// Excluded from what the voice model is OFFERED — still dispatchable if somehow
// named. Comma-separated override via GPT_VOICE_TOOL_DENY (default: codex).
const VOICE_TOOL_DENY = new Set(
  (process.env.GPT_VOICE_TOOL_DENY ?? 'codex')
    .split(',').map(s => s.trim()).filter(Boolean),
)

/** Attach the `voice` subcommand group to the existing /gpt command builder. */
export function addVoiceGroup(cmd: SlashCommandSubcommandsOnlyBuilder): void {
  cmd.addSubcommandGroup(g =>
    g.setName('voice').setDescription('Realtime voice (OpenAI)')
      .addSubcommand(s => s.setName('join').setDescription('Join your voice channel and start talking'))
      .addSubcommand(s => s.setName('leave').setDescription('Leave the voice channel'))
      .addSubcommand(s => s.setName('speak').setDescription('Say a specific line out loud')
        .addStringOption(o => o.setName('text').setDescription('What to say').setRequired(true))))
}

export interface VoiceManagerOptions {
  apiKey: string
  adminUserId: string
  instructions?: string
  voice?: string
  tools?: RealtimeTool[]
  onToolCall?: (call: ToolCall, defer: (job: DeferredToolJob) => void) => Promise<unknown>
  log?: (msg: string) => void
}

/** Holds at most one live VoiceSession per guild. */
export class VoiceManager {
  private readonly sessions = new Map<string, VoiceSession>()
  constructor(private readonly opts: VoiceManagerOptions) {}

  has(guildId: string): boolean {
    return this.sessions.has(guildId)
  }

  async join(
    guildId: string,
    channel: Parameters<VoiceSession['join']>[0],
    // Per-join overrides — the live persona + tools + dispatch are built at
    // join time (they depend on the channel/guild), overriding any constructor
    // defaults. Falls back to the constructor opts when not supplied.
    overrides?: Pick<VoiceManagerOptions, 'instructions' | 'tools' | 'onToolCall'>,
  ): Promise<void> {
    if (this.sessions.has(guildId)) this.leave(guildId)
    const session = new VoiceSession({
      apiKey: this.opts.apiKey,
      instructions: overrides?.instructions ?? this.opts.instructions,
      voice: this.opts.voice,
      tools: overrides?.tools ?? this.opts.tools,
      onToolCall: overrides?.onToolCall ?? this.opts.onToolCall,
      log: this.opts.log,
    })
    this.sessions.set(guildId, session)
    try {
      await session.join(channel)
    } catch (e) {
      this.sessions.delete(guildId)
      throw e
    }
  }

  leave(guildId: string): boolean {
    const session = this.sessions.get(guildId)
    if (!session) return false
    session.leave()
    this.sessions.delete(guildId)
    return true
  }

  /** Speak a specific line in the active session. Returns false if not joined. */
  async speak(guildId: string, text: string): Promise<boolean> {
    const session = this.sessions.get(guildId)
    if (!session) return false
    await session.speakText(text)
    return true
  }

  leaveAll(): void {
    for (const id of [...this.sessions.keys()]) this.leave(id)
  }
}

export async function executeVoiceCommand(
  interaction: ChatInputCommandInteraction,
  manager: VoiceManager,
  adminUserId: string,
  persona: PersonaLoader,
  toolRegistry: ToolRegistry,
): Promise<void> {
  if (interaction.user.id !== adminUserId) {
    await interaction.reply({ content: 'Voice is owner-only (billed per minute).', ephemeral: true })
    return
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Voice only works in a server channel.', ephemeral: true })
    return
  }

  const sub = interaction.options.getSubcommand()

  if (sub === 'leave') {
    const left = manager.leave(interaction.guildId)
    await interaction.reply({ content: left ? '👋 Left voice.' : 'Not in a voice channel.', ephemeral: true })
    return
  }

  if (sub === 'speak') {
    const text = interaction.options.getString('text', true)
    await interaction.reply({ content: '🗣️ Speaking…', ephemeral: true })
    try {
      const spoke = await manager.speak(interaction.guildId, text)
      await interaction.editReply(spoke ? '🗣️ Done.' : 'Not in a voice channel — run `/gpt voice join` first.')
    } catch (e) {
      await interaction.editReply(`Speak failed: ${(e as Error).message}`)
    }
    return
  }

  // join
  const member = interaction.member as GuildMember | null
  const channel = member?.voice?.channel
  if (!channel) {
    await interaction.reply({ content: 'Join a voice channel first, then run `/gpt voice join`.', ephemeral: true })
    return
  }
  await interaction.reply({ content: `🎙️ Joining **${channel.name}**…`, ephemeral: true })
  // Build the live session's brain at join time: the bot's real persona for this
  // channel/guild + the voice override, the real tool registry (minus slow tools),
  // and a dispatch closure that runs tool calls through the same registry the text
  // bot uses. This is what makes voice-gpt speak as gpt and use gpt's tools.
  const instructions =
    `${persona.buildSystemPrompt(interaction.channelId, interaction.guildId)}\n\n---\n\n${VOICE_OVERRIDE}`
  const tools = toolRegistry.toRealtimeTools().filter(t => !VOICE_TOOL_DENY.has(t.name))
  const ctx = { channelId: interaction.channelId, userId: interaction.user.id }
  const onToolCall = async (
    call: ToolCall,
    defer: (job: DeferredToolJob) => void,
  ): Promise<unknown> => {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(call.argsJson || '{}') } catch { /* malformed args → {} */ }
    return await toolRegistry.dispatch(call.name, args, { ...ctx, defer })
  }
  try {
    await manager.join(interaction.guildId, channel, { instructions, tools, onToolCall })
    await interaction.editReply(`🎙️ In **${channel.name}** — talk to me. \`/gpt voice leave\` to stop.`)
  } catch (e) {
    manager.leave(interaction.guildId)
    await interaction.editReply(`Failed to start voice: ${(e as Error).message}`)
  }
}
