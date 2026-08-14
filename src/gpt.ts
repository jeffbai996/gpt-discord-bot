import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message, type TextChannel, type DMChannel, type ThreadChannel } from 'discord.js'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { setTimeout as sleep } from 'node:timers/promises'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { isAddressedToAnotherUser } from './mention-gate.ts'
import {
  formatPinContext,
  formatReplyContext,
  formatThreadContext,
  resolvePinContext,
  resolveReplyContext,
  resolveThreadContext,
  type ReplyContext,
} from './reply-context.ts'
import { PersonaLoader } from './persona.ts'
import { chunk } from './chunk.ts'
import { closeDanglingInlineCode } from './discord-markdown.ts'
import { gptCommand, executeGptCommand } from './commands.ts'
import { recordCommandUsage } from './command-usage.ts'
import { addVoiceGroup, executeVoiceCommand, VoiceManager } from './voice/command.ts'
import { OpenAIClient, OpenAIRequestRejected } from './openai.ts'
import type { LifecycleEvent, RespondInput, RespondResult, ToolCall } from './openai.ts'
import {
  CodexInterruptedError,
  CodexProcessDiedError,
  CodexStoppedError,
  codexTimeoutMs,
  isInFlightStatusPing,
  respondViaCodex,
} from './codex-chat.ts'
import {
  completionContinuationPrompt,
  isNonTerminalActionReply,
  MAX_COMPLETION_CONTINUATIONS,
  NonTerminalCompletionError,
} from './completion-gate.ts'
import {
  buildCodexFailurePostmortemRequest,
  codexFallbackWaitMs,
  isCodexFailurePostmortemEligible,
} from './codex-fallback.ts'
import { fetchHistory, formatHistoryForOpenAI, selectPriorImages, type HistoryMessage } from './history.ts'
import { cleanupAttachmentFiles, processAttachments } from './attachments.ts'
import { extractRichMedia, formatRichContext } from './discord-rich-input.ts'
import { TurnLifecycleTracker } from './reactions/turn-lifecycle.ts'
import { activeTurns } from './active-turns.ts'
import { ChannelTurnRunner } from './channel-turns.ts'
import { renderSteeredMessage } from './steering.ts'
import { frameLiveSteerMessage, frameSteeredMessages } from './steer-context.ts'
import { SteeringInbox } from './steering-inbox.ts'
import { logTurnLifecycle } from './turn-lifecycle.ts'
import {
  GRACEFUL_SHUTDOWN_DEADLINE_MS,
  RestartCoordinator,
  ShutdownGate,
  scheduleSelfRestart,
  waitForIdleOrDeadline,
} from './restart.ts'
import { isValidOutboundReactEmoji } from './reactions/vocabulary.ts'
import { recordTurn as recordCacheTurn, initGlobalStats } from './cache-stats.ts'
import { initLiveUsage } from './live-usage.ts'
import { channelSessions } from './channel-sessions.ts'
import { formatUsageCounter } from './usage-counter.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { MemoryStore, embed } from './memory.ts'
import { shouldEmbed } from './embed-throttle.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { PendingPlaceholders } from './pending-placeholders.ts'
import { RestartInbox } from './restart-inbox.ts'
import { DeferredActions } from './deferred-actions.ts'
import { describeFailure, FailedTurnStore, formatFailureDiagnostic } from './failed-turn-store.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { handleReaction } from './reactions/handler.ts'
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import { settleWithin } from './promise-deadline.ts'
import { INTERRUPTED_MARKER, RETRY_PROMPT } from './interruption-label.ts'
import { stripToolTraceCard } from './render-cleanup.ts'
import { isHardStopMessage } from './stop-command.ts'
import { loadRelayConfig, TrustedRelayVerifier, type TrustedRelay } from './trusted-relay.ts'
import { DEFAULT_OPENAI_MODEL, DEFAULT_SUMMARIZATION_MODEL } from './models.ts'
import {
  DEFAULT_TOOL_CALL_WIDTH,
  DEFAULT_TOOL_OUTPUT_WIDTH,
  formatUnifiedDiffTrace,
  truncateDisplayWidth,
  formatResultTraceLine,
  renderTraceCards,
  resolveTraceFailsafeMs,
} from './tool-trace.ts'
import {
  appendNarrationTrace,
  formatHeartbeatFooter,
  formatLiveWorkMessage,
  formatReasoningSnapshot,
  formatReasoningTraceSnapshot,
  heartbeatVisual,
  latestReasoningHeadline,
  pickHeartbeatVerb,
  shouldRenderHeartbeat,
} from './live-ui.ts'
import {
  advanceLiveProgressDwell,
  resolveLiveEndLinger,
  resolveLiveUpdateInterval,
  liveProgressHoldForReplacement,
  shouldReplaceNarrationWithReasoning,
  shouldLingerLiveEnd,
} from './live-update.ts'
import { appendAgentsPanel, type CodexAgentSnapshot } from './codex-agents.ts'
import {
  GptAgentCommandStore,
  parseAgentCommand,
  runAgentCommand,
} from './agent-commands.ts'
import OpenAI from 'openai'

const STATE_DIR = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })
const trustedRelays = new TrustedRelayVerifier(() => loadRelayConfig(STATE_DIR))

function failureActions(messageId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gpt_retry:${messageId}`).setLabel('Retry').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gpt_resume:${messageId}`).setLabel('Resume').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gpt_error:${messageId}`).setLabel('Show error').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gpt_switch:${messageId}`).setLabel('Switch engine').setStyle(ButtonStyle.Secondary),
  )
}

function isBadReplyReference(err: unknown): boolean {
  const e = err as any
  const text = `${e?.message ?? ''} ${JSON.stringify(e?.rawError ?? {})}`
  return e?.code === 50035 && (
    text.includes('REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE') ||
    text.includes('Cannot reply to a system message') ||
    text.includes('message_reference')
  )
}

function isNewerDiscordMessage(candidateId: string, anchorId: string): boolean {
  try {
    return BigInt(candidateId) > BigInt(anchorId)
  } catch {
    return candidateId > anchorId
  }
}

async function replyOrSend(
  message: Message,
  content: string,
  replyToInbound = true,
): Promise<Message | null> {
  if (!replyToInbound) {
    if (!message.channel.isSendable()) return null
    try {
      return await message.channel.send(content)
    } catch (sendErr) {
      console.error('[discord] send failed:', sendErr)
      return null
    }
  }
  try {
    return await message.reply({ content, allowedMentions: { repliedUser: false } })
  } catch (err) {
    if (!isBadReplyReference(err)) {
      console.error('[discord] reply failed:', err)
    }
    if (!message.channel.isSendable()) return null
    try {
      return await message.channel.send(content)
    } catch (sendErr) {
      console.error('[discord] fallback send failed:', sendErr)
      return null
    }
  }
}

// --- Tool-trace card helpers (ported from gem-bot/src/gemma.ts) -------------
// Tool calls render inside a ```diff``` fence as `+ ● ToolName(digest) [Nms]`
// — the `+` makes Discord's diff highlighter color the line GREEN; a failed
// call uses `- ● ... FAILED` (RED). The `●` dot marks "this is a tool call".
const ARG_DIGEST_PREFERENCE = [
  'file_path', 'notebook_path', 'pattern', 'command', 'url',
  'symbols', 'symbol', 'ticker', 'query', 'arguments',
]

// Single-line, ID-shaped arg digest, <= maxLen chars.
// codex accepts none|low|medium|high|xhigh|max; the OpenAI API engine only
// takes minimal|low|medium|high. Map the codex extremes down for the API call.
// Duration like the Claude bots: "40s" under a minute, "1m 5s" over.
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function apiEffort(e: string): 'minimal' | 'low' | 'medium' | 'high' {
  if (e === 'none') return 'minimal'
  if (e === 'xhigh' || e === 'max') return 'high'
  if (e === 'low' || e === 'medium' || e === 'high') return e
  return 'medium'
}

function argDigest(args: Record<string, unknown>, maxLen = 80): string {
  if (!args || typeof args !== 'object') return ''
  for (const key of ARG_DIGEST_PREFERENCE) {
    const v = (args as Record<string, unknown>)[key]
    if (typeof v === 'string') {
      let s = v.trim().replace(/\n/g, ' ')
      if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
      return s
    }
  }
  let s: string
  try { s = JSON.stringify(args) } catch { s = String(args) }
  s = s.replace(/\n/g, ' ')
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
  return s
}

// mcp__server__ns__tool -> tool (last segment).
// Codex unified diff -> Claude-style: a [+adds, -dels] badge + the changed lines
// (red '-' / green '+', context plain), minus the git '@@' / file-header noise.
// Codex session rollover ceiling (Jeff 2026-06-25). Each channel resumes its
// persistent Codex session every turn (codex exec resume <id>) so gpt keeps its
// own prior reasoning/tool context. But Codex counts the WHOLE resumed session
// as turn input, and `exec resume` has no compaction command — so a long-lived
// session bloats unboundedly. When the last reported input crosses this ceiling,
// force a durable channel summary first, then drop the Codex session pointer so
// THIS turn cold-starts with compact older context + recent Discord history.
//
// If summarization is unavailable/fails, rollover still drops only the session
// pointer (not the Discord-history cutoff), so the next turn can re-ground from
// recent channel history and squad memory instead of going fully amnesic.
const CODEX_SESSION_MAX_INPUT_TOKENS = Number(
  process.env.GPT_CODEX_MAX_SESSION_INPUT_TOKENS
  ?? process.env.GPT_SESSION_ROLLOVER_TOKENS
  ?? 750_000
)
const SESSION_ROLLOVER_SUMMARY_TIMEOUT_MS = Number(
  process.env.GPT_SESSION_ROLLOVER_SUMMARY_TIMEOUT_MS ?? 30_000
)
const CODEX_FALLBACK_MIN_ELAPSED_MS = Number(process.env.GPT_CODEX_FALLBACK_MIN_ELAPSED_MS) || 90_000
// Keep tool-call headers and stdout/result previews narrow enough that Discord's
// code fence does not wrap on Jeff's client. Output rows need extra headroom.
// NOTE: OUT_W is the preview WIDTH in chars, not a call count — a prior fix
// misread "reduce ~10" and chopped this to 10, which made every ⎿ preview useless
// ([{"channe…). Widths reduced again by 3 call cells / 6 output cells on 2026-07-12.
const ROW_W = DEFAULT_TOOL_CALL_WIDTH
const OUT_W = Number(process.env.GPT_OUT_W ?? DEFAULT_TOOL_OUTPUT_WIDTH)

function headingsToBold(t: string): string {
  const lines = t.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/)
    if (m) {
      out.push(`**${m[1]}**`)
      while (i + 1 < lines.length && lines[i + 1].trim() === '') i++
    } else {
      out.push(lines[i])
    }
  }
  return out.join('\n')
}

// Canonical tool-trace lines from toolCalls, shared by the live + final renders.
// File edits show the [+N, -M] badge and the diff body; other tools keep [Nms].
function buildTraceLines(toolCalls: ToolCall[]): string[] {
  const lines: string[] = []
  for (const call of toolCalls) {
    const prefix = call.failed ? '- ● ' : '+ ● '
    const tail = call.failed ? ' FAILED' : ''
    const ms = call.durationMs > 0 ? ` [${call.durationMs}ms]` : ''
    const nm = shortToolName(call.name)
    // Keep the whole row within ROW_W so it never wraps in Discord's code block.
    const overhead = prefix.length + nm.length + 2 + tail.length + ms.length
    const dig = argDigest(call.args, Math.max(20, ROW_W - overhead))
    lines.push(`${prefix}${nm}(${dig})${tail}${ms}`)
    if (call.diff) {
      // One leading cell here plus renderTraceCard's pad gives ⎿ a 2-cell indent.
      const { badge, body } = formatUnifiedDiffTrace(call.diff)
      lines.push(` ⎿ ${badge}`)
      for (const row of body) lines.push(row)
    } else if (call.resultPreview) {
      const n = call.resultLines ?? 0
      lines.push(formatResultTraceLine(call.resultPreview, n, OUT_W))
    }
  }
  return lines
}

function shortToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    if (parts.length >= 3) return parts[parts.length - 1]
  }
  return name
}

function liveStartArgs(name: string, raw?: string): Record<string, unknown> {
  const s = String(raw ?? '').trim()
  if (!s) return {}
  try {
    const parsed = JSON.parse(s)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* not JSON */ }
  const short = shortToolName(name)
  if (short === 'shell') return { command: s }
  if (short === 'edit') return { file_path: s }
  if (short === 'web_search' || short === 'web.run') return { query: s }
  return { arguments: s }
}

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error(`FATAL: DISCORD_BOT_TOKEN missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}
if (!process.env.DISCORD_APP_ID) {
  console.error(`FATAL: DISCORD_APP_ID missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error(`FATAL: OPENAI_API_KEY missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}

const DISCORD_TOKEN: string = process.env.DISCORD_BOT_TOKEN
const APP_ID: string = process.env.DISCORD_APP_ID
const OPENAI_KEY: string = process.env.OPENAI_API_KEY
const DEFAULT_MODEL: string = process.env.GPT_MODEL || DEFAULT_OPENAI_MODEL
const ADMIN_USER_ID: string | undefined = process.env.DISCORD_ADMIN_USER_ID
const DEFAULT_PRESENCE_TEXT = '📎 actually, on reflection—'

function loadSettings(): { presence?: string } {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return typeof parsed.presence === 'string' ? { presence: parsed.presence } : {}
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.error('settings load failed:', e)
    return {}
  }
}

const settings = loadSettings()
const initialPresenceText = settings.presence?.slice(0, 128) || DEFAULT_PRESENCE_TEXT

const access = new AccessManager()
const persona = new PersonaLoader()
const pendingEdits = new PendingEditsStore()
const pinnedFacts = new PinnedFactsStore(path.join(STATE_DIR, 'pinned-facts.md'))
const pendingPlaceholders = new PendingPlaceholders(path.join(STATE_DIR, 'pending-placeholders.json'))
const restartInbox = new RestartInbox(path.join(STATE_DIR, 'restart-inbox.json'))
initGlobalStats(path.join(STATE_DIR, 'global-stats.json'))
// Truncates any in-flight turns left behind by a crash or redeploy — they were
// never billed to the completed total, so carrying them would inflate the rate.
initLiveUsage(path.join(STATE_DIR, 'live-usage.json'))
const deferredActions = new DeferredActions(path.join(STATE_DIR, 'deferred-actions.json'))
const failedTurns = new FailedTurnStore(path.join(STATE_DIR, 'failed-turns.json'))
const agentCommands = new GptAgentCommandStore(
  path.join(STATE_DIR, 'agent-registry'),
  process.env.GPT_INSTANCE_ID || APP_ID,
)
persona.setPinnedFactsStore(pinnedFacts)
const openai = new OpenAIClient(OPENAI_KEY, DEFAULT_MODEL)
// Raw SDK client for metered OpenAI endpoints that have no local equivalent:
// audio transcriptions, web-search side calls, explicit API turns, and API postmortems.
const openaiRaw = new OpenAI({ apiKey: OPENAI_KEY })

// Local Ollama client (OpenAI-compatible /v1) for the cost-sensitive background
// paths that DON'T need a frontier model: per-message embeddings and history
// summarization. Both used to hit the metered OpenAI API on every message /
// rollup; pointing them at the local Ollama box makes them free. `apiKey` is a
// throwaway — Ollama ignores it. Mirrors llm-bot's memory backend. See
// memory.ts EMBEDDING_MODEL and GPT_SUMMARIZATION_MODEL in the env.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://100.94.27.37:11434'
const ollamaClient = new OpenAI({ apiKey: 'ollama', baseURL: OLLAMA_URL + '/v1' })

// Realtime voice-to-voice, under `/gpt voice …`. Owner-gated; empty admin id =
// nobody, which safely disables it. The real persona + tool registry are built
// PER JOIN (they depend on the channel/guild) and passed into executeVoiceCommand,
// so the session speaks as gpt and can call gpt's tools — see command.ts. The
// constructor only carries the bits that don't change per call.
const voiceManager = new VoiceManager({
  apiKey: OPENAI_KEY,
  adminUserId: ADMIN_USER_ID ?? '',
  log: (m) => console.error(`[voice] ${m}`),
})
// Attach `/gpt voice join|type|model|leave|speak` onto the existing /gpt command builder.
addVoiceGroup(gptCommand)

// Memory store may be null if the native sqlite-vss / better-sqlite3 modules
// fail to load on this Node version. The bot still runs; search_memory just
// isn't registered, and passive ingestion + summarization are skipped.
const memoryStore = await MemoryStore.open()
if (!memoryStore) {
  console.error('memory: RAG disabled (native module load failed); set up Node 22+ to enable')
}
// Registry gets the real OpenAI client (web-search side-call needs a real
// model) plus the Ollama client for the embedding-backed search_memory tool —
// query embeddings MUST use the same backend as stored vectors or search is
// garbage.
const toolRegistry = await buildDefaultRegistry(openaiRaw, memoryStore, ollamaClient)

// Summarization scheduler. Wires only when the SQLite-backed memory store is
// available — summaries persist into the same conversation_summaries table.
const SUMMARIZATION_THRESHOLD = parseInt(process.env.GPT_SUMMARIZATION_THRESHOLD ?? '50', 10)
const SUMMARIZATION_BATCH_LIMIT = parseInt(process.env.GPT_SUMMARIZATION_BATCH_LIMIT ?? '500', 10)
// Summarization runs on the local Ollama client with a local model by default
// (was metered gpt-5.5 on every rollup). Override the model via
// GPT_SUMMARIZATION_MODEL; it resolves against whichever client is wired below.
const SUMMARIZATION_MODEL = process.env.GPT_SUMMARIZATION_MODEL ?? DEFAULT_SUMMARIZATION_MODEL
const summaryStore = memoryStore ? SummaryStore.fromMemory(memoryStore) : null
if (summaryStore) persona.setSummaryStore(summaryStore)
const summarizer: SummarizationScheduler | null = (memoryStore && summaryStore)
  ? new SummarizationScheduler({
      store: summaryStore,
      fetchSinceForSummarization: async (channelId, since, limit) => {
        const rows = memoryStore.fetchMessagesSince(channelId, since, limit)
        return rows.map(r => ({
          authorName: r.author_name,
          content: r.content,
          timestamp: r.timestamp,
          messageId: r.id
        }))
      },
      client: ollamaClient,
      model: SUMMARIZATION_MODEL,
      threshold: SUMMARIZATION_THRESHOLD,
      batchLimit: SUMMARIZATION_BATCH_LIMIT
    })
  : null

await access.load()
await persona.load()

process.on('SIGHUP', async () => {
  console.error('SIGHUP received — reloading access.json and persona.md')
  try {
    await access.load()
    await persona.load()
    console.error('reload complete')
  } catch (e) {
    console.error('reload failed:', e)
  }
})

process.on('unhandledRejection', err => console.error('unhandledRejection:', err))
process.on('uncaughtException', err => console.error('uncaughtException:', err))

// Embed + persist a single message in the background. Errors are logged but
// never thrown — ingestion failures shouldn't impact the reply flow.
async function ingestMessage(message: Message): Promise<void> {
  if (!memoryStore) return
  // Per-(channel,user) embedding throttle: skip the embed API call entirely
  // when this author embedded within the cooldown window. Stops a chatty user
  // or busy channel from burning a continuous embedding stream. The dropped
  // message just isn't RAG-indexed; it's still in live Discord history.
  if (!shouldEmbed(message.channel.id, message.author.id)) return
  try {
    const emb = await embed(ollamaClient, message.content)
    if (!emb) return
    memoryStore.insertMessage({
      id: message.id,
      channel_id: message.channel.id,
      author_id: message.author.id,
      author_name: message.author.username,
      content: message.content,
      timestamp: new Date(message.createdTimestamp).toISOString()
    }, emb)
  } catch (e) {
    console.error('ingestMessage failed:', e instanceof Error ? e.message : e)
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates   // /voice — join VCs for realtime audio
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction]
})

const shutdownGate = new ShutdownGate()
const activeAgentViews = new Map<string, (agents: CodexAgentSnapshot[]) => Promise<void>>()
const activeLifecycleTrackers = new Map<string, TurnLifecycleTracker>()
const QUEUE_SETTLE_MS = Number(process.env.GPT_QUEUE_SETTLE_MS) || 0
interface QueuedChannelTurn {
  message: Message
  target: Message | null
  contentOverride?: string
  actor?: TrustedRelay
  steered: boolean
}
const channelTurns = new ChannelTurnRunner<QueuedChannelTurn>(
  async (channelId, batch) => {
    const carrier = batch[batch.length - 1]
    const messages = (await Promise.all(batch.map(async item => {
      if (item.contentOverride !== undefined) return item.contentOverride
      const replyText = formatReplyContext(await resolveReplyContext(item.message))
      const pinText = formatPinContext(await resolvePinContext(item.message))
      const threadText = formatThreadContext(await resolveThreadContext(item.message))
      const richText = formatRichContext(item.message)
      return threadText || [replyText, pinText, richText, item.message.content].filter(Boolean).join('\n\n')
    }))).filter(Boolean)
    const combined = batch.some(item => item.steered)
      ? frameSteeredMessages(messages)
      : messages.join('\n')
    logTurnLifecycle({
      event: 'channel_batch_started',
      channelId,
      queueDepth: channelTurns.queueDepth(channelId),
    })
    await handleUserMessage(
      carrier.message,
      batch.length === 1 ? carrier.target : null,
      false,
      combined || undefined,
      carrier.actor,
    )
  },
  channelId => activeTurns.consumeStopped(channelId),
  QUEUE_SETTLE_MS,
)
const restartCoordinator = new RestartCoordinator(
  () => Promise.all([
    shutdownGate.waitForIdle(),
    activeTurns.waitForIdle(),
    channelTurns.waitForIdle(),
  ]).then(() => {}),
  () => {
    logTurnLifecycle({ event: 'restart_launching', restartPhase: 'launching' })
    scheduleSelfRestart('gpt', 250)
  },
  () => shutdownGate.beginDrain(),
  {
    onDeadline: () => {
      logTurnLifecycle({ event: 'restart_drain_deadline', restartPhase: 'draining' })
      console.error('[restart] drain exceeded its warning deadline; continuing to wait for active work')
    },
  },
)

function requestGracefulRestart(): void {
  const accepted = restartCoordinator.request()
  if (!accepted) {
    console.error('[restart] request coalesced; restart already pending')
    return
  }
  logTurnLifecycle({
    event: 'restart_requested',
    restartPhase: 'pending',
    queueDepth: channelTurns.totalQueueDepth(),
  })
  console.error('[restart] requested; waiting for a natural idle window before cutover')
}

function installGracefulShutdown(): void {
  const configuredTimeoutMs = Number(process.env.GPT_GRACEFUL_SHUTDOWN_MS)
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : GRACEFUL_SHUTDOWN_DEADLINE_MS
  const shutdown = (signal: string) => {
    if (!shutdownGate.beginExit()) return
    console.error(`[shutdown] ${signal} received; waiting for active turns to finish`)
    logTurnLifecycle({ event: 'shutdown_requested', signal, restartPhase: 'draining' })
    const idle = Promise.all([
      shutdownGate.waitForIdle(),
      activeTurns.waitForIdle(),
      channelTurns.waitForIdle(),
    ])
    waitForIdleOrDeadline(idle, timeoutMs)
      .then(reason => {
        console.error(`[shutdown] exiting after ${reason}`)
        client.destroy()
        process.exit(0)
      })
      .catch(err => {
        console.error('[shutdown] graceful shutdown failed:', err)
        process.exit(1)
      })
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGUSR2', requestGracefulRestart)
}

installGracefulShutdown()

client.once('ready', async () => {
  console.error(`gpt online as ${client.user?.tag} (${client.user?.id})`)
  client.user?.setPresence({
    status: 'online',
    activities: [{ name: initialPresenceText, type: ActivityType.Custom, state: initialPresenceText }]
  })

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    await rest.put(Routes.applicationCommands(APP_ID), { body: [gptCommand.toJSON()] })
    console.error('slash commands registered')
  } catch (e) {
    console.error('slash command registration failed:', e)
  }

  try {
    const n = await pendingPlaceholders.sweep(client)
    if (n) console.error(`swept ${n} interrupted placeholder(s) from a prior run`)
    const replayed = await restartInbox.replay(async (channelId, messageId) => {
      const channel = await client.channels.fetch(channelId)
      if (!channel?.isTextBased()) throw new Error(`deferred channel ${channelId} is unavailable`)
      const message = await channel.messages.fetch(messageId)
      await dispatchInboundMessage(message)
    })
    if (replayed) console.error(`replayed ${replayed} message(s) deferred during restart`)
    deferredActions.rearm(client)
  } catch (e) {
    console.error('placeholder sweep failed:', e)
  }
})

client.on('interactionCreate', async interaction => {
  if (interaction.channel?.isThread()) access.noteChannelParent(interaction.channelId!, interaction.channel.parentId)
  if (interaction.isButton() && interaction.customId.startsWith('gpt_')) {
    const [action, messageId] = interaction.customId.split(':')
    const failed = failedTurns.get(messageId)
    if (!failed || !access.isAllowedAndEnabled(interaction.user.id, interaction.channelId ?? '')) {
      await interaction.reply({ content: 'That failed turn is no longer resumable.', ephemeral: true }).catch(() => {})
      return
    }
    if (action === 'gpt_error') {
      await interaction.reply({
        content: formatFailureDiagnostic(failed.diagnostic),
        ephemeral: true,
      }).catch(() => {})
      return
    }
    const sourceChannel = await client.channels.fetch(failed.channelId).catch(() => null)
    const source = sourceChannel?.isTextBased()
      ? await sourceChannel.messages.fetch(failed.sourceMessageId).catch(() => null)
      : null
    if (!source) {
      failedTurns.delete(messageId)
      await interaction.reply({
        content: 'The original message is gone, so this turn cannot be retried.',
        ephemeral: true,
      }).catch(() => {})
      return
    }
    await interaction.deferUpdate()
    if (action === 'gpt_switch') {
      const current = access.channelFlags(interaction.channelId!).engine
      await access.setChannelFlags(interaction.channelId!, { engine: current === 'codex' ? 'api' : 'codex' })
    }
    const resume = action === 'gpt_resume'
    const content = resume
      ? `${source.content}\n\n[Resume the interrupted work from the last safe boundary. Reuse the existing Codex session and do not restart completed steps.]`
      : undefined
    await handleUserMessage(source, interaction.message as Message, false, content)
    return
  }
  if (!interaction.isChatInputCommand()) return
  if (shutdownGate.isDraining()) {
    await interaction.reply({ content: '⚠️ restarting after the current turn finishes', ephemeral: true }).catch(() => {})
    return
  }
  if (interaction.commandName !== 'gpt') return
  const slashPath = [
    interaction.options.getSubcommandGroup(false),
    interaction.options.getSubcommand(false),
  ].filter(Boolean).join(' ')
  await recordCommandUsage(slashPath)
  // /gpt voice … is a subcommand group; route it to the voice handler.
  if (interaction.options.getSubcommandGroup(false) === 'voice') {
    await executeVoiceCommand(interaction, voiceManager, ADMIN_USER_ID ?? '', persona, toolRegistry)
    return
  }
  await executeGptCommand(interaction, access, ADMIN_USER_ID, { summarizer })
})

// Core message-handling pipeline. Reused by:
//   - messageCreate (normal user message → fresh reply)
//   - regenerate reaction (re-runs against the same user message, edits the
//     bot's existing reply rather than posting again)
//   - expand reaction (re-runs with a "go deeper" preamble; new reply)
//   - markForEdit pending-edit consumer (next user message edits the marked
//     bot message in place)
//
// targetMessage non-null → edit that bot message instead of posting fresh.
// expansion=true → prepend an "expand on your prior reply" instruction.
// Presence: @gpt sets its own status via a [[presence: …]] reply directive →
// applyBasePresence(). The API-postmortem indicator (setEnginePresence) temporarily
// overrides with ⚠️ and restores the base on recovery.
let basePresenceText = initialPresenceText
let lastDegraded = false
function presenceActivity(text: string) {
  return { name: text, type: ActivityType.Custom, state: text }
}
function applyBasePresence(text: string): void {
  basePresenceText = text.slice(0, 128) || basePresenceText
  if (!lastDegraded) { try { client.user?.setPresence({ activities: [presenceActivity(basePresenceText)] }) } catch {} }
}
function setEnginePresence(degraded: boolean): void {
  if (degraded === lastDegraded) return
  lastDegraded = degraded
  const text = degraded ? '⚠️ API postmortem (codex failed)' : basePresenceText
  try { client.user?.setPresence({ activities: [presenceActivity(text)] }) } catch {}
}

async function handleUserMessage(
  message: Message,
  targetMessage: Message | null,
  expansion: boolean,
  contentOverride?: string,
  actor?: TrustedRelay,
): Promise<void> {
  const channelId = message.channel.id
  const userId = actor?.userId ?? message.author.id
  const userName = actor?.userName ?? message.author.username
  // When a batched-queue turn folds several messages together, the combined
  // text comes in via contentOverride; otherwise use the message's own content.
  const userText = contentOverride ?? message.content
  const replyContext = await resolveReplyContext(message)
  const pinContext = await resolvePinContext(message)
  const threadContext = await resolveThreadContext(message)
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null
  const flags = access.channelFlags(channelId, parentChannelId)
  const transientTrace = flags.trace === 'live' || flags.trace === 'collapse'
  // API-engine model is env-driven (DEFAULT_MODEL / GPT_MODEL), not per-channel —
  // matches gemma's API model. The per-channel `model` override was removed
  // 2026-06-29 (it had no slash setter — orphaned). /gpt model sets codexModel.
  const model = DEFAULT_MODEL
  const systemPrompt = persona.buildSystemPrompt(channelId, message.guildId)
  const selfId = client.user?.id ?? ''
  const stopController = new AbortController()
  const steeringInbox = flags.engine !== 'api' && process.env.GPT_CODEX_CHAT !== '0'
    ? new SteeringInbox()
    : null
  // The signed marker is machine plumbing and gets deleted on admission. It
  // must not collect user-message lifecycle reactions or noisy 404s.
  const lifecycle = actor
    ? new TurnLifecycleTracker(message, async () => {})
    : new TurnLifecycleTracker(message)
  activeLifecycleTrackers.set(channelId, lifecycle)
  const turnGeneration = activeTurns.register(
    channelId,
    () => stopController.abort(),
    steeringInbox ? (text, onAccepted) => steeringInbox.submit(text, onAccepted) : undefined,
  )
  const agentWorkflowId = `${message.id}:${turnGeneration}`
  logTurnLifecycle({
    event: 'turn_registered',
    channelId,
    generation: turnGeneration,
    queueDepth: channelTurns.queueDepth(channelId),
  })

  let history: Awaited<ReturnType<typeof formatHistoryForOpenAI>> = []
  let rawHistory: HistoryMessage[] = []
  let historyFetchFailed = false
  try {
    if (
      message.channel.type === 0 /* GuildText */ ||
      message.channel.type === 1 /* DM */ ||
      message.channel.type === 11 /* PublicThread */ ||
      message.channel.type === 12 /* PrivateThread */ ||
      message.channel.type === 5 /* GuildAnnouncement */
    ) {
      const raw = await fetchHistory(message.channel as TextChannel | DMChannel | ThreadChannel, message.id)
      // Respect /clear: drop anything at/before the channel's clear cutoff so a
      // cleared conversation truly starts fresh (Jeff 2026-06-27).
      const _cutoff = channelSessions.clearedSince(channelId)
      const rawFiltered = _cutoff ? raw.filter((m: any) => (m.createdTimestamp ?? 0) > _cutoff) : raw
      rawHistory = rawFiltered
      history = await formatHistoryForOpenAI(rawFiltered, selfId)
      // Observability (Jeff 2026-06-29): empty history = the bot loses context
      // for the turn. Log the counts so a fetch hiccup / over-aggressive cutoff
      // is visible instead of silently degrading (and burning tokens on a
      // context-less reply the user then has to re-ask).
      console.error(`[history] ch=${channelId} fetched=${raw.length} afterCutoff=${rawFiltered.length} sent=${history.length}${_cutoff ? ` cutoff=${_cutoff}` : ''}`)
    }
  } catch (e) {
    // Empty history = no context this turn. Flagged (not just logged) so the
    // reply carries a visible marker instead of silently degrading (Jeff
    // 2026-07-08 — the 2026-06-29 fix only logged, the degrade was still silent).
    historyFetchFailed = true
    console.error(`[history] FETCH FAILED for ch=${channelId} — replying with NO context:`, e)
  }

  await lifecycle.transition('received')

  const directAttachments = [...message.attachments.values()]
  const richAttachments = extractRichMedia(message)
  const uploadedAttachments = [...directAttachments, ...richAttachments]
  const repliedAttachments = uploadedAttachments.length === 0
    ? replyContext?.attachments ?? pinContext?.message?.attachments ?? threadContext?.source?.attachments ?? []
    : []
  const carriedImages = uploadedAttachments.length === 0 && repliedAttachments.length === 0
    ? selectPriorImages(rawHistory, userId, message.reference?.messageId, userText)
    : []
  const attachments = uploadedAttachments.length > 0
    ? uploadedAttachments
    : repliedAttachments.length > 0 ? repliedAttachments : carriedImages
  let imageParts: NonNullable<Parameters<typeof openai.respond>[0]['imageParts']> = []
  let imagePaths: string[] = []
  let temporaryResultFiles: string[] = []
  let extraText = ''
  if (attachments.length > 0) {
    await lifecycle.transition('ingesting')
    try {
      const processed = await processAttachments(attachments, openaiRaw)
      imageParts = processed.imageParts
      imagePaths = processed.imagePaths
      extraText = processed.text
      if (repliedAttachments.length > 0 || carriedImages.length > 0) {
        const reused = repliedAttachments.length > 0 ? repliedAttachments : carriedImages
        const names = reused.map(att => att.name).join(', ')
        extraText = `[Reused attachment from replied-to Discord message: ${names}]`
          + (extraText ? `\n\n${extraText}` : '')
      }
    } catch (e) {
      console.error('attachment processing failed:', e)
    }
  }

  if (contentOverride === undefined) {
    const quotedReply = formatReplyContext(replyContext)
    const threadText = formatThreadContext(threadContext)
    const richText = formatRichContext(message)
    extraText = [quotedReply, threadText, richText, extraText].filter(Boolean).join('\n\n')
  }

  // The expansion preamble is just a small steer appended to extraText so
  // the model knows to add detail rather than re-roll the same answer. Lives
  // here rather than in the persona so it only fires for the 🔍 path.
  if (expansion) {
    extraText = (extraText ? extraText + '\n\n' : '') +
      '[Expansion request: the user wants you to go deeper on your most recent reply in this channel — add detail, examples, or counter-points. Don\'t repeat what you already said; build on it.]'
  }
  // "thinking with [effort] effort…" — surface the reasoning effort in the live
  // placeholder (Jeff 2026-06-24). 'none' effort just reads "thinking".
  const effortLabel = flags.reasoning && flags.reasoning !== 'none'
    ? `thinking with ${flags.reasoning} effort` : 'thinking'
  let heartbeatVerb = pickHeartbeatVerb()
  let heartbeatFrame = 0
  let workMessage: Message | null = targetMessage
  let placeholderId: string | null = null
  let thinkingAnim: ReturnType<typeof setInterval> | null = null
  let liveEditTask: Promise<void> | null = null
  let liveRenderTimer: ReturnType<typeof setTimeout> | null = null
  let liveRenderDirty = false
  let lastLiveRenderAt = 0
  let liveProgressHoldUntil = 0
  let lastRenderedProgressText = ''
  let lastProgressText = ''
  let liveHeadline = ''
  const liveReasoningTrace: string[] = []
  let liveNarrationTrace: string[] = []
  let liveDetail = ''
  let liveFooter = ''
  let spinnerGlyph = '✻'
  let spinnerDots = '…'
  let pulseAgentPanel: () => void = () => {}
  let liveUiClosed = false
  const LIVE_UI_SETTLE_MS = Number(process.env.GPT_LIVE_UI_SETTLE_MS) || 5_000
  const LIVE_UPDATE_INTERVAL_MS = resolveLiveUpdateInterval(process.env.GPT_LIVE_UPDATE_INTERVAL_MS)
  const LIVE_END_LINGER_MS = resolveLiveEndLinger(process.env.GPT_LIVE_END_LINGER_MS)
  const awaitBounded = async (promise: Promise<unknown> | null): Promise<boolean> => {
    if (!promise) return true
    let timer: ReturnType<typeof setTimeout> | null = null
    const settled = await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), LIVE_UI_SETTLE_MS) }),
    ])
    if (timer) clearTimeout(timer)
    return settled
  }
  const abandonWedgedPlaceholder = () => {
    if (!workMessage) return
    const wedged = workMessage
    workMessage = null
    if (!targetMessage) void wedged.delete().catch(() => {})
  }
  const stopThinkingAnim = async () => {
    if (thinkingAnim) { clearInterval(thinkingAnim); thinkingAnim = null }
    if (liveRenderTimer) { clearTimeout(liveRenderTimer); liveRenderTimer = null }
    liveRenderDirty = false
    const pending = liveEditTask
    liveEditTask = null
    if (!await awaitBounded(pending)) abandonWedgedPlaceholder()
  }
  const settleLiveUi = async (respectProgressDwell = false) => {
    if (respectProgressDwell) {
      const remaining = liveProgressHoldUntil - Date.now()
      if (remaining > 0) await sleep(remaining)
    }
    liveUiClosed = true
    await stopThinkingAnim()
  }
  let interruptionRendered = false
  const renderInterruptedTurn = async () => {
    if (interruptionRendered) return
    interruptionRendered = true
    const content = `${INTERRUPTED_MARKER}\n${RETRY_PROMPT}`
    let tombstone: Message | null = workMessage
    if (tombstone) {
      await tombstone.edit(content).catch(() => {})
    } else if (message.channel.isSendable()) {
      tombstone = await message.channel.send(content).catch(() => null)
    }
    if (tombstone) await tombstone.react('🔁').catch(() => {})
    try { await message.react('✗') } catch {}
  }
  const throwIfStopped = () => {
    if (stopController.signal.aborted) throw new CodexStoppedError(0)
  }
  // Typing-dots-first (Jeff 2026-06-29, ported from gem-bot): show the native
  // "GPT is typing…" indicator immediately, and only post the 💭 placeholder
  // bubble + spinner if the turn is STILL working after PLACEHOLDER_DELAY_MS.
  // Fast turns then read clean — dots, then the answer, no transient bubble.
  // Slow turns (esp. codex, which doesn't stream partials) still get the
  // animated placeholder. The typing heartbeat re-fires every 9s because
  // Discord auto-expires the indicator after ~10s.
  const PLACEHOLDER_DELAY_MS = parseInt(process.env.GPT_PLACEHOLDER_DELAY_MS ?? '2500', 10)
  const HEARTBEAT_DELAY_MS = parseInt(process.env.GPT_CODEX_HEARTBEAT_DELAY_MS ?? '60000', 10)
  let placeholderTimer: ReturnType<typeof setTimeout> | null = null
  let typingInterval: ReturnType<typeof setInterval> | null = null
  if (!targetMessage && message.channel.isSendable()) {
    ;(message.channel as any).sendTyping?.().catch(() => {})
    typingInterval = setInterval(() => {
      ;(message.channel as any).sendTyping?.().catch(() => {})
    }, 9000)
  }

  // Start the placeholder spinner (idempotent). One render loop owns the whole
  // live card, so the top glyph never freezes when reasoning/progress/footer
  // content changes and parallel Discord edits cannot fight over the message.
  const startSpinner = () => {
    if (liveUiClosed || thinkingAnim || !workMessage) return
    const GLYPHS = ['✻', '✢', '✱', '✶', '✷', '✸']
    const dots = ['.', '..', '…']
    let fi = 1
    thinkingAnim = setInterval(() => {
      spinnerGlyph = GLYPHS[fi % GLYPHS.length]
      spinnerDots = dots[fi % dots.length]
      fi++
      queueLiveRender()
      pulseAgentPanel()
    }, LIVE_UPDATE_INTERVAL_MS)
  }

  // Post the 💭 placeholder bubble + start its spinner, once. Called either by
  // the deferred timer (slow path) or eagerly the instant streamed content
  // needs a home before the timer fired. No-op if a workMessage already exists.
  const postPlaceholder = async () => {
    if (liveUiClosed) return
    if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
    if (workMessage) { startSpinner(); return }
    try {
      const pending = replyOrSend(message, `💭 ✻ **${effortLabel}…**`, !actor)
      let timer: ReturnType<typeof setTimeout> | null = null
      const posted = await Promise.race([
        pending,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LIVE_UI_SETTLE_MS) }),
      ])
      if (timer) clearTimeout(timer)
      if (!posted) {
        // If Discord eventually resolves after our deadline, remove the orphaned
        // placeholder instead of letting it appear beneath an already-final reply.
        void pending.then(late => {
          if (late && !targetMessage) void late.delete().catch(() => {})
        }).catch(() => {})
        return
      }
      if (liveUiClosed) {
        if (!targetMessage) void posted.delete().catch(() => {})
        return
      }
      workMessage = posted
      if (workMessage) {
        placeholderId = workMessage.id
        pendingPlaceholders.track(message.channel.id, workMessage.id, message.id)
      }
    } catch (e) {
      console.error('placeholder reply failed:', e)
    }
    startSpinner()
  }

  if (targetMessage) {
    // Regenerate / edit: reuse the existing bot message and animate it too.
    startSpinner()
  } else {
    // Normal turn: dots now, placeholder only if still working after the delay.
    placeholderTimer = setTimeout(() => { void postPlaceholder() }, PLACEHOLDER_DELAY_MS)
  }

  // Serialize and coalesce all live-card changes. Model streams can emit a
  // lifecycle event per token; Discord should see one accumulated snapshot per
  // interval, never a queue of stale word-sized PATCH requests.
  let lastEditedText = ''
  const renderLiveNow = async (): Promise<void> => {
    if (liveUiClosed) return
    if (liveEditTask) await liveEditTask.catch(() => {})
    if (liveUiClosed) return
    const task = (async () => {
      if (liveUiClosed) return
      await postPlaceholder()
      if (!workMessage || liveUiClosed) return
      const accumulatesReasoning = flags.thinking === 'on' || flags.thinking === 'collapse'
      const display = formatLiveWorkMessage({
        effortLabel,
        headline: accumulatesReasoning ? '' : liveHeadline,
        reasoningTrace: accumulatesReasoning ? liveReasoningTrace : [],
        detail: liveDetail,
        narrationTrace: flags.thinking === 'collapse' ? liveNarrationTrace : [],
        footer: liveFooter,
        spinnerGlyph,
        spinnerDots,
      })
      if (display === lastEditedText || liveUiClosed) return
      lastEditedText = display
      lastLiveRenderAt = Date.now()
      const dwell = advanceLiveProgressDwell({
        text: liveDetail,
        lastText: lastRenderedProgressText,
        renderedAt: lastLiveRenderAt,
        holdUntil: liveProgressHoldUntil,
      })
      lastRenderedProgressText = dwell.lastText
      liveProgressHoldUntil = dwell.holdUntil
      const target = workMessage
      if (!await awaitBounded(target.edit(display)) && workMessage === target) {
        abandonWedgedPlaceholder()
      }
    })().catch(e => { console.error('[live-ui] progress edit failed:', e) })
    liveEditTask = task
    await task
    if (liveEditTask === task) liveEditTask = null
  }
  const queueLiveRender = (): void => {
    if (liveUiClosed) return
    liveRenderDirty = true
    if (liveEditTask || liveRenderTimer) return
    const intervalAt = lastLiveRenderAt + LIVE_UPDATE_INTERVAL_MS
    const delay = Math.max(0, Math.max(intervalAt, liveProgressHoldUntil) - Date.now())
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = null
      if (liveUiClosed || !liveRenderDirty) return
      liveRenderDirty = false
      void renderLiveNow().finally(() => {
        if (liveRenderDirty) queueLiveRender()
      })
    }, delay)
  }

  const queueLiveText = (raw: string, rememberProgress: boolean, footer = ''): void => {
    if (liveUiClosed) return
    if (rememberProgress) {
      liveProgressHoldUntil = liveProgressHoldForReplacement({
        text: raw,
        currentText: liveDetail,
        holdUntil: liveProgressHoldUntil,
      })
    }
    liveDetail = raw.trim()
    liveFooter = footer.trim()
    if (rememberProgress) lastProgressText = liveDetail
    queueLiveRender()
  }

  const compactAndDropCodexSession = async (reason: string, inputTokens?: number) => {
    let compacted = false
    try {
      if (summarizer) {
        const summaryRun = await settleWithin(
          summarizer.runForChannel(channelId),
          SESSION_ROLLOVER_SUMMARY_TIMEOUT_MS,
        )
        if (summaryRun.status === 'fulfilled') compacted = !!summaryRun.value
        else console.error(
          `[session-rollover] summarization timed out for ${channelId} after `
          + `${SESSION_ROLLOVER_SUMMARY_TIMEOUT_MS}ms; continuing final render`,
        )
      }
    } catch (e) {
      console.error(`[session-rollover] summarization failed for ${channelId}:`, e)
    }
    channelSessions.dropSession(channelId)
    console.log(`[session-rollover] channel ${channelId}: ${reason}`
      + (inputTokens !== undefined ? ` input=${inputTokens}` : '')
      + ` >= ${CODEX_SESSION_MAX_INPUT_TOKENS} — `
      + `${compacted ? 'compacted summary, ' : 'summary unavailable, '}`
      + `dropped session; next turn starts fresh`)
  }
  let pendingPostTurnRolloverUsage: number | undefined
  const finishPostTurnRollover = async (): Promise<void> => {
    const rolloverUsage = pendingPostTurnRolloverUsage
    if (rolloverUsage === undefined) return
    pendingPostTurnRolloverUsage = undefined
    await compactAndDropCodexSession('post-turn', rolloverUsage)
  }

  // Live tool trace: start a row as soon as a tool fires, then enrich that same
  // row with output/failure/diff when the tool completes. The final render still
  // replaces this with canonical result.toolCalls after the turn.
  const liveToolRows: ToolCall[] = []
  let liveAgents: CodexAgentSnapshot[] = []
  let agentSpinnerFrame = 0
  let liveTraceMsgs: Message[] = []
  let liveTracePending = false
  let liveTraceDirty = false
  let liveTraceClosed = false
  let liveWorkRehomeTask: Promise<void> | null = null
  let liveTraceRehomeTask: Promise<void> | null = null
  const transientTraceCleanupArmed = new Set<string>()
  // Failsafe cleanup for collapse mode: the normal linger delete is only scheduled
  // at END of turn. If the process dies mid-turn, DeferredActions.rearm() still
  // removes the orphan after a restart. The lease must outlive the turn watchdog:
  // the old fixed three-minute TTL deleted healthy trace cards during long repo
  // work, after which later edits targeted already-deleted Discord messages.
  const failsafeArmed = new Set<string>()
  const armTraceFailsafe = (m: Message) => {
    if (!transientTrace || failsafeArmed.has(m.id)) return
    failsafeArmed.add(m.id)
    const ttl = resolveTraceFailsafeMs(
      process.env.GPT_TRACE_FAILSAFE_MS,
      codexTimeoutMs({ userMessage: userText, extraText }),
    )
    deferredActions.schedule(client, { channelId: m.channelId, messageId: m.id, action: 'delete', dueAt: Date.now() + ttl })
  }
  const rehomeLiveWorkBelowTrace = async (
    traceChannel: TextChannel | DMChannel | ThreadChannel,
  ): Promise<void> => {
    if (targetMessage || liveUiClosed || !workMessage) return
    if (liveWorkRehomeTask) {
      await liveWorkRehomeTask
      return
    }
    const task = (async () => {
      if (liveEditTask) await liveEditTask.catch(() => {})
      const previous = workMessage
      if (!previous || liveUiClosed) return
      const content = previous.content || lastEditedText || `💭 ✻ **${effortLabel}…**`
      const replacement = await traceChannel.send(content).catch(() => null)
      if (!replacement || liveUiClosed) {
        if (replacement) await replacement.delete().catch(() => {})
        return
      }
      workMessage = replacement
      pendingPlaceholders.untrack(previous.id)
      pendingPlaceholders.track(message.channel.id, replacement.id, message.id)
      placeholderId = replacement.id
      await previous.delete().catch(() => {})
      startSpinner()
      queueLiveRender()
    })()
    liveWorkRehomeTask = task
    await task
    if (liveWorkRehomeTask === task) liveWorkRehomeTask = null
  }
  const rehomeLiveTraceAtBottom = async (
    traceChannel: TextChannel | DMChannel | ThreadChannel,
    below: Message | null,
  ): Promise<void> => {
    if (flags.trace !== 'live' || liveTraceClosed || !below || !liveTraceMsgs.length) return
    if (liveTraceRehomeTask) {
      await liveTraceRehomeTask
      return rehomeLiveTraceAtBottom(traceChannel, below)
    }
    const anchor = liveTraceMsgs.at(-1)
    if (!anchor || !isNewerDiscordMessage(below.id, anchor.id)) return
    const task = (async () => {
      const previousTraceMessages = [...liveTraceMsgs]
      const replacements: Message[] = []
      for (const current of previousTraceMessages) {
        const replacement = await traceChannel.send(current.content).catch(() => null)
        if (!replacement) {
          for (const sent of replacements) await sent.delete().catch(() => {})
          return
        }
        replacements.push(replacement)
      }
      if (liveTraceClosed) {
        for (const sent of replacements) await sent.delete().catch(() => {})
        return
      }
      liveTraceMsgs = replacements
      for (const replacement of replacements) armTraceFailsafe(replacement)
      for (const previous of previousTraceMessages) await previous.delete().catch(() => {})
    })()
    liveTraceRehomeTask = task
    await task
    if (liveTraceRehomeTask === task) liveTraceRehomeTask = null
  }
  const flushLiveTrace = () => {
    if (liveTraceClosed || liveTracePending
        || (!liveToolRows.length && !liveAgents.length)
        || !message.channel.isSendable()) return
    const traceChannel = message.channel as TextChannel | DMChannel | ThreadChannel
    liveTracePending = true
    const cards = appendAgentsPanel(
      liveToolRows.length ? renderTraceCards(buildTraceLines(liveToolRows), flags.trace) : [],
      liveAgents,
      Date.now(),
      agentSpinnerFrame,
    )
    ;(async () => {
      if (liveTraceClosed) return
      let appendedTraceCard = false
      for (let i = 0; i < cards.length; i++) {
        if (liveTraceClosed) return
        if (liveTraceMsgs[i]) {
          if (liveTraceMsgs[i].content !== cards[i]) {
            await liveTraceMsgs[i].edit(cards[i]).catch(() => {})
          }
        }
        else {
          liveTraceMsgs[i] = await traceChannel.send(cards[i])
          appendedTraceCard = true
          armTraceFailsafe(liveTraceMsgs[i])
        }
      }
      for (const stale of liveTraceMsgs.slice(cards.length)) {
        if (liveTraceClosed) return
        await stale.delete().catch(() => {})
      }
      liveTraceMsgs = liveTraceMsgs.slice(0, cards.length)
      if (flags.trace === 'collapse' && appendedTraceCard) await rehomeLiveWorkBelowTrace(traceChannel)
    })().catch(() => {
      // Trace display is diagnostic only; never fail the user turn over Discord.
    }).finally(() => {
      liveTracePending = false
      if (liveTraceDirty) {
        liveTraceDirty = false
        flushLiveTrace()
      }
    })
  }

  const markLiveTraceDirty = () => {
    if (liveTracePending) liveTraceDirty = true
    else flushLiveTrace()
  }
  pulseAgentPanel = () => {
    if (!liveAgents.some(agent => agent.status === 'running')) return
    agentSpinnerFrame++
    markLiveTraceDirty()
  }
  const deleteLiveTrace = async () => {
    liveTraceClosed = true
    const msgs = liveTraceMsgs
    liveTraceMsgs = []
    liveTraceDirty = false
    for (const m of msgs) await m.delete().catch(() => {})
  }
  const scheduleTransientTraceCleanup = (msgs: Message[]): void => {
    if (!transientTrace || !msgs.length) return
    const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 60_000
    for (const m of msgs) {
      if (transientTraceCleanupArmed.has(m.id)) continue
      transientTraceCleanupArmed.add(m.id)
      deferredActions.schedule(client, {
        channelId: m.channelId,
        messageId: m.id,
        action: 'delete',
        dueAt: Date.now() + lingerMs,
      })
    }
  }
  const refreshAgentView = async (agents: CodexAgentSnapshot[]) => {
    liveAgents = agents
    agentSpinnerFrame++
    if (!liveAgents.length && !liveToolRows.length) await deleteLiveTrace()
    else markLiveTraceDirty()
  }
  activeAgentViews.set(channelId, refreshAgentView)

  const findLiveToolRow = (name: string, args?: Record<string, unknown>): ToolCall | null => {
    const short = shortToolName(name)
    const wantedPath = typeof args?.file_path === 'string' ? args.file_path : ''
    for (let i = liveToolRows.length - 1; i >= 0; i--) {
      const row = liveToolRows[i]
      if (shortToolName(row.name) !== short) continue
      if (wantedPath) {
        const rowPath = typeof row.args.file_path === 'string' ? row.args.file_path : ''
        if (rowPath && rowPath !== wantedPath) continue
      }
      if (!row.resultPreview && !row.diff) return row
    }
    for (let i = liveToolRows.length - 1; i >= 0; i--) {
      const row = liveToolRows[i]
      if (shortToolName(row.name) === short) return row
    }
    return null
  }

  const onEvent = (event: LifecycleEvent) => {
    if (event.type === 'thinking_start') { void lifecycle.reasoning(); return }
    if (event.type === 'reasoning_start') { void lifecycle.reasoning(); return }
    if (event.type === 'searching') { void lifecycle.transition('searching'); return }
    if (event.type === 'agents') {
      agentCommands.record(channelId, agentWorkflowId, event.agents)
      if (flags.trace !== 'off') {
        liveAgents = agentCommands.snapshot(channelId, agentWorkflowId)
        agentSpinnerFrame++
        markLiveTraceDirty()
      }
      return
    }
    if (event.type === 'tool_start') {
      void lifecycle.toolStarted()
      if (flags.trace !== 'off') {
        liveToolRows.push({
          name: event.name,
          args: liveStartArgs(event.name, event.args),
          durationMs: 0,
          resultPreview: '',
          failed: false,
        })
        markLiveTraceDirty()
      }
      return
    }
    if (event.type === 'tool_end') {
      if (!event.update) void lifecycle.toolEnded()
      if (flags.trace !== 'off') {
        const row = findLiveToolRow(event.name, event.args)
        const target = row ?? {
          name: event.name,
          args: event.args ?? {},
          durationMs: 0,
          resultPreview: '',
          failed: false,
        }
        target.args = event.args ?? target.args
        target.durationMs = event.durationMs ?? target.durationMs
        target.resultPreview = event.resultPreview ?? target.resultPreview
        target.resultLines = event.resultLines ?? target.resultLines
        target.failed = event.failed ?? target.failed
        target.diff = event.diff ?? target.diff
        if (!row) liveToolRows.push(target)
        markLiveTraceDirty()
      }
      return
    }
    if (event.type === 'status') {
      // Tool events already drive the lifecycle reaction and detailed trace.
      // Do not duplicate them as a generic narration line in the work card.
      return
    }
    if (event.type === 'progress') {
      if (flags.thinking === 'collapse') {
        liveNarrationTrace = appendNarrationTrace(liveNarrationTrace, event.reply)
      }
      queueLiveText(event.reply, true)
      return
    }
    if (event.type === 'reasoning_progress') {
      void lifecycle.reasoning()
      const reasoningIsVisible = flags.thinking !== 'off'
      if (flags.thinking === 'on' || flags.thinking === 'collapse') {
        if (liveReasoningTrace.at(-1) !== event.text) liveReasoningTrace.push(event.text)
      } else if (reasoningIsVisible) {
        liveHeadline = latestReasoningHeadline(event.text)
      }
      if (shouldReplaceNarrationWithReasoning(reasoningIsVisible)) {
        lastProgressText = ''
        liveDetail = ''
        liveFooter = ''
        queueLiveRender()
      }
      return
    }
    if (event.type === 'heartbeat') {
      // A model can be healthy but silent between public commentary events. Keep
      // proof-of-life visible independently of the model's willingness to narrate.
      // The footer and top spinner are composed by the same render owner.
      if (!shouldRenderHeartbeat(event.elapsedMs, event.idleMs, HEARTBEAT_DELAY_MS)) {
        if (liveFooter) {
          liveFooter = ''
          queueLiveRender()
        }
        return
      }
      const base = lastProgressText
      const visual = heartbeatVisual(heartbeatFrame, heartbeatVerb)
      heartbeatFrame++
      heartbeatVerb = visual.verb
      const footer = formatHeartbeatFooter(event.elapsedMs, event.idleMs, visual.verb, visual.glyph)
      queueLiveText(base, false, footer)
      return
    }
    if (event.type === 'partial') {
      // Final-output streaming deliberately has no ownership of workMessage.
      // That message is the durable thought/progress surface; editing partial
      // answer text into it made the thought card disappear or overwrite the
      // final render. Native typing remains active until the completed result
      // is rendered once by the final-output path below.
      return
    }
  }

  try {
    throwIfStopped()
    // Codex-as-default-chat: route text turns through the Codex subscription CLI,
    // self-web-searching) instead of the metered API. Downloaded images are passed
    // to Codex as local files. Automatic API routing is reserved for a confirmed
    // dead Codex child and can only report a postmortem; it never continues the
    // task. Explicit API-engine channels still receive the normal tool-capable
    // request. Kill switch: GPT_CODEX_CHAT=0.
    const apiInput: RespondInput = {
      systemPrompt,
      history,
      userMessage: userText,
      userName,
      model,
      reasoningEffort: apiEffort(flags.reasoning),
      imageParts,
      extraText,
      toolRegistry,
      channelId,
      userId,
      onEvent
    }
    const apiRespond = () => openai.respond(apiInput)
    const apiPostmortemRespond = (
      error: CodexInterruptedError | CodexProcessDiedError,
    ) => openai.respond(buildCodexFailurePostmortemRequest({
      base: apiInput,
      error,
      lastProgress: lastProgressText || liveDetail || liveHeadline,
      recentTools: liveToolRows.map(tool => `${tool.name}${tool.failed ? ' (failed)' : ''}`),
    }))

    let result: RespondResult
    let codexFailureLifecycle: 'interrupted' | 'errored' | null = null
    if (flags.engine !== 'api' && process.env.GPT_CODEX_CHAT !== '0') {
      try {
        let resumeSessionId = channelSessions.get(channelId)
        const lastInput = channelSessions.lastUsage(channelId)?.input ?? 0
        if (resumeSessionId && CODEX_SESSION_MAX_INPUT_TOKENS > 0 && lastInput >= CODEX_SESSION_MAX_INPUT_TOKENS) {
          await compactAndDropCodexSession('preflight', lastInput)
          throwIfStopped()
          resumeSessionId = undefined
        }
        const codexInput = {
          systemPrompt,
          history,
          userMessage: userText,
          userName,
          reasoningEffort: flags.reasoning,
          codexModel: flags.codexModel,
          extraText,
          imagePaths,
          channelId,
          turnGeneration,
          resumeSessionId,
          signal: stopController.signal,
          onEvent,
          steering: steeringInbox ?? undefined,
        }
        result = await respondViaCodex(codexInput)

        // Codex CLI's exit status only proves the child finished. If its
        // authoritative final still declares ongoing work, resume the exact
        // session instead of publishing a progress update as task completion.
        let completionContinuations = 0
        let totalDurationMs = result.durationMs
        const allToolCalls = [...result.toolCalls]
        const allFiles = [...(result.files ?? [])]
        const allTemporaryFiles = [...(result.temporaryFiles ?? [])]
        while (isNonTerminalActionReply(result.reply ?? '')) {
          if (!result.threadId || completionContinuations >= MAX_COMPLETION_CONTINUATIONS) {
            throw new NonTerminalCompletionError(completionContinuations)
          }
          completionContinuations++
          console.error(
            `[completion-gate] continuing non-terminal final in channel ${channelId} ` +
            `(${completionContinuations}/${MAX_COMPLETION_CONTINUATIONS})`,
          )
          const retry = await respondViaCodex({
            ...codexInput,
            history: [],
            userMessage: completionContinuationPrompt(completionContinuations),
            extraText: undefined,
            imagePaths: undefined,
            resumeSessionId: result.threadId,
          })
          totalDurationMs += retry.durationMs
          allToolCalls.push(...retry.toolCalls)
          allFiles.push(...(retry.files ?? []))
          allTemporaryFiles.push(...(retry.temporaryFiles ?? []))
          retry.durationMs = totalDurationMs
          retry.toolCalls = [...allToolCalls]
          retry.files = [...new Set(allFiles)]
          retry.temporaryFiles = [...new Set(allTemporaryFiles)]
          result = retry
        }
        if (result.threadId) channelSessions.set(channelId, result.threadId)
        // App-server usage is already the sum of every model roundtrip in this
        // turn. Only legacy resumed CLI sessions report a cumulative snapshot
        // that needs subtraction against the saved channel baseline.
        if (result.usage) {
          const current = {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
            cachedInput: result.usage.cachedInputTokens,
            reasoning: result.usage.reasoningTokens,
          }
          const d = result.usageIsCumulative
            ? channelSessions.usageDelta(channelId, current)
            : current
          result.usageDelta = {
            inputTokens: d.input,
            outputTokens: d.output,
            cachedInputTokens: d.cachedInput,
            reasoningTokens: d.reasoning,
          }
        }
        // Post-turn rollover still matters for the first turn that crosses the
        // cap: we cannot know that until Codex reports usage, so compact/drop
        // after the visible answer and trace-cleanup lease are committed. Session
        // housekeeping must never hold the reply UI hostage.
        if (CODEX_SESSION_MAX_INPUT_TOKENS > 0
            && (result.usage?.inputTokens ?? 0) >= CODEX_SESSION_MAX_INPUT_TOKENS) {
          pendingPostTurnRolloverUsage = result.usage!.inputTokens
        }
        setEnginePresence(false)
      } catch (e) {
        if (e instanceof NonTerminalCompletionError) {
          await settleLiveUi()
          await deleteLiveTrace()
          void lifecycle.transition('errored')
          if (workMessage) await workMessage.edit(
            `⚠️ **completion gate stopped ${e.attempts} repeated progress-only finals; the task did not complete**`,
          ).catch(() => {})
          return
        }
        if (e instanceof CodexStoppedError) {
          // A deferred barge and an explicit /gpt stop both abort the Codex
          // child, but only the explicit stop should leave an Interrupted
          // tombstone. Steering silently retires the superseded UI and clears
          // its lifecycle reactions before the queued replacement takes over.
          const steeredAfter = activeTurns.consumeSteered(channelId)
          await lifecycle.transition(steeredAfter !== null ? 'silenced' : 'interrupted')
          await settleLiveUi()
          await deleteLiveTrace()
          if (steeredAfter !== null) {
            if (workMessage) await workMessage.edit(
              renderSteeredMessage(workMessage.content, steeredAfter),
            ).catch(() => {})
          } else {
            await renderInterruptedTurn()
          }
          return
        }
        // An intentional restart must never become an API postmortem. Deploys now
        // signal only MainPID, but retain this guard for shutdown races and old
        // senders that may still target the service cgroup.
        if (shutdownGate.isDraining()) {
          logTurnLifecycle({
            event: 'fallback_suppressed',
            channelId,
            generation: turnGeneration,
            engine: 'codex',
            fallbackReason: 'restart_drain',
            restartPhase: 'draining',
          })
          console.error('codex exited during graceful restart; suppressing API postmortem')
          await settleLiveUi()
          await deleteLiveTrace()
          if (workMessage) await workMessage.edit('↻ **restart in progress — queued work will resume when gpt is back**').catch(() => {})
          return
        }
        if (!isCodexFailurePostmortemEligible(e)) {
          logTurnLifecycle({
            event: 'fallback_suppressed', channelId, generation: turnGeneration,
            engine: 'codex', fallbackReason: 'codex_failure_unconfirmed',
          })
          console.error('codex failed without a confirmed child-process death; suppressing API postmortem:', e)
          await settleLiveUi()
          await deleteLiveTrace()
          void lifecycle.transition('errored')
          if (workMessage) await workMessage.edit('⚠️ **codex hit an error — API postmortem suppressed**').catch(() => {})
          return
        }
        const fallbackWaitMs = codexFallbackWaitMs(e, CODEX_FALLBACK_MIN_ELAPSED_MS)!

        // A confirmed dead/timed-out Codex child invalidates the resumable session.
        // Wait until the attempt has been dead or running for the configured grace
        // window before spending API tokens; steering can still abort this wait.
        channelSessions.dropSession(channelId)
        if (fallbackWaitMs > 0) {
          if (workMessage) await workMessage.edit(
            `⏳ **codex exited — waiting ${Math.ceil(fallbackWaitMs / 1000)}s before API postmortem…**`,
          ).catch(() => {})
          try {
            await sleep(fallbackWaitMs, undefined, { signal: stopController.signal })
          } catch {
            throwIfStopped()
          }
          throwIfStopped()
        }

        if (e instanceof CodexInterruptedError) {
          logTurnLifecycle({
            event: 'engine_fallback', channelId, generation: turnGeneration,
            engine: 'api', fallbackReason: 'codex_interrupted',
          })
          console.error('codex interrupted by backstop; requesting API postmortem:', e.message)
          void lifecycle.transition('interrupted')
          codexFailureLifecycle = 'interrupted'
          if (workMessage) { await workMessage.edit('⏳ **codex turn interrupted — API is writing the postmortem…**').catch(() => {}) }
        } else if (e instanceof CodexProcessDiedError) {
          logTurnLifecycle({
            event: 'engine_fallback', channelId, generation: turnGeneration,
            engine: 'api', fallbackReason: 'codex_process_died',
          })
          console.error('codex process confirmed dead after fallback grace; requesting API postmortem:', e)
          void lifecycle.transition('errored')
          codexFailureLifecycle = 'errored'
          if (workMessage) { await workMessage.edit('⚠️ **codex exited — API is writing the postmortem…**').catch(() => {}) }
        }
        throwIfStopped()
        result = await apiPostmortemRespond(e)
        setEnginePresence(true)
      }
    } else {
      throwIfStopped()
      result = await apiRespond()
    }

    // Result is in hand — stop all "still working" indicators before rendering.
    // Cancel the deferred-placeholder timer (a fast turn beat the delay → no
    // transient bubble) and the typing heartbeat, alongside the spinner.
    if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
    await settleLiveUi(true)
    if (stopController.signal.aborted) throw new CodexStoppedError(result.durationMs)
    temporaryResultFiles = result.temporaryFiles ?? []
    // Record completed usage for the cumulative stats ledger and live handoff.
    recordCacheTurn(channelId, result)
    result.reply = stripToolTraceCard(result.reply ?? '')

    // @gpt can set its own Discord status: a [[presence: …]] directive in the reply
    // is applied to the bot presence + stripped from the message.
    {
      const pm = result.reply?.match(/\[\[presence:\s*([^\]]+)\]\]/i)
      if (pm) {
        applyBasePresence(pm[1].trim())
        result.reply = (result.reply ?? '').replace(/\[\[presence:\s*[^\]]+\]\]/ig, '').trim()
      }
    }


    // codex can produce image files (e.g. a screenshot via its shell / the
    // playwright MCP) but only references them by NAME or local path in the reply
    // text — it has no Discord-attach hook like the API/MCP path does. So pull
    // image references that resolve to a real file on disk, attach the real files,
    // and strip the dead path/link from the text. (Jeff 2026-06-25)
    //
    // KEY: codex's cwd is its HOME (~), NOT gpt's process cwd (repos/gpt-bot), and
    // the model frequently picks a BARE filename ("airbnb-listings.png") that
    // playwright writes into codex's cwd. So an existsSync on the literal string
    // fails (wrong cwd) and bare names aren't even absolute. resolveShot() tries
    // the literal path, then ~/<name>, then a couple of known screenshot dirs.
    if (result.reply) {
      // codex-chat runs codex from /tmp (see codex-chat.ts `cd /tmp && codex
      // exec`), so a bare-filename screenshot lands in /tmp. Also check ~ (manual
      // codex runs) and the MCP output dirs. /tmp first — it's the live path.
      const CODEX_CWD = '/tmp'
      // The Playwright MCP wrapper `cd`s into its output dir before exec, so a
      // bare-name screenshot ("koyfin.jpg") resolves THERE, not /tmp. That dir
      // was renamed playwright-mcp-output → computer-use on 2026-06-25; gpt-bot's
      // lookup wasn't updated, so resolveShot() failed to find real screenshots
      // and posted the raw path instead of the image (Jeff 2026-06-25). Honor
      // the same COMPUTER_USE_OUTPUT_DIR / PLAYWRIGHT_OUTPUT_DIR knobs the wrapper
      // uses, with the current dir first, and keep the legacy dirs for back-compat.
      const MCP_OUT = process.env.COMPUTER_USE_OUTPUT_DIR
        || process.env.PLAYWRIGHT_OUTPUT_DIR
        || path.join(os.homedir(), '.cache', 'computer-use')
      const SHOT_DIRS = [
        CODEX_CWD,
        MCP_OUT,
        os.homedir(),
        path.join(os.homedir(), '.cache', 'computer-use'),
        path.join(os.homedir(), '.cache', 'playwright-mcp-output'),
        path.join(os.homedir(), '.cache', 'gpt-mcp-images'),
      ]
      const resolveShot = (raw: string): string | null => {
        // Try the literal path, then the basename under each known screenshot dir
        // (covers both bare names and absolute paths that point at the wrong cwd).
        const cands = [raw, ...SHOT_DIRS.map(d => path.join(d, path.basename(raw)))]
        for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
        return null
      }
      const shots: string[] = []
      const grab = (m: string, p: string): string => {
        const real = resolveShot(p)
        if (real) { shots.push(real); return '' }
        return m
      }
      const txt = result.reply
        // markdown image/link: ![alt](path) or [text](path)
        .replace(/!?\[[^\]]*\]\(([^)\s]+\.(?:png|jpe?g|gif|webp))\)/gi, (m, p) => grab(m, p))
        // backtick-wrapped path/name: `airbnb-listings.png` or `/abs/x.jpg`
        .replace(/`([^`\s]+\.(?:png|jpe?g|gif|webp))`/gi, (m, p) => grab(m, p))
        // bare absolute path or bare filename token
        .replace(/(?<![\w/])((?:\/[^\s)]+|[\w.-]+)\.(?:png|jpe?g|gif|webp))(?![\w])/gi, (m, p) => grab(m, p))
      if (shots.length) {
        // De-dupe (the same file can match multiple patterns).
        const uniq = [...new Set(shots)]
        result.reply = txt.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
        result.files = [...(result.files ?? []), ...uniq]
      }
    }

    if (result.react) {
      // Outbound react validator: the model occasionally emits custom Discord
      // emoji names from past channel context (`:pack_sticker_14:`, `:foo:123`),
      // which the reactions PUT endpoint rejects with 'Unknown Emoji' (10014)
      // unless the bot shares a server hosting that emoji. Silently drop
      // anything that isn't a pure Unicode emoji to spare Discord (and the
      // log) the noise. The reply still posts; only the react is suppressed.
      if (isValidOutboundReactEmoji(result.react)) {
        try { await message.react(result.react) } catch (e) { console.error('react failed:', e) }
      } else {
        console.log(`[react] dropped invalid outbound emoji: ${JSON.stringify(result.react)}`)
      }
    }

    // Verbose footer surfaces token cost. Cache + reasoning shards only
    // render when nonzero so the footer stays compact for cheap turns.
    const verbose = (() => {
      if (flags.counter === 'off' || !result.usage) return ''
      // Prefer the per-turn DELTA (codex resume reports cumulative usage; the
      // delta is this turn's marginal cost). Falls back to usage on the API path
      // where it's already per-turn. (Jeff 2026-06-25 "token up/down accurate")
      const u = result.usageDelta ?? result.usage
      return formatUsageCounter(flags.counter, u, result.durationMs)
    })()

    // Discord has no h1-h6 headings; markdown '#'..'######' render as a
    // literal '#### text'. Convert heading lines to bold and swallow the blank
    // line after them so `**Heading**` sits directly above its body.
    // historyFetchFailed: the message-history fetch threw earlier this turn, so
    // the model answered with NO conversation context — flag it visibly instead
    // of degrading silently (Jeff 2026-07-08). Kept on top of the newer
    // closeDanglingInlineCode pass rather than replacing it.
    const degradedNotice = historyFetchFailed ? '⚠️ *replying with reduced context — history fetch failed*\n\n' : ''
    const replyBody = closeDanglingInlineCode((result.reply ?? '').trim())
    const body = degradedNotice + stripToolTraceCard(headingsToBold(replyBody)) + verbose + (verbose ? '\n\u200b' : '')

    if (!body.trim() && !result.files?.length) {
      await lifecycle.transition(codexFailureLifecycle ?? 'silenced')
      if (workMessage && !targetMessage) {
        try { await workMessage.delete() } catch {}
      }
      scheduleTransientTraceCleanup(liveTraceMsgs)
      await finishPostTurnRollover()
      return
    }
    if (!body.trim() && result.files?.length) {
      if (workMessage && !targetMessage) {
        try { await workMessage.delete() } catch {}
        workMessage = null
      }
      if (message.channel.isSendable()) {
        await message.channel.send({ files: result.files.slice(0, 10) })
      }
      await lifecycle.transition(codexFailureLifecycle ?? 'replied')
      scheduleTransientTraceCleanup(liveTraceMsgs)
      await finishPostTurnRollover()
      return
    }

    const willThinking = flags.thinking !== 'off' && !!result.reasoning?.trim() && message.channel.isSendable()
    let finalAgents = result.agents?.length ? result.agents : liveAgents
    if (finalAgents.length) {
      agentCommands.record(channelId, agentWorkflowId, finalAgents)
      finalAgents = agentCommands.snapshot(channelId, agentWorkflowId)
    }
    const willTrace = flags.trace !== 'off'
      && (result.toolCalls.length > 0 || finalAgents.length > 0)
      && message.channel.isSendable()
    await settleLiveUi()
    const transientTraceMsgs: Message[] = []
    const thoughtLine = `💭 ✓ **thought for ${fmtDur(result.durationMs)}**`
    let completedThinking = thoughtLine
    if (willThinking) {
      completedThinking = flags.thinking === 'on' || flags.thinking === 'collapse'
        ? formatReasoningTraceSnapshot(
            liveReasoningTrace.length ? liveReasoningTrace : [result.reasoning!],
            thoughtLine,
          )
        : formatReasoningSnapshot(result.reasoning!, thoughtLine)
    }

    // Tool-trace card — gem-bot diff format: `+ ● shortName(argDigest) [Nms]`
    // (green), `- ● ... FAILED [Nms]` (red) on failure, grey `  ⎿ resultPreview`.
    if (willTrace && !liveTraceMsgs.length) {
      const cards = appendAgentsPanel(
        result.toolCalls.length ? renderTraceCards(buildTraceLines(result.toolCalls), flags.trace) : [],
        finalAgents,
        Date.now(),
        agentSpinnerFrame,
        true,
      )
      for (const card of cards) {
        try {
          const sent = await message.channel.send(card)
          if (transientTrace) transientTraceMsgs.push(sent)
        } catch {}
      }
    }

    // If we streamed the trace live, replace it with the final canonical version
    // (full names + per-call timings from result.toolCalls).
    if (liveTraceMsgs.length && willTrace) {
      const lines = buildTraceLines(result.toolCalls)
      const cards = appendAgentsPanel(
        lines.length ? renderTraceCards(lines, flags.trace) : [],
        finalAgents,
        Date.now(),
        agentSpinnerFrame,
        true,
      )
      for (let i = 0; i < cards.length; i++) {
        if (liveTraceMsgs[i]) {
          if (liveTraceMsgs[i].content !== cards[i]) {
            try { await liveTraceMsgs[i].edit(cards[i]) } catch {}
          }
        } else {
          try { liveTraceMsgs[i] = await message.channel.send(cards[i]); armTraceFailsafe(liveTraceMsgs[i]) } catch {}
        }
      }
      for (const stale of liveTraceMsgs.slice(cards.length)) {
        try { await stale.delete() } catch {}
      }
      liveTraceMsgs = liveTraceMsgs.slice(0, cards.length)
    }

    // "thought for Ns" sits ON TOP of the reply, in the SAME message block (Jeff
    // 2026-06-24) — small-text first line, then the answer. We reuse the placeholder
    // as the first message so the thought line replaces "thinking…" in place AND the
    // reply flows directly beneath it (one block). Persistence: keep the thought
    // line indefinitely ONLY when trace='on'; for trace 'collapse'/'off' it's a
    // transient duration tag, stripped after a 60s linger (Jeff 2026-06-24).
    // N = total turn time (codex has no per-item timing).
    const persist = flags.trace === 'on'
    const firstChunkLimit = Math.max(1000, 2000 - completedThinking.length - 16)
    const parts = chunk(body, firstChunkLimit)
    const firstWithThought = `${completedThinking}\n${parts[0] ?? ''}`
    let mergedMsg: Message | null = null
    let bottomContentMessage: Message | null = null
    // Tool cards belong above the reply. Thinking no longer gets stranded in its
    // own card: its final brain line stays directly under "thought for" in this
    // merged reply until the short live linger expires.
    if (willTrace && workMessage && !targetMessage) {
      try { await workMessage.delete() } catch {}
      workMessage = null
    }
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) {
        if (workMessage && !targetMessage) {
          await workMessage.edit(firstWithThought)
          mergedMsg = workMessage
          workMessage = null
        } else {
          mergedMsg = await replyOrSend(message, firstWithThought, !actor)
        }
        bottomContentMessage = mergedMsg
      } else if (message.channel.isSendable()) {
        bottomContentMessage = await message.channel.send(parts[i])
      }
    }
    // `live` and `collapse` keep the completed brain line(s) attached to the
    // answer for the short live linger, then remove only those quote lines.
    // `on` intentionally keeps its reasoning visible.
    const transientThinking = flags.thinking === 'live' || flags.thinking === 'collapse'
    const lingerCompletedThinking = shouldLingerLiveEnd({
      isRegeneration: !!targetMessage,
      hasLiveState: transientThinking && willThinking,
    })
    if (lingerCompletedThinking && mergedMsg) {
      const settledMessage = mergedMsg
      const settleThinking = () => {
        void settledMessage.edit(`${thoughtLine}\n${parts[0] ?? ''}`).catch(() => {})
      }
      if (LIVE_END_LINGER_MS > 0) {
        const timer = setTimeout(settleThinking, LIVE_END_LINGER_MS)
        timer.unref?.()
      } else {
        settleThinking()
      }
    }
    // Attach any screenshots a tool produced this turn (Playwright browser_take_
    // screenshot → saved to disk → path collected on result.files). Sent as a
    // follow-up message so it works regardless of the edit-vs-reply branch above,
    // and so the visual lands right under the text. Discord caps 10 files/msg.
    if (result.files?.length && message.channel.isSendable()) {
      try {
        bottomContentMessage = await message.channel.send({ files: result.files.slice(0, 10) })
      } catch (e) {
        console.error('screenshot attach failed:', e instanceof Error ? e.message : e)
      }
    }
    if (message.channel.isSendable()) {
      await rehomeLiveTraceAtBottom(
        message.channel as TextChannel | DMChannel | ThreadChannel,
        bottomContentMessage,
      )
    }
    // Transient thought line: after the linger, strip just the thought prefix from
    // the merged message, leaving the reply body intact.
    if (!persist && mergedMsg) {
      const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 60_000
      deferredActions.schedule(client, { channelId: mergedMsg.channelId, messageId: mergedMsg.id, action: 'strip', content: parts[0] ?? '', dueAt: Date.now() + lingerMs })
    }

    // Both transient modes disappear after the configured linger. Collapse keeps
    // every page; live keeps one rolling window.
    const toDelete: Message[] = [...transientTraceMsgs]
    if (transientTrace && liveTraceMsgs.length) toDelete.push(...liveTraceMsgs)
    scheduleTransientTraceCleanup(toDelete)

    await finishPostTurnRollover()

    if (result.finishReason === 'length') {
      await lifecycle.transition(codexFailureLifecycle ?? 'truncated')
    } else {
      await lifecycle.transition(codexFailureLifecycle ?? 'replied')
    }
  } catch (e: any) {
    if (e instanceof CodexStoppedError) {
      const steeredAfter = activeTurns.consumeSteered(channelId)
      await lifecycle.transition(steeredAfter !== null ? 'silenced' : 'interrupted')
      await settleLiveUi()
      await deleteLiveTrace()
      try {
        if (steeredAfter !== null) {
          if (workMessage) await workMessage.edit(
            renderSteeredMessage(workMessage.content, steeredAfter),
          )
        } else {
          await renderInterruptedTurn()
        }
      } catch {}
      return
    }
    const isRejected = e instanceof OpenAIRequestRejected
    if (isRejected && e.reason === 'content_policy') {
      await lifecycle.transition('blocked')
    } else if (isRejected) {
      await lifecycle.transition('denied')
    } else {
      await lifecycle.transition('errored')
    }
    const errMsg = isRejected ? `⚠️ ${e.reason}` : `❌ error: ${e?.message ?? String(e)}`
    await settleLiveUi()
    console.error('respond failed:', e)
    await deleteLiveTrace()
    try {
      let errorMessage = workMessage
      if (errorMessage) {
        failedTurns.set(errorMessage.id, {
          channelId: message.channel.id,
          sourceMessageId: message.id,
          diagnostic: describeFailure(e),
        })
        await errorMessage.edit({ content: errMsg, components: [failureActions(errorMessage.id)] })
      } else {
        errorMessage = await replyOrSend(message, errMsg, !actor)
        if (errorMessage) {
          failedTurns.set(errorMessage.id, {
            channelId: message.channel.id,
            sourceMessageId: message.id,
            diagnostic: describeFailure(e),
          })
          await errorMessage.edit({ content: errMsg, components: [failureActions(errorMessage.id)] })
        }
      }
    } catch {}
  } finally {
    await finishPostTurnRollover()
    if (activeAgentViews.get(channelId) === refreshAgentView) activeAgentViews.delete(channelId)
    if (activeLifecycleTrackers.get(channelId) === lifecycle) activeLifecycleTrackers.delete(channelId)
    await cleanupAttachmentFiles(imagePaths).catch(e => console.error('attachment cleanup failed:', e))
    const temporaryDirs = new Set(temporaryResultFiles.map(file => path.dirname(file)))
    for (const file of temporaryResultFiles) {
      await fs.promises.rm(file, { force: true }).catch(e => console.error('result-file cleanup failed:', e))
    }
    for (const dir of temporaryDirs) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
    await settleLiveUi()
    await lifecycle.drain()
    if (placeholderId) pendingPlaceholders.untrack(placeholderId)
    steeringInbox?.close()
    activeTurns.done(channelId, turnGeneration)
    logTurnLifecycle({
      event: 'turn_finished',
      channelId,
      generation: turnGeneration,
      queueDepth: channelTurns.queueDepth(channelId),
    })
  }
}

// Per-channel turn queue: serialize turns within a channel so rapid-fire
// messages don't each spawn a parallel codex process. While a turn runs, new
// messages queue; when it finishes, ALL queued messages are batched into one
// follow-up turn (repeated until the queue drains). Cross-channel stays
// parallel — only same-channel pile-ups serialize. (Jeff 2026-06-25)
async function runChannelTurn(
  message: Message,
  target: Message | null,
  contentOverride?: string,
  actor?: TrustedRelay,
): Promise<void> {
  const cid = message.channel.id
  if (channelTurns.isRunning(cid) && activeTurns.isActive(cid)) {
    const replyText = formatReplyContext(await resolveReplyContext(message))
    const pinText = formatPinContext(await resolvePinContext(message))
    const threadText = formatThreadContext(await resolveThreadContext(message))
    const richText = formatRichContext(message)
    const text = contentOverride ?? [replyText, pinText, threadText, richText, message.content]
      .filter(Boolean).join('\n\n')
    if (await activeTurns.steer(
      cid,
      frameLiveSteerMessage(`[${actor?.userName ?? message.author.username}] ${text}`),
      () => activeLifecycleTrackers.get(cid)?.moveTo(message),
    )) {
      logTurnLifecycle({
        event: 'turn_steered', channelId: cid, queueDepth: channelTurns.queueDepth(cid),
      })
      return
    }
  }
  const steered = channelTurns.isRunning(cid)
  const outcome = await channelTurns.submit(cid, { message, target, contentOverride, actor, steered })
  if (outcome === 'queued') {
    logTurnLifecycle({
      event: 'turn_queued', channelId: cid, queueDepth: channelTurns.queueDepth(cid),
    })
  }
}

async function dispatchInboundMessage(message: Message): Promise<void> {
  const relayInput = {
    messageId: message.id,
    channelId: message.channel.id,
    authorId: message.author.id,
    content: message.content,
  }
  const relay = message.author.bot ? trustedRelays.verify(relayInput, false) : null
  if (message.author.bot && !relay) return
  const replyContext = relay ? null : await resolveReplyContext(message)
  if (client.user && isAddressedToAnotherUser(
    client.user.id,
    message.mentions.users.values(),
    message.content,
    replyContext ? { id: replyContext.authorId, bot: replyContext.authorIsBot } : null,
  )) return
  const release = shutdownGate.enter()
  if (!release) {
    // Only signal in channels this bot would actually have answered in. The
    // access gate lives inside handleInboundMessage (below), so reacting here
    // unconditionally put a ⏳ on messages in channels gpt-bot merely has
    // read access to — where it is not the responder and the other bots
    // handle in-flight messages themselves (Jeff 2026-07-31, family channel).
    const isMention = client.user
      ? message.mentions.users.has(client.user.id) || replyContext?.authorId === client.user.id
      : false
    const mine = access.canHandle({
      channelId: message.channel.id,
      parentChannelId: message.channel.isThread() ? message.channel.parentId : null,
      userId: relay?.userId ?? message.author.id,
      isMention: relay ? true : isMention,
    })
    if (!mine) return

    restartInbox.defer(message.channel.id, message.id)
    // Say something. A silent drop here is externally indistinguishable from a
    // crashed bot — that is exactly how this surfaced. The message is not lost
    // (restartInbox replays it after the restart), so ⏳ not ❌.
    void message.react('⏳').catch(() => {})
    logTurnLifecycle({
      event: 'message_deferred_for_restart',
      channelId: message.channel.id,
      restartPhase: 'draining',
    })
    return
  }
  try {
    const acceptedRelay = relay ? trustedRelays.verify(relayInput) ?? undefined : undefined
    if (relay && !acceptedRelay) return
    if (acceptedRelay) void message.delete().catch(() => {})
    await handleInboundMessage(message, replyContext, acceptedRelay)
  } finally {
    release()
  }
}

async function handleInboundMessage(
  message: Message,
  replyContext?: ReplyContext | null,
  relay?: TrustedRelay,
): Promise<void> {
  const channelId = message.channel.id
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null
  const userId = relay?.userId ?? message.author.id
  const inboundContent = relay?.payload ?? message.content
  const isMention = relay ? true : client.user
    ? message.mentions.users.has(client.user.id) || replyContext?.authorId === client.user.id
    : false
  if (client.user && isAddressedToAnotherUser(
    client.user.id,
    message.mentions.users.values(),
    message.content,
    replyContext ? { id: replyContext.authorId, bot: replyContext.authorIsBot } : null,
  )) return

  if (!relay && memoryStore && message.content.trim() && access.isAllowedAndEnabled(userId, channelId, parentChannelId)) {
    void ingestMessage(message)
    // Schedule summarization after ingestion so the message we just stored is
    // counted toward the threshold. Single-flight per channel; no-op if a
    // run is already in progress.
    summarizer?.scheduleIfNeeded(channelId)
  }

  if (!access.canHandle({ channelId, parentChannelId, userId, isMention })) return

  // Reserved before barge/queue handling: these are gpt's view-only agent
  // controls, never shell commands and never a reason to interrupt live work.
  const agentCommand = parseAgentCommand(inboundContent, client.user?.id)
  if (agentCommand) {
    const response = runAgentCommand(agentCommands, channelId, agentCommand)
    if (agentCommand.action === 'clear') {
      await activeAgentViews.get(channelId)?.(agentCommands.snapshot(channelId))
    }
    await replyOrSend(message, response, !relay)
    return
  }

  // Lone ❌ / X message: hard-kill the in-flight turn before queue/barge logic.
  if (isHardStopMessage(inboundContent)) {
    message.delete().catch(() => {})
    activeTurns.stop(channelId)
    return
  }

  // Ordinary in-flight messages steer the active Codex turn. If the transport
  // cannot accept them, they fall back to the channel queue without UI reactions.
  if (channelTurns.isRunning(channelId) && activeTurns.isActive(channelId)
      && isInFlightStatusPing(inboundContent)) {
    void replyOrSend(message, 'Still working — progress above', !relay)
      .catch(() => {})
    return
  }

  // Pending-edit consumer: if a prior bot message in this channel was marked
  // for edit (✏️), this user message edits it in place rather than spawning
  // a fresh reply. Resolves the marker either way.
  let target: Message | null = null
  const pendingEditId = pendingEdits.get(channelId)
  if (pendingEditId) {
    pendingEdits.clear(channelId)
    try {
      target = await message.channel.messages.fetch(pendingEditId)
    } catch (e) {
      console.error('pending-edit fetch failed:', e)
      target = null
    }
  }

  await runChannelTurn(message, target, relay?.payload, relay)
}

client.on('messageCreate', dispatchInboundMessage)

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.partial) {
    try { await reaction.fetch() } catch { return }
  }
  if (user.partial) {
    try { await user.fetch() } catch { return }
  }
  await handleReaction(reaction, user, {
    client,
    access,
    buildContext: (msg, reactor) => ({
      message: msg,
      reactor,
      client,
      access,
      persona,
      pendingEdits,
      pinnedFacts,
      rerunHandler: handleUserMessage
    })
  })
})

client.login(DISCORD_TOKEN)
