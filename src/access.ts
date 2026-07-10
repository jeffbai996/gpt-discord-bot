import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { DEFAULT_CODEX_MODEL, OPENAI_MODELS, type OpenAIModel } from './models.ts'

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ChannelConfig {
  enabled: boolean
  requireMention: boolean
  reasoning?: ReasoningEffort
  trace?: 'off' | 'on' | 'collapse'      // default off — diff-style tool-trace card
  thinking?: 'off' | 'on' | 'collapse'   // default off — reasoning-summary card
  engine?: 'codex' | 'api'  // default codex - chat engine (codex sub vs metered api)
  codexModel?: CodexModel  // default gpt-5.6-sol — codex engine model only
  counter?: 'off' | 'token' | 'both'  // footer: off | token-only | token+cached/reasoning
}

export interface ChannelFlags {
  // NOTE: there is intentionally NO per-channel API `model` override. The API
  // engine's model is env-driven (DEFAULT_MODEL / GPT_MODEL), matching gemma's
  // API model. /gpt model sets codexModel (the codex engine). (Jeff 2026-06-29:
  // removed the orphaned `model` field that had no slash setter.)
  reasoning: ReasoningEffort
  trace: 'off' | 'on' | 'collapse'
  thinking: 'off' | 'on' | 'collapse'
  engine: 'codex' | 'api'
  codexModel: CodexModel
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

// trace/thinking went boolean -> 'off'|'on'|'collapse'. Old saved configs may still
// hold a boolean — map false->off, true->on so a legacy `false` doesn't read as "on".
type TriState = 'off' | 'on' | 'collapse'
function normTri(v: unknown): TriState {
  if (v === true) return 'on'
  if (v === false || v == null) return 'off'
  return (v === 'on' || v === 'collapse') ? v : 'off'
}

function normCodexModel(v: unknown): CodexModel {
  return (typeof v === 'string' && (CODEX_MODELS as readonly string[]).includes(v))
    ? v as CodexModel
    : DEFAULT_FLAGS.codexModel
}

// Keep codex/API model choices aligned. The API slug is explicitly `gpt-5.6-sol`;
// `gpt-5.6` is not a valid alias. Retired choices are intentionally excluded
// so old saved channel config normalizes back to the default.
export const CODEX_MODELS = OPENAI_MODELS
export type CodexModel = OpenAIModel

const DEFAULT_FLAGS = {
  reasoning: 'high' as ReasoningEffort,
  trace: 'off' as 'off' | 'on' | 'collapse',
  thinking: 'off' as 'off' | 'on' | 'collapse',
  engine: 'codex' as 'codex' | 'api',
  codexModel: DEFAULT_CODEX_MODEL as CodexModel,
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
      reasoning: flags?.reasoning ?? existing?.reasoning ?? DEFAULT_FLAGS.reasoning,
      trace: normTri(flags?.trace ?? existing?.trace ?? DEFAULT_FLAGS.trace),
      thinking: normTri(flags?.thinking ?? existing?.thinking ?? DEFAULT_FLAGS.thinking),
      engine: flags?.engine ?? existing?.engine ?? DEFAULT_FLAGS.engine,
      codexModel: normCodexModel(flags?.codexModel ?? existing?.codexModel),
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
    if (patch.codexModel !== undefined && !(CODEX_MODELS as readonly string[]).includes(patch.codexModel)) {
      throw new Error(`invalid codex model "${patch.codexModel}" — must be one of: ${CODEX_MODELS.join(', ')}`)
    }
    this.data.channels[channelId] = {
      ...existing,
      ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
      ...(patch.trace !== undefined ? { trace: patch.trace } : {}),
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
      ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
      ...(patch.codexModel !== undefined ? { codexModel: normCodexModel(patch.codexModel) } : {}),
      ...(patch.counter !== undefined ? { counter: patch.counter } : {}),
      ...(patch.requireMention !== undefined ? { requireMention: patch.requireMention } : {}),
    }
    await this.save()
    return this.data.channels[channelId]
  }

  channelFlags(channelId: string): ChannelFlags {
    const channel = this.data.channels[channelId]
    return {
      reasoning: channel?.reasoning ?? DEFAULT_FLAGS.reasoning,
      trace: channel?.trace ?? DEFAULT_FLAGS.trace,
      thinking: channel?.thinking ?? DEFAULT_FLAGS.thinking,
      engine: channel?.engine ?? DEFAULT_FLAGS.engine,
      codexModel: normCodexModel(channel?.codexModel),
      counter: channel?.counter ?? DEFAULT_FLAGS.counter,
      requireMention: channel?.requireMention,
    }
  }

  channelConfig(channelId: string): ChannelConfig | undefined {
    return this.data.channels[channelId]
  }
}
