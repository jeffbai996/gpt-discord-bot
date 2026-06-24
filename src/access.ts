import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ChannelConfig {
  enabled: boolean
  requireMention: boolean
  model?: string             // override default model per-channel (gpt-5.5 | gpt-5.4-mini | o3)
  reasoning?: ReasoningEffort  // for o-series; ignored by gpt-5.x
  showCode?: boolean         // default true — render tool calls + structured outputs
  verbose?: boolean          // default true — surface usage/finish_reason footer
  trace?: boolean            // default false — post a diff-style tool-trace card
  thinking?: boolean         // default false — post the model's reasoning summary
  engine?: 'codex' | 'api'  // default codex - chat engine (codex sub vs metered api)
  counter?: 'off' | 'token' | 'both'  // footer: off | token-only | token+cached/reasoning
}

export interface ChannelFlags {
  model: string | null
  reasoning: ReasoningEffort
  showCode: boolean
  verbose: boolean
  trace: boolean
  thinking: boolean
  engine: 'codex' | 'api'
  counter: 'off' | 'token' | 'both'
  // requireMention isn't a "rendering" flag like the others — it sits at the
  // top of ChannelConfig — but exposing it through ChannelFlags lets the
  // /gpt set unified setter touch it without a separate command path.
  requireMention?: boolean
}

export interface AccessFile {
  users: Record<string, { allowed: boolean }>
  channels: Record<string, ChannelConfig>
}

export interface CanHandleInput {
  channelId: string
  userId: string
  isMention: boolean
}

const EMPTY: AccessFile = { users: {}, channels: {} }
const VALID_REASONING: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh']

const DEFAULT_FLAGS = {
  reasoning: 'high' as ReasoningEffort,
  showCode: true,
  verbose: true,
  trace: false,
  thinking: false,
  engine: 'codex' as 'codex' | 'api',
  counter: 'both' as 'off' | 'token' | 'both',
}

export class AccessManager {
  private stateDir: string
  private file: string
  private data: AccessFile = { ...EMPTY }

  constructor() {
    this.stateDir = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
    this.file = path.join(this.stateDir, 'access.json')
  }

  async load(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AccessFile>
      this.data = {
        users: parsed.users ?? {},
        channels: parsed.channels ?? {}
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        this.data = { ...EMPTY }
        await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
      } else {
        throw e
      }
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  canHandle({ channelId, userId, isMention }: CanHandleInput): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false

    const channel = this.data.channels[channelId]
    if (!channel?.enabled) return false

    if (channel.requireMention && !isMention) return false

    return true
  }

  canReact(userId: string, channelId: string): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false
    const channel = this.data.channels[channelId]
    if (!channel?.enabled) return false
    return true
  }

  isAllowedAndEnabled(userId: string, channelId: string): boolean {
    return this.canReact(userId, channelId)
  }

  async allowUser(userId: string): Promise<void> {
    this.data.users[userId] = { allowed: true }
    await this.save()
  }

  async revokeUser(userId: string): Promise<void> {
    this.data.users[userId] = { allowed: false }
    await this.save()
  }

  async setChannel(
    channelId: string,
    enabled: boolean,
    requireMention: boolean,
    flags?: Partial<ChannelFlags>
  ): Promise<void> {
    if (flags?.reasoning !== undefined && !VALID_REASONING.includes(flags.reasoning)) {
      throw new Error(`invalid reasoning effort "${flags.reasoning}" — must be one of: ${VALID_REASONING.join(', ')}`)
    }
    const existing = this.data.channels[channelId]
    this.data.channels[channelId] = {
      enabled,
      requireMention,
      ...(flags?.model != null ? { model: flags.model } : existing?.model ? { model: existing.model } : {}),
      reasoning: flags?.reasoning ?? existing?.reasoning ?? DEFAULT_FLAGS.reasoning,
      showCode: flags?.showCode ?? existing?.showCode ?? DEFAULT_FLAGS.showCode,
      verbose: flags?.verbose ?? existing?.verbose ?? DEFAULT_FLAGS.verbose,
      trace: flags?.trace ?? existing?.trace ?? DEFAULT_FLAGS.trace,
      thinking: flags?.thinking ?? existing?.thinking ?? DEFAULT_FLAGS.thinking,
      engine: flags?.engine ?? existing?.engine ?? DEFAULT_FLAGS.engine,
      counter: flags?.counter ?? existing?.counter ?? DEFAULT_FLAGS.counter,
    }
    await this.save()
  }

  async setChannelFlags(
    channelId: string,
    patch: Partial<ChannelFlags>
  ): Promise<ChannelConfig> {
    const existing = this.data.channels[channelId]
    if (!existing) {
      throw new Error(`channel ${channelId} not configured — run /gpt channel first`)
    }
    if (patch.reasoning !== undefined && !VALID_REASONING.includes(patch.reasoning)) {
      throw new Error(`invalid reasoning effort "${patch.reasoning}" — must be one of: ${VALID_REASONING.join(', ')}`)
    }
    this.data.channels[channelId] = {
      ...existing,
      // null sentinel = clear the per-channel override (back to global default).
      ...(patch.model === null ? { model: undefined } : patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
      ...(patch.showCode !== undefined ? { showCode: patch.showCode } : {}),
      ...(patch.verbose !== undefined ? { verbose: patch.verbose } : {}),
      ...(patch.trace !== undefined ? { trace: patch.trace } : {}),
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
      ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
      ...(patch.counter !== undefined ? { counter: patch.counter } : {}),
      ...(patch.requireMention !== undefined ? { requireMention: patch.requireMention } : {}),
    }
    await this.save()
    return this.data.channels[channelId]
  }

  channelFlags(channelId: string): ChannelFlags {
    const channel = this.data.channels[channelId]
    return {
      model: channel?.model ?? null,
      reasoning: channel?.reasoning ?? DEFAULT_FLAGS.reasoning,
      showCode: channel?.showCode ?? DEFAULT_FLAGS.showCode,
      verbose: channel?.verbose ?? DEFAULT_FLAGS.verbose,
      trace: channel?.trace ?? DEFAULT_FLAGS.trace,
      thinking: channel?.thinking ?? DEFAULT_FLAGS.thinking,
      engine: channel?.engine ?? DEFAULT_FLAGS.engine,
      counter: channel?.counter ?? (channel?.verbose === false ? 'off' : DEFAULT_FLAGS.counter),
      requireMention: channel?.requireMention,
    }
  }

  channelConfig(channelId: string): ChannelConfig | undefined {
    return this.data.channels[channelId]
  }
}
