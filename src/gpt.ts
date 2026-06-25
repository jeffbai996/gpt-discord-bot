import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message, type TextChannel, type DMChannel, type ThreadChannel } from 'discord.js'
import path from 'path'
import os from 'os'
import fs from 'fs'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { chunk } from './chunk.ts'
import { gptCommand, executeGptCommand } from './commands.ts'
import { addVoiceGroup, executeVoiceCommand, VoiceManager } from './voice/command.ts'
import { OpenAIClient, OpenAIRequestRejected } from './openai.ts'
import type { LifecycleEvent, RespondResult, ToolCall } from './openai.ts'
import { respondViaCodex } from './codex-chat.ts'
import { fetchHistory, formatHistoryForOpenAI } from './history.ts'
import { processAttachments } from './attachments.ts'
import { applyLifecycle } from './reactions/lifecycle.ts'
import { CodexInterruptedError } from './codex-chat.ts'
import { isValidOutboundReactEmoji } from './reactions/vocabulary.ts'
import { recordTurn as recordCacheTurn, initGlobalStats } from './cache-stats.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { MemoryStore, embed } from './memory.ts'
import { shouldEmbed } from './embed-throttle.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { PendingPlaceholders } from './pending-placeholders.ts'
import { DeferredActions } from './deferred-actions.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { handleReaction } from './reactions/handler.ts'
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import OpenAI from 'openai'

const STATE_DIR = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

// --- Tool-trace card helpers (ported from gem-bot/src/gemma.ts) -------------
// Tool calls render inside a ```diff``` fence as `+ ● ToolName(digest) [Nms]`
// — the `+` makes Discord's diff highlighter color the line GREEN; a failed
// call uses `- ● ... FAILED` (RED). The `●` dot marks "this is a tool call".
const ARG_DIGEST_PREFERENCE = [
  'file_path', 'notebook_path', 'pattern', 'command', 'url',
  'symbols', 'symbol', 'ticker', 'query',
]

// Single-line, ID-shaped arg digest, <= maxLen chars.
// codex accepts none|low|medium|high|xhigh; the OpenAI API (fallback path) only
// takes minimal|low|medium|high. Map the codex extremes down for the API call.
// Duration like the Claude bots: "40s" under a minute, "1m 5s" over.
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function apiEffort(e: string): 'minimal' | 'low' | 'medium' | 'high' {
  if (e === 'none') return 'minimal'
  if (e === 'xhigh') return 'high'
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
const SECRET_RE = /[A-Za-z0-9_\-]{32,256}/g
// Redact credential-looking runs before a trace hits Discord — gpt can edit
// /home/user (incl. .env / auth.json), so an edit diff could otherwise leak a key.
function redactSecrets(text: string): string { return text.replace(SECRET_RE, '<REDACTED>') }

const MEGA_LINE_MAX = 300
const TRACE_BODY_CHAR_BUDGET = 1800
const TRACE_MAX_LINES = 50
// Max visible width of one trace row before Discord wraps it in the fenced diff
// block. Keeps shell commands + their output on a single line (Jeff 2026-06-25).
const ROW_W = 54

function capMegaLine(ln: string): string {
  return ln.length > MEGA_LINE_MAX ? ln.slice(0, MEGA_LINE_MAX - 1) + '…' : ln
}

// Claude's _tool_message_content padding: a colorizer line (+/-/!/@) keeps its
// marker at column 0 with ONE space after it; any other line gets a 1-cell left
// pad. Net: '+x' -> '+ x', ' ctx' -> '  ctx', '⎿ s' -> ' ⎿ s' — content aligns at col 2.
function padTraceLine(ln: string): string {
  if (!ln) return ln
  const f = ln[0]
  if (f === '+' || f === '-' || f === '!' || f === '@') {
    return (ln.length > 1 && ln[1] !== ' ') ? ln[0] + ' ' + ln.slice(1) : ln
  }
  return ' ' + ln
}

// Assemble the fenced trace card: pad + mega-cap each line, drop whole trailing
// lines past the line/char budget (with a marker), redact secrets, then wrap.
function renderTraceCard(rawLines: string[]): string {
  const lines = rawLines.map(l => padTraceLine(capMegaLine(l)))
  const fitted: string[] = []
  let running = 0
  for (const ln of lines.slice(0, TRACE_MAX_LINES)) {
    const cost = ln.length + (fitted.length ? 1 : 0)
    if (running + cost > TRACE_BODY_CHAR_BUDGET) break
    fitted.push(ln); running += cost
  }
  const dropped = rawLines.length - fitted.length
  if (dropped > 0) fitted.push(`... (${dropped} more lines)`)
  const body = redactSecrets(fitted.join('\n'))
  return '🔧 **Tool trace**\n```diff\n' + body + '\n```'
}

function formatDiff(unified: string): { badge: string; body: string[] } {
  let adds = 0, dels = 0
  const body: string[] = []
  for (const l of unified.replace(/\n+$/, '').split('\n')) {
    if (l.startsWith('@@') || l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) adds++
    else if (l.startsWith('-')) dels++
    body.push(l)
  }
  return { badge: `[+${adds}, -${dels}]`, body }
}

// Canonical tool-trace lines from toolCalls, shared by the live + final renders.
// File edits show the [+N, -M] badge and the diff body; other tools keep [Nms].
function buildTraceLines(toolCalls: ToolCall[]): string[] {
  const lines: string[] = []
  // Edits (with diffs) first: the diff is the payload and must not get starved by a
  // long list of shell rows below it, which the card's length cap then truncates to
  // a couple lines (Jeff 2026-06-24). Order within edits / within non-edits preserved.
  const ordered = [...toolCalls.filter(c => c.diff), ...toolCalls.filter(c => !c.diff)]
  for (const call of ordered) {
    const prefix = call.failed ? '- ● ' : '+ ● '
    const tail = call.failed ? ' FAILED' : ''
    const ms = call.durationMs > 0 ? ` [${call.durationMs}ms]` : ''
    const nm = shortToolName(call.name)
    // Keep the whole row within ROW_W so it never wraps in Discord's code block.
    const overhead = prefix.length + nm.length + 2 + tail.length + ms.length
    const dig = argDigest(call.args, Math.max(20, ROW_W - overhead))
    lines.push(`${prefix}${nm}(${dig})${tail}${ms}`)
    if (call.diff) {
      // Bare ⎿ summary + body; renderTraceCard's padTraceLine adds the 1-cell indent.
      const { badge, body } = formatDiff(call.diff)
      lines.push(`⎿ ${badge}`)
      for (const b of body.slice(0, 24)) lines.push(b)
      if (body.length > 24) lines.push(`... (${body.length - 24} more lines)`)
    } else if (call.resultPreview) {
      // Match the output's truncation budget to the command's (71 shell / 115 other);
      // append a same-line [N lines] tag when the raw output was multi-line (Jeff 2026-06-24).
      const n = call.resultLines ?? 0
      const suffix = n > 1 ? ` [${n} lines]` : ''
      let rp = call.resultPreview.replace(/\n/g, ' ')
      const cap = Math.max(20, ROW_W - 3 - suffix.length)
      if (rp.length > cap) rp = rp.slice(0, cap - 1) + '…'
      lines.push(`⎿ ${rp}${suffix}`)
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
// Default to the cheap model. gpt-5.5 is $5/$30 per 1M tokens — 6x the cost
// of gpt-5.4-mini ($0.75/$4.50). Channels can still override via
// /gpt set model gpt-5.5 (see commands.ts ALLOWED_MODELS).
const DEFAULT_MODEL: string = process.env.GPT_MODEL || 'gpt-5.5'
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
initGlobalStats(path.join(STATE_DIR, 'global-stats.json'))
const deferredActions = new DeferredActions(path.join(STATE_DIR, 'deferred-actions.json'))
persona.setPinnedFactsStore(pinnedFacts)
const openai = new OpenAIClient(OPENAI_KEY, DEFAULT_MODEL)
// Raw SDK client for non-chat endpoints (audio.transcriptions, embeddings,
// web-search side-call). Sharing the same key/instance avoids spinning up two
// HTTP pools.
const openaiRaw = new OpenAI({ apiKey: OPENAI_KEY })

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
// Attach `/gpt voice join|leave|speak` onto the existing /gpt command builder.
addVoiceGroup(gptCommand)

// Memory store may be null if the native sqlite-vss / better-sqlite3 modules
// fail to load on this Node version. The bot still runs; search_memory just
// isn't registered, and passive ingestion + summarization are skipped.
const memoryStore = await MemoryStore.open()
if (!memoryStore) {
  console.error('memory: RAG disabled (native module load failed); set up Node 22+ to enable')
}
const toolRegistry = await buildDefaultRegistry(openaiRaw, memoryStore)

// Summarization scheduler. Wires only when the SQLite-backed memory store is
// available — summaries persist into the same conversation_summaries table.
const SUMMARIZATION_THRESHOLD = parseInt(process.env.GPT_SUMMARIZATION_THRESHOLD ?? '50', 10)
const SUMMARIZATION_BATCH_LIMIT = parseInt(process.env.GPT_SUMMARIZATION_BATCH_LIMIT ?? '500', 10)
const SUMMARIZATION_MODEL = process.env.GPT_SUMMARIZATION_MODEL ?? 'gpt-5.4-mini'
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
      client: openaiRaw,
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
    const emb = await embed(openaiRaw, message.content)
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
    deferredActions.rearm(client)
  } catch (e) {
    console.error('placeholder sweep failed:', e)
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.commandName !== 'gpt') return
  // /gpt voice … is a subcommand group; route it to the voice handler.
  if (interaction.options.getSubcommandGroup(false) === 'voice') {
    await executeVoiceCommand(interaction, voiceManager, ADMIN_USER_ID ?? '', persona, toolRegistry)
    return
  }
  await executeGptCommand(interaction, access, persona, ADMIN_USER_ID, { summarizer })
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
// applyBasePresence(). The API-fallback indicator (setEnginePresence) temporarily
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
  const text = degraded ? '⚠️ on API (codex fell back)' : basePresenceText
  try { client.user?.setPresence({ activities: [presenceActivity(text)] }) } catch {}
}

async function handleUserMessage(
  message: Message,
  targetMessage: Message | null,
  expansion: boolean
): Promise<void> {
  const channelId = message.channel.id
  const userId = message.author.id
  const flags = access.channelFlags(channelId)
  const model = flags.model ?? DEFAULT_MODEL
  const systemPrompt = persona.buildSystemPrompt(channelId, message.guildId)
  const selfId = client.user?.id ?? ''

  let history: Awaited<ReturnType<typeof formatHistoryForOpenAI>> = []
  try {
    if (
      message.channel.type === 0 /* GuildText */ ||
      message.channel.type === 1 /* DM */ ||
      message.channel.type === 11 /* PublicThread */ ||
      message.channel.type === 12 /* PrivateThread */ ||
      message.channel.type === 5 /* GuildAnnouncement */
    ) {
      const raw = await fetchHistory(message.channel as TextChannel | DMChannel | ThreadChannel, message.id)
      history = await formatHistoryForOpenAI(raw, selfId)
    }
  } catch (e) {
    console.error('history fetch failed:', e)
  }

  await applyLifecycle(message, 'received')

  const attachments = [...message.attachments.values()]
  let imageParts: NonNullable<Parameters<typeof openai.respond>[0]['imageParts']> = []
  let extraText = ''
  if (attachments.length > 0) {
    await applyLifecycle(message, 'ingesting')
    try {
      const processed = await processAttachments(attachments, openaiRaw)
      imageParts = processed.imageParts
      extraText = processed.text
    } catch (e) {
      console.error('attachment processing failed:', e)
    }
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
  let workMessage: Message | null = targetMessage
  let placeholderId: string | null = null
  if (!workMessage) {
    try {
      workMessage = await message.reply(`💭 ✻ **${effortLabel}…**`)
      placeholderId = workMessage.id
      pendingPlaceholders.track(message.channel.id, workMessage.id, message.id)
    } catch (e) {
      console.error('placeholder reply failed:', e)
    }
  }

  // Animate the placeholder ellipsis (. .. …) every 1.5s while we wait. Matters
  // most for codex turns, which don't stream partials, so the placeholder would
  // otherwise sit frozen. Cleared on the first streamed partial and before the
  // final render (stopThinkingAnim).
  let thinkingAnim: ReturnType<typeof setInterval> | null = null
  const stopThinkingAnim = () => { if (thinkingAnim) { clearInterval(thinkingAnim); thinkingAnim = null } }
  let currentStatus = `💭 ${effortLabel}`
  if (workMessage && !targetMessage) {
    // Claude-bot spinner in the ✓/✗ position (between the emoji and the word):
    // glyph set + trailing dots both pulse each 1.5s tick, then settle to ✓.
    const GLYPHS = ['✻', '✢', '✱', '✶', '✷', '✸']
    const dots = ['.', '..', '…']
    let fi = 1
    thinkingAnim = setInterval(() => {
      if (!workMessage) return
      const sp = GLYPHS[fi % GLYPHS.length]
      const d = dots[fi % dots.length]
      fi++
      const i = currentStatus.indexOf(' ')
      const emoji = i > 0 ? currentStatus.slice(0, i) : currentStatus
      const text = i > 0 ? currentStatus.slice(i + 1) : ''
      workMessage.edit(`${emoji} ${sp} **${text}${d}**`).catch(() => {})
    }, 1500)
  }

  // Throttle Discord edits during streaming.
  let lastEditAt = 0
  let lastEditedText = ''
  const EDIT_INTERVAL_MS = 700

  // Lifecycle reactions still fire live via onEvent; the tool trace itself is
  // now built post-hoc from result.toolCalls (see the trace card below), so we
  // no longer accumulate raw trace lines here.
  // Live tool trace (Jeff 2026-06-24): when `trace` is on, stream each tool into a
  // growing message AS it runs, instead of one blob at the end. API path gives rich
  // tool_start{name,args}; codex gives coarser status labels — both append a row.
  const liveToolRows: string[] = []
  let liveTraceMsg: Message | null = null
  let liveTracePending = false
  const flushLiveTrace = () => {
    if (liveTracePending || !liveToolRows.length || !message.channel.isSendable()) return
    liveTracePending = true
    const card = renderTraceCard(liveToolRows)
    const done = () => { liveTracePending = false }
    if (liveTraceMsg) liveTraceMsg.edit(card).then(done, done)
    else message.channel.send(card).then(m => { liveTraceMsg = m; done() }, done)
  }

  const onEvent = (event: LifecycleEvent) => {
    if (event.type === 'thinking_start') { void applyLifecycle(message, 'thinking'); return }
    if (event.type === 'reasoning_start') { void applyLifecycle(message, 'reasoning'); return }
    if (event.type === 'searching') { void applyLifecycle(message, 'searching'); return }
    if (event.type === 'tool_start') {
      void applyLifecycle(message, 'tooling')
      if (flags.trace !== 'off') {
        const nm = shortToolName(event.name)
        const cap = Math.max(20, ROW_W - (4 + nm.length + 2))
        const dig = String(event.args ?? '').replace(/\s+/g, ' ').slice(0, cap)
        liveToolRows.push(`+ ● ${nm}(${dig})`)
        flushLiveTrace()
      }
      return
    }
    if (event.type === 'status') {
      // Generic animated label for the placeholder only. The live trace rows now
      // come from real tool_start events (codex emits the actual command/query/path
      // alongside this status), so we no longer push the coarse label as a row.
      currentStatus = event.label
      return
    }
    if (event.type === 'partial' && workMessage) {
      stopThinkingAnim()
      const now = Date.now()
      if (now - lastEditAt < EDIT_INTERVAL_MS) return
      const display = event.reply.trim()
      if (!display || display === lastEditedText) return
      const max = 1900
      const truncated = display.length > max ? display.slice(0, max) + '…' : display
      lastEditAt = now
      lastEditedText = display
      workMessage.edit(truncated).catch(() => { /* fire-and-forget */ })
    }
  }

  try {
    // Codex-as-default-chat: route text turns through the Codex CLI (flat-sub,
    // self-web-searching) instead of the metered API. Falls back to the API on
    // any codex error, and skips codex when there are images (the CLI can't take
    // them). Kill switch: GPT_CODEX_CHAT=0.
    const apiRespond = () => openai.respond({
      systemPrompt,
      history,
      userMessage: message.content,
      userName: message.author.username,
      model,
      reasoningEffort: apiEffort(flags.reasoning),
      imageParts,
      extraText,
      toolRegistry,
      channelId,
      userId,
      onEvent
    })

    let result: RespondResult
    if (flags.engine !== 'api' && process.env.GPT_CODEX_CHAT !== '0' && imageParts.length === 0) {
      try {
        result = await respondViaCodex({
          systemPrompt,
          history,
          userMessage: message.content,
          userName: message.author.username,
          reasoningEffort: flags.reasoning,
          codexModel: flags.codexModel,
          extraText,
          channelId,
          onEvent,
        })
        setEnginePresence(false)
      } catch (e) {
        // Don't fail silently. If codex was interrupted by the backstop (or errored),
        // SHOW it — an ⏳ reaction + a short note on the placeholder — THEN fall back
        // to the API so the user still gets an answer, but knows what happened.
        if (e instanceof CodexInterruptedError) {
          console.error('codex interrupted by backstop, surfacing + falling back to API:', e.message)
          void applyLifecycle(message, 'interrupted')
          if (workMessage) { await workMessage.edit('⏳ **codex turn interrupted — retrying on the API…**').catch(() => {}) }
        } else {
          console.error('codex chat failed, falling back to API:', e)
          void applyLifecycle(message, 'errored')
          if (workMessage) { await workMessage.edit('⚠️ **codex hit an error — retrying on the API…**').catch(() => {}) }
        }
        result = await apiRespond()
        setEnginePresence(true)
      }
    } else {
      result = await apiRespond()
    }

    // Stash usage in the rolling per-channel telemetry buffer for `/gpt cache info`.
    stopThinkingAnim()
    recordCacheTurn(channelId, result)

    // @gpt can set its own Discord status: a [[presence: …]] directive in the reply
    // is applied to the bot presence + stripped from the message.
    {
      const pm = result.reply?.match(/\[\[presence:\s*([^\]]+)\]\]/i)
      if (pm) {
        applyBasePresence(pm[1].trim())
        result.reply = (result.reply ?? '').replace(/\[\[presence:\s*[^\]]+\]\]/ig, '').trim()
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
      const u = result.usage
      const n = (x: number) => x.toLocaleString('en-US')
      // Headline line: the TOTALS — input ↑, output ↓, elapsed ◷.
      const parts = [`↑ ${n(u.inputTokens)}`, `↓ ${n(u.outputTokens)}`,
                     `◷ ${(result.durationMs / 1000).toFixed(1)}s`]
      // Breakdown line beneath: the sub-counts of the headline totals, grouped
      // because they're the same shape — cached is a slice of input (↑),
      // reasoning is a slice of output (↓). Each renders only when nonzero; the
      // whole line is omitted when both are zero (cheap non-reasoning turns).
      const sub = [
        ...(u.cachedInputTokens > 0 ? [`cached ↑ ${n(u.cachedInputTokens)}`] : []),
        ...(u.reasoningTokens > 0 ? [`reasoning ↓ ${n(u.reasoningTokens)}`] : []),
      ]
      const subLine = (flags.counter === 'both' && sub.length) ? `\n\n-# \` ${sub.join(' · ')} \`` : ''
      // Leading blank line so the footer sits a line below the reply body
      // (not crammed against the last line of text). The non-verbose path
      // returns '' so a quiet reply gets no trailing whitespace.
      return `\n\n-# \` ${parts.join(' · ')} \`${subLine}`
    })()

    // Discord has no h1-h6 headings; markdown '#'..'######' render as a
    // literal '#### text'. Convert heading lines to bold before sending so
    // they read as headings. Inline '#' and '#tags' (no following space) are
    // left alone. Applied to the reply only, not the verbose footer.
    const headingsToBold = (t: string): string =>
      t.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '**$1**')
    const body = headingsToBold((result.reply ?? '').trim()) + verbose + (verbose ? '\n\u200b' : '')

    if (!body.trim()) {
      await applyLifecycle(message, 'silenced')
      if (workMessage && !targetMessage) {
        try { await workMessage.delete() } catch {}
      }
      return
    }

    // Thinking + trace cards belong ABOVE the reply (the intended "here's my
    // reasoning / what I ran, then the answer" order). The reply normally reuses
    // the streaming placeholder, which was posted at TURN START and so sits at
    // the top — editing it there would push these cards below the reply (the o3
    // "reasoning under the output" report; it's not o3-specific, it's every
    // model that emits a reasoning summary or runs a tool). Fix: when a card
    // will post and the placeholder is ours, drop it and let the reply repost as
    // a fresh message BELOW the cards. (Expansion flow edits an existing message
    // we can't reorder, so it keeps cards-after — an accepted edge case.)
    const willThinking = flags.thinking !== 'off' && !!result.reasoning?.trim() && message.channel.isSendable()
    const willTrace = flags.trace !== 'off' && result.toolCalls.length > 0 && message.channel.isSendable()
    // NOTE: workMessage (the "thinking…" placeholder) is NOT reused for the reply
    // anymore — it gets edited into the "thought for Ns" line in place (replacing
    // "thinking…" where it sat). The reply always posts as a fresh message below.

    // Cards posted in 'collapse' mode are shown live then deleted once the reply lands.
    const collapseMsgs: Message[] = []
    if (willThinking) {
      const quoted = result.reasoning!.trim().split('\n').map(l => `> ${l}`).join('\n')
      for (const piece of chunk(`💭 **Thinking:**\n${quoted}`)) {
        try { const tm = await message.channel.send(piece); if (flags.thinking === 'collapse') collapseMsgs.push(tm) } catch {}
      }
    }

    // Tool-trace card — gem-bot diff format: `+ ● shortName(argDigest) [Nms]`
    // (green), `- ● ... FAILED [Nms]` (red) on failure, grey `  ⎿ resultPreview`.
    if (willTrace && !liveTraceMsg) {
      const card = renderTraceCard(buildTraceLines(result.toolCalls))
      try { const sm = await message.channel.send(card); if (flags.trace === 'collapse') collapseMsgs.push(sm) } catch {}
    }

    // If we streamed the trace live, replace it with the final canonical version
    // (full names + per-call timings from result.toolCalls).
    const ltm = liveTraceMsg as unknown as (Message | null)
    if (ltm && willTrace && result.toolCalls.length) {
      const lines = buildTraceLines(result.toolCalls)
      const card = renderTraceCard(lines)
      try { await ltm.edit(card) } catch {}
    }

    stopThinkingAnim()
    // "thought for Ns" sits ON TOP of the reply, in the SAME message block (Jeff
    // 2026-06-24) — small-text first line, then the answer. We reuse the placeholder
    // as the first message so the thought line replaces "thinking…" in place AND the
    // reply flows directly beneath it (one block). Persistence: keep the thought
    // line indefinitely ONLY when trace='on'; for trace 'collapse'/'off' it's a
    // transient duration tag, stripped after a 120s linger (Jeff 2026-06-24).
    // N = total turn time (codex has no per-item timing).
    const thoughtLine = `💭 ✓ **thought for ${fmtDur(result.durationMs)}**`
    const persist = flags.trace === 'on'
    const parts = chunk(body)
    const firstWithThought = `${thoughtLine}\n${parts[0] ?? ''}`
    let mergedMsg: Message | null = null
    // Cards (trace / thinking) post ABOVE the reply. The placeholder sat at the top
    // since turn start, so reusing it for the reply would force the reply above those
    // cards. When a card posted, drop the placeholder and let the reply repost as a
    // fresh message BELOW the cards (Jeff 2026-06-24).
    if ((willTrace || willThinking) && workMessage && !targetMessage) {
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
          mergedMsg = await message.reply(firstWithThought)
        }
      } else if (message.channel.isSendable()) {
        await message.channel.send(parts[i])
      }
    }
    // Transient thought line: after the linger, strip just the thought prefix from
    // the merged message, leaving the reply body intact.
    if (!persist && mergedMsg) {
      const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 120_000
      deferredActions.schedule(client, { channelId: mergedMsg.channelId, messageId: mergedMsg.id, action: 'strip', content: parts[0] ?? '', dueAt: Date.now() + lingerMs })
    }

    // Collapse: keep the trace/thinking card(s) up for a readable 120s linger (same
    // window as the thought-for line), THEN delete for a clean channel (Jeff 2026-06-24).
    const toCollapse: Message[] = [...collapseMsgs]
    if (flags.trace === 'collapse' && liveTraceMsg) toCollapse.push(liveTraceMsg as unknown as Message)
    if (toCollapse.length) {
      const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 120_000
      for (const m of toCollapse) deferredActions.schedule(client, { channelId: m.channelId, messageId: m.id, action: 'delete', dueAt: Date.now() + lingerMs })
    }

    if (result.finishReason === 'length') {
      await applyLifecycle(message, 'truncated')
    } else {
      await applyLifecycle(message, 'replied')
    }
  } catch (e: any) {
    const isRejected = e instanceof OpenAIRequestRejected
    if (isRejected && e.reason === 'content_policy') {
      await applyLifecycle(message, 'blocked')
    } else if (isRejected) {
      await applyLifecycle(message, 'denied')
    } else {
      await applyLifecycle(message, 'errored')
    }
    const errMsg = isRejected ? `⚠️ ${e.reason}` : `❌ error: ${e?.message ?? String(e)}`
    stopThinkingAnim()
    console.error('respond failed:', e)
    try {
      if (workMessage) await workMessage.edit(errMsg)
      else await message.reply(errMsg)
    } catch {}
  } finally {
    if (placeholderId) pendingPlaceholders.untrack(placeholderId)
  }
}

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return

  const channelId = message.channel.id
  const userId = message.author.id
  const isMention = client.user ? message.mentions.users.has(client.user.id) : false

  if (memoryStore && message.content.trim() && access.isAllowedAndEnabled(userId, channelId)) {
    void ingestMessage(message)
    // Schedule summarization after ingestion so the message we just stored is
    // counted toward the threshold. Single-flight per channel; no-op if a
    // run is already in progress.
    summarizer?.scheduleIfNeeded(channelId)
  }

  if (!access.canHandle({ channelId, userId, isMention })) return

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

  await handleUserMessage(message, target, false)
})

client.on('messageReactionAdd', async (reaction, user) => {
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
