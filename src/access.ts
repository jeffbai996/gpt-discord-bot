import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { DEFAULT_CODEX_MODEL, OPENAI_MODELS, type OpenAIModel } from './models.ts'

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type ThinkingMode = 'off' | 'on' | 'live' | 'collapse'
export type TraceMode = 'off' | 'on' | 'live' | 'collapse'

export interface ChannelConfig {
  enabled: boolean
  requireMention: boolean
  reasoning?: ReasoningEffort
  trace?: TraceMode      // default collapse — full transient diff-style tool trace
  thinking?: ThinkingMode                 // default live — latest reasoning headline
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
  trace: TraceMode
  thinking: ThinkingMode
  engine: 'codex' | 'api'
  codexModel: CodexModel
  counter: 'off' | 'token' | 'both'
  // requireMention isn't a "rendering" flag like the others — it sits at the
  // top of ChannelConfig — but exposing it through ChannelFlags lets the
  // /gpt set unified setter touch it without a separate command path.
  requireMention?: boolean
}

export interface AccessFile {
  version: 2
  users: Record<string, { allowed: boolean }>
  channels: Record<string, ChannelConfig>
}

export interface CanHandleInput {
  channelId: string
  parentChannelId?: string | null
  userId: string
  isMention: boolean
}

const EMPTY: AccessFile = { version: 2, users: {}, channels: {} }
const VALID_REASONING: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

// Trace and thinking used to be booleans. Old saved configs may still hold one,
// so map false->off and true->on rather than letting legacy false read as "on".
type TriState = TraceMode
function normTri(v: unknown): TriState {
  if (v === true) return 'on'
  if (v === false || v == null) return 'off'
  return (v === 'on' || v === 'live' || v === 'collapse') ? v : 'off'
}

function normThinking(v: unknown): ThinkingMode {
  if (v === true) return 'on'
  if (v === false || v == null) return 'off'
  return (v === 'on' || v === 'live' || v === 'collapse') ? v : 'off'
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

// Ultra is not just a deeper scalar: Codex enables automatic task delegation.
// Keep this compatibility boundary beside the model allowlist so every setter
// enforces the same contract, including model changes after Ultra was selected.
export const ULTRA_CODEX_MODELS: readonly CodexModel[] = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-daybreak-blue-latest',
]

export function assertReasoningModelCompatibility(
  reasoning: ReasoningEffort,
  model: CodexModel,
): void {
  if (model === 'gpt-6-astra' && reasoning === 'none') {
    throw new Error(`none reasoning for ${model} is not supported; use low or higher`)
  }
  if (reasoning === 'ultra' && !ULTRA_CODEX_MODELS.includes(model)) {
    throw new Error(`ultra reasoning for ${model} is not supported; use Astra, Sol, Terra, or Daybreak Blue`)
  }
}

const DEFAULT_FLAGS = {
  reasoning: 'high' as ReasoningEffort,
  trace: 'collapse' as TraceMode,
  thinking: 'live' as ThinkingMode,
  engine: 'codex' as 'codex' | 'api',
  codexModel: DEFAULT_CODEX_MODEL as CodexModel,
  counter: 'both' as 'off' | 'token' | 'both',
}

export class AccessManager {
  private stateDir: string
  private file: string
  private data: AccessFile = { ...EMPTY }
  private threadParents = new Map<string, string>()

  constructor() {
    this.stateDir = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
    this.file = path.join(this.stateDir, 'access.json')
  }

  async load(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AccessFile>
      const needsThinkingModeMigration = parsed.version !== 2
      const channels = parsed.channels ?? {}
      if (needsThinkingModeMigration) {
        for (const channel of Object.values(channels)) {
          // In v1, "collapse" was the one-line live view. Preserve that
          // behavior while freeing the name for the accumulated trace.
          if (channel.thinking === 'collapse') channel.thinking = 'live'
        }
      }
      this.data = {
        version: 2,
        users: parsed.users ?? {},
        channels,
      }
      if (needsThinkingModeMigration) await this.save()
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

  private resolveChannel(channelId: string, parentChannelId?: string | null): ChannelConfig | undefined {
    if (parentChannelId) this.threadParents.set(channelId, parentChannelId)
    const parent = parentChannelId ?? this.threadParents.get(channelId)
    return this.data.channels[channelId] ?? (parent ? this.data.channels[parent] : undefined)
  }

  private resolveAccessChannel(channelId: string, parentChannelId?: string | null): ChannelConfig | undefined {
    if (parentChannelId) this.threadParents.set(channelId, parentChannelId)
    // A parent's allow is not consent for every child conversation. Threads
    // must have their own access entry; parent fallback remains available only
    // to channelFlags()/setChannelFlags() for presentation defaults.
    return this.data.channels[channelId]
  }

  noteChannelParent(channelId: string, parentChannelId: string | null): void {
    if (parentChannelId) this.threadParents.set(channelId, parentChannelId)
  }

  canHandle({ channelId, parentChannelId, userId, isMention }: CanHandleInput): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false

    const channel = this.resolveAccessChannel(channelId, parentChannelId)
    if (!channel?.enabled) return false

    if (channel.requireMention && !isMention) return false

    return true
  }

  canReact(userId: string, channelId: string, parentChannelId?: string | null): boolean {
    const user = this.data.users[userId]
    if (!user?.allowed) return false
    const channel = this.resolveAccessChannel(channelId, parentChannelId)
    if (!channel?.enabled) return false
    return true
  }

  isAllowedAndEnabled(userId: string, channelId: string, parentChannelId?: string | null): boolean {
    return this.canReact(userId, channelId, parentChannelId)
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
    const reasoning = flags?.reasoning ?? existing?.reasoning ?? DEFAULT_FLAGS.reasoning
    const codexModel = normCodexModel(flags?.codexModel ?? existing?.codexModel)
    assertReasoningModelCompatibility(reasoning, codexModel)
    this.data.channels[channelId] = {
      enabled,
      requireMention,
      reasoning,
      trace: normTri(flags?.trace ?? existing?.trace ?? DEFAULT_FLAGS.trace),
      thinking: normThinking(flags?.thinking ?? existing?.thinking ?? DEFAULT_FLAGS.thinking),
      engine: flags?.engine ?? existing?.engine ?? DEFAULT_FLAGS.engine,
      codexModel,
      counter: flags?.counter ?? existing?.counter ?? DEFAULT_FLAGS.counter,
    }
    await this.save()
  }

  async setChannelFlags(
    channelId: string,
    patch: Partial<ChannelFlags>,
    parentChannelId?: string | null,
  ): Promise<ChannelConfig> {
    if (parentChannelId) this.threadParents.set(channelId, parentChannelId)
    const parent = parentChannelId ?? this.threadParents.get(channelId)
    const exact = this.data.channels[channelId]
    const existing = this.resolveChannel(channelId, parentChannelId)
    if (!existing) {
      throw new Error(`channel ${channelId} not configured — run /gpt channel first`)
    }
    if (patch.reasoning !== undefined && !VALID_REASONING.includes(patch.reasoning)) {
      throw new Error(`invalid reasoning effort "${patch.reasoning}" — must be one of: ${VALID_REASONING.join(', ')}`)
    }
    if (patch.trace !== undefined && !['off', 'on', 'live', 'collapse'].includes(patch.trace)) {
      throw new Error(`invalid trace "${patch.trace}" — must be one of: off, on, live, collapse`)
    }
    if (patch.codexModel !== undefined && !(CODEX_MODELS as readonly string[]).includes(patch.codexModel)) {
      throw new Error(`invalid codex model "${patch.codexModel}" — must be one of: ${CODEX_MODELS.join(', ')}`)
    }
    const reasoning = patch.reasoning ?? existing.reasoning ?? DEFAULT_FLAGS.reasoning
    const codexModel = patch.codexModel ?? normCodexModel(existing.codexModel)
    assertReasoningModelCompatibility(reasoning, codexModel)
    this.data.channels[channelId] = {
      ...existing,
      // Changing model/trace inside a previously deaf thread is not an access
      // grant. Only setChannel(..., enabled=true, ...) can open the thread.
      ...(parent && !exact ? { enabled: false } : {}),
      ...(patch.reasoning !== undefined ? { reasoning } : {}),
      ...(patch.trace !== undefined ? { trace: patch.trace } : {}),
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
      ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
      ...(patch.codexModel !== undefined ? { codexModel } : {}),
      ...(patch.counter !== undefined ? { counter: patch.counter } : {}),
      ...(patch.requireMention !== undefined ? { requireMention: patch.requireMention } : {}),
    }
    await this.save()
    return this.data.channels[channelId]
  }

  channelFlags(channelId: string, parentChannelId?: string | null): ChannelFlags {
    const channel = this.resolveChannel(channelId, parentChannelId)
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

  channelConfig(channelId: string, parentChannelId?: string | null): ChannelConfig | undefined {
    return this.resolveChannel(channelId, parentChannelId)
  }
}
