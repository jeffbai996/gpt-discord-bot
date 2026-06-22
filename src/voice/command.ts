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
  onToolCall?: (call: ToolCall) => Promise<unknown>
  log?: (msg: string) => void
}

/** Holds at most one live VoiceSession per guild. */
export class VoiceManager {
  private readonly sessions = new Map<string, VoiceSession>()
  constructor(private readonly opts: VoiceManagerOptions) {}

  has(guildId: string): boolean {
    return this.sessions.has(guildId)
  }

  async join(guildId: string, channel: Parameters<VoiceSession['join']>[0]): Promise<void> {
    if (this.sessions.has(guildId)) this.leave(guildId)
    const session = new VoiceSession({
      apiKey: this.opts.apiKey,
      instructions: this.opts.instructions,
      voice: this.opts.voice,
      tools: this.opts.tools,
      onToolCall: this.opts.onToolCall,
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
  try {
    await manager.join(interaction.guildId, channel)
    await interaction.editReply(`🎙️ In **${channel.name}** — talk to me. \`/gpt voice leave\` to stop.`)
  } catch (e) {
    manager.leave(interaction.guildId)
    await interaction.editReply(`Failed to start voice: ${(e as Error).message}`)
  }
}
