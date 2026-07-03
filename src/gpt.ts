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
import { CodexInterruptedError, CodexStoppedError } from './codex-chat.ts'
import { activeTurns } from './active-turns.ts'
import { isValidOutboundReactEmoji } from './reactions/vocabulary.ts'
import { recordTurn as recordCacheTurn, initGlobalStats } from './cache-stats.ts'
import { channelSessions } from './channel-sessions.ts'
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
import { INTERRUPTED_MARKER } from './interruption-label.ts'
import OpenAI from 'openai'

const STATE_DIR = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

// --- Tool-trace card helpers (ported from gem-bot/src/gemma.ts) -------------
// Tool calls render inside a ```diff``` fence as `+ ● ToolName(digest) [Nms]`
// — the `+` makes Discord's diff highlighter color the line GREEN; a failed
// call uses `- ● ... FAILED` (RED). The `●` dot marks "this is a tool call".
const ARG_DIGEST_PREFERENCE = [
  'file_path', 'notebook_path', 'pattern', 'command', 'url',
  'symbols', 'symbol', 'ticker', 'query', 'arguments',
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
// Match the Claude bots' tool_watcher.py caps byte-for-byte: tool-call header
// rows <= 83 (HEADER_LINE_MAX), stdout/output lines <= 88 (Jeff 2026-06-25).
const ROW_W = 83
const OUT_W = 88

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

function isTraceHeaderLine(ln: string): boolean {
  return /^[+-] ● /.test(ln)
}

function lineCost(lines: string[]): number {
  return lines.reduce((n, ln, i) => n + ln.length + (i ? 1 : 0), 0)
}

function blockCost(page: string[], block: string[]): number {
  return lineCost(block) + (page.length ? 1 : 0)
}

function appendTraceBlock(page: string[], block: string[]): void {
  page.push(...block)
}

function splitTraceBlocks(rawLines: string[]): string[][] {
  const blocks: string[][] = []
  let block: string[] = []
  for (const ln of rawLines) {
    if (isTraceHeaderLine(ln) && block.length) {
      blocks.push(block)
      block = []
    }
    block.push(ln)
  }
  if (block.length) blocks.push(block)
  return blocks.length ? blocks : [['']]
}

// Assemble fenced trace cards: pad + mega-cap each line, redact secrets, then
// split into continuation blocks instead of replacing overflow with
// "... (N more lines)". Tool rows are paged as logical blocks so `⎿ preview`
// cannot be separated from its `[N lines]` continuation. Keep each card under
// Discord's 2000-char limit with headroom for headers/fences and message edits.
function renderTraceCards(rawLines: string[]): string[] {
  const lines = rawLines.map(l => padTraceLine(capMegaLine(l)))
  const blocks = splitTraceBlocks(lines)
  const pages: string[][] = []
  let page: string[] = []
  let running = 0
  const pushPage = () => {
    if (!page.length) return
    pages.push(page)
    page = []
    running = 0
  }
  for (const block of blocks) {
    const cost = blockCost(page, block)
    if (page.length && running + cost > TRACE_BODY_CHAR_BUDGET) {
      pushPage()
    }
    if (lineCost(block) <= TRACE_BODY_CHAR_BUDGET) {
      appendTraceBlock(page, block)
      running = lineCost(page)
      continue
    }

    // Oversized diffs still have to fit in Discord messages. Split them only
    // after giving the trace header its own page context; compact output blocks
    // never hit this branch.
    for (const ln of block) {
      const cost = ln.length + (page.length ? 1 : 0)
      if (page.length && running + cost > TRACE_BODY_CHAR_BUDGET) {
        pushPage()
      }
      page.push(ln)
      running += ln.length + (page.length > 1 ? 1 : 0)
    }
    if (page.length && running >= TRACE_BODY_CHAR_BUDGET) {
      pages.push(page)
      page = []
      running = 0
    }
  }
  if (page.length) pages.push(page)
  if (!pages.length) pages.push([''])
  return pages.map((p, i) => {
    const label = pages.length > 1 ? ` ${i + 1}/${pages.length}` : ''
    const body = redactSecrets(p.join('\n'))
    return `🔧 **Tool trace${label}**\n\`\`\`diff\n${body}\n\`\`\``
  })
}

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

function formatThinkingText(text: string): string {
  const lines = text.trim().split('\n')
  const out: string[] = []
  let previousWasHeading = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/^>\s?/, '')
    const heading = raw.match(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/)
      ?? raw.match(/^[ \t]*\*\*(.+?)\*\*[ \t]*$/)
    if (heading) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      out.push(`> **${heading[1]}**`)
      previousWasHeading = true
      while (i + 1 < lines.length && lines[i + 1].trim() === '') i++
      continue
    }
    if (raw.trim() === '') {
      if (!previousWasHeading && out.length && out[out.length - 1] !== '') out.push('')
      previousWasHeading = false
      continue
    }
    out.push(`> ${raw}`)
    previousWasHeading = false
  }
  return out.join('\n')
}

function formatDiff(unified: string): { badge: string; body: string[] } {
  let adds = 0, dels = 0
  const rows: Array<{ marker: '+' | '-' | ' '; lineNo: number | null; text: string }> = []
  let oldLine = 0
  let newLine = 0
  for (const l of unified.replace(/\n+$/, '').split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldLine = Number(m[1])
        newLine = Number(m[2])
      }
      continue
    }
    if (l.startsWith('\\')) continue
    if (l.startsWith('+')) {
      adds++
      rows.push({ marker: '+', lineNo: newLine || null, text: l.slice(1) })
      if (newLine) newLine++
    } else if (l.startsWith('-')) {
      dels++
      rows.push({ marker: '-', lineNo: oldLine || null, text: l.slice(1) })
      if (oldLine) oldLine++
    } else {
      const text = l.startsWith(' ') ? l.slice(1) : l
      rows.push({ marker: ' ', lineNo: newLine || oldLine || null, text })
      if (oldLine) oldLine++
      if (newLine) newLine++
    }
  }
  const width = Math.max(2, ...rows.map(r => r.lineNo ? String(r.lineNo).length : 0))
  const body = rows.map((r) => {
    const gap = r.marker === ' ' ? ' ' : '  '
    if (!r.lineNo) return `${r.marker}${gap}${' '.repeat(width)} ${r.text}`
    return `${r.marker}${gap}${String(r.lineNo).padStart(width)} ${r.text}`
  })
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
      for (const b of body) lines.push(b)
    } else if (call.resultPreview) {
      // Match the output's truncation budget to the command's (71 shell / 115 other);
      // keep the [N lines] tag on its own continuation row so it does not make
      // the output preview wrap.
      const n = call.resultLines ?? 0
      let rp = call.resultPreview.replace(/\n/g, ' ')
      const cap = OUT_W
      if (rp.length > cap) rp = rp.slice(0, cap - 1) + '…'
      lines.push(`⎿ ${rp}`)
      if (n > 1) lines.push(`     [${n} lines]`)
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
  expansion: boolean,
  contentOverride?: string
): Promise<void> {
  const channelId = message.channel.id
  const userId = message.author.id
  // When a batched-queue turn folds several messages together, the combined
  // text comes in via contentOverride; otherwise use the message's own content.
  const userText = contentOverride ?? message.content
  const flags = access.channelFlags(channelId)
  // API-engine model is env-driven (DEFAULT_MODEL / GPT_MODEL), not per-channel —
  // matches gemma's API model. The per-channel `model` override was removed
  // 2026-06-29 (it had no slash setter — orphaned). /gpt model sets codexModel.
  const model = DEFAULT_MODEL
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
      // Respect /clear: drop anything at/before the channel's clear cutoff so a
      // cleared conversation truly starts fresh (Jeff 2026-06-27).
      const _cutoff = channelSessions.clearedSince(channelId)
      const rawFiltered = _cutoff ? raw.filter((m: any) => (m.createdTimestamp ?? 0) > _cutoff) : raw
      history = await formatHistoryForOpenAI(rawFiltered, selfId)
      // Observability (Jeff 2026-06-29): empty history = the bot loses context
      // for the turn. Log the counts so a fetch hiccup / over-aggressive cutoff
      // is visible instead of silently degrading (and burning tokens on a
      // context-less reply the user then has to re-ask).
      console.error(`[history] ch=${channelId} fetched=${raw.length} afterCutoff=${rawFiltered.length} sent=${history.length}${_cutoff ? ` cutoff=${_cutoff}` : ''}`)
    }
  } catch (e) {
    // A throw here = empty history = no context this turn. No longer silent.
    console.error(`[history] FETCH FAILED for ch=${channelId} — replying with NO context:`, e)
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
  let thinkingAnim: ReturnType<typeof setInterval> | null = null
  const stopThinkingAnim = () => { if (thinkingAnim) { clearInterval(thinkingAnim); thinkingAnim = null } }
  let currentStatus = `💭 ${effortLabel}`

  // Typing-dots-first (Jeff 2026-06-29, ported from gem-bot): show the native
  // "GPT is typing…" indicator immediately, and only post the 💭 placeholder
  // bubble + spinner if the turn is STILL working after PLACEHOLDER_DELAY_MS.
  // Fast turns then read clean — dots, then the answer, no transient bubble.
  // Slow turns (esp. codex, which doesn't stream partials) still get the
  // animated placeholder. The typing heartbeat re-fires every 9s because
  // Discord auto-expires the indicator after ~10s.
  const PLACEHOLDER_DELAY_MS = parseInt(process.env.GPT_PLACEHOLDER_DELAY_MS ?? '2500', 10)
  let placeholderTimer: ReturnType<typeof setTimeout> | null = null
  let typingInterval: ReturnType<typeof setInterval> | null = null
  if (!targetMessage && message.channel.isSendable()) {
    ;(message.channel as any).sendTyping?.().catch(() => {})
    typingInterval = setInterval(() => {
      ;(message.channel as any).sendTyping?.().catch(() => {})
    }, 9000)
  }

  // Start the placeholder spinner (idempotent). Animates the ellipsis (. .. …)
  // + glyph every 1.5s so a non-streaming (codex) turn doesn't sit frozen.
  const startSpinner = () => {
    if (thinkingAnim || !workMessage || targetMessage) return
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

  // Post the 💭 placeholder bubble + start its spinner, once. Called either by
  // the deferred timer (slow path) or eagerly the instant streamed content
  // needs a home before the timer fired. No-op if a workMessage already exists.
  const postPlaceholder = async () => {
    if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
    if (workMessage) { startSpinner(); return }
    try {
      workMessage = await message.reply(`💭 ✻ **${effortLabel}…**`)
      placeholderId = workMessage.id
      pendingPlaceholders.track(message.channel.id, workMessage.id, message.id)
    } catch (e) {
      console.error('placeholder reply failed:', e)
    }
    startSpinner()
  }

  if (targetMessage) {
    // Regenerate / edit: reuse the existing bot message immediately, spinner on.
    startSpinner()
  } else {
    // Normal turn: dots now, placeholder only if still working after the delay.
    placeholderTimer = setTimeout(() => { void postPlaceholder() }, PLACEHOLDER_DELAY_MS)
  }

  // Throttle Discord edits during streaming.
  let lastEditAt = 0
  let lastEditedText = ''
  const EDIT_INTERVAL_MS = 700

  const compactAndDropCodexSession = async (reason: string, inputTokens?: number) => {
    let compacted = false
    try {
      const summaryResult = await summarizer?.runForChannel(channelId)
      compacted = !!summaryResult
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

  // Live tool trace: start a row as soon as a tool fires, then enrich that same
  // row with output/failure/diff when the tool completes. The final render still
  // replaces this with canonical result.toolCalls after the turn.
  const liveToolRows: ToolCall[] = []
  let liveTraceMsgs: Message[] = []
  let liveTracePending = false
  let liveTraceDirty = false
  const flushLiveTrace = () => {
    if (liveTracePending || !liveToolRows.length || !message.channel.isSendable()) return
    const traceChannel = message.channel as TextChannel | DMChannel | ThreadChannel
    liveTracePending = true
    const cards = renderTraceCards(buildTraceLines(liveToolRows))
    ;(async () => {
      for (let i = 0; i < cards.length; i++) {
        if (liveTraceMsgs[i]) await liveTraceMsgs[i].edit(cards[i]).catch(() => {})
        else liveTraceMsgs[i] = await traceChannel.send(cards[i])
      }
      for (const stale of liveTraceMsgs.slice(cards.length)) {
        await stale.delete().catch(() => {})
      }
      liveTraceMsgs = liveTraceMsgs.slice(0, cards.length)
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
    if (event.type === 'thinking_start') { void applyLifecycle(message, 'thinking'); return }
    if (event.type === 'reasoning_start') { void applyLifecycle(message, 'reasoning'); return }
    if (event.type === 'searching') { void applyLifecycle(message, 'searching'); return }
    if (event.type === 'tool_start') {
      void applyLifecycle(message, 'tooling')
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
      // Generic animated label for the placeholder only. The live trace rows now
      // come from real tool_start events (codex emits the actual command/query/path
      // alongside this status), so we no longer push the coarse label as a row.
      currentStatus = event.label
      return
    }
    if (event.type === 'partial') {
      // Streamed content arrived before the placeholder timer fired (fast API
      // turn). Create the bubble now so there's somewhere to render — fire the
      // async post without blocking the event handler; the next partial
      // (~700ms later) lands once workMessage exists. Also cancels the timer.
      if (!workMessage) { void postPlaceholder(); return }
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
      userMessage: userText,
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
        let resumeSessionId = channelSessions.get(channelId)
        const lastInput = channelSessions.lastUsage(channelId)?.input ?? 0
        if (resumeSessionId && CODEX_SESSION_MAX_INPUT_TOKENS > 0 && lastInput >= CODEX_SESSION_MAX_INPUT_TOKENS) {
          currentStatus = '🧹 compacting'
          await compactAndDropCodexSession('preflight', lastInput)
          resumeSessionId = undefined
        }
        result = await respondViaCodex({
          systemPrompt,
          history,
          userMessage: userText,
          userName: message.author.username,
          reasoningEffort: flags.reasoning,
          codexModel: flags.codexModel,
          extraText,
          channelId,
          resumeSessionId,
          onEvent,
        })
        if (result.threadId) channelSessions.set(channelId, result.threadId)
        // Per-turn token delta for the ↑/↓ counter. codex's turn.completed.usage
        // on a RESUMED session is the running session CUMULATIVE, so showing it
        // raw makes the counter climb every turn (Jeff 2026-06-25). Derive the
        // marginal usage (this turn = cumulative − last turn's cumulative) and
        // hand it to the footer. result.usage stays the cumulative — the rollover
        // check below still keys on it. (Rollover's clear() also resets the usage
        // baseline so the next fresh turn's delta is computed correctly.)
        if (result.usage) {
          const d = channelSessions.usageDelta(channelId, {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
            cachedInput: result.usage.cachedInputTokens,
            reasoning: result.usage.reasoningTokens,
          })
          result.usageDelta = {
            inputTokens: d.input,
            outputTokens: d.output,
            cachedInputTokens: d.cachedInput,
            reasoningTokens: d.reasoning,
          }
        }
        // Post-turn rollover still matters for the first turn that crosses the
        // cap: we cannot know that until Codex reports usage, so compact/drop
        // immediately after the answer and the following turn starts fresh.
        if (CODEX_SESSION_MAX_INPUT_TOKENS > 0
            && (result.usage?.inputTokens ?? 0) >= CODEX_SESSION_MAX_INPUT_TOKENS) {
          await compactAndDropCodexSession('post-turn', result.usage?.inputTokens)
        }
        setEnginePresence(false)
      } catch (e) {
        if (e instanceof CodexStoppedError) {
          // /gpt stop — user aborted this turn. No API fallback; keep the session/context.
          stopThinkingAnim()
          if (workMessage) { await workMessage.edit(INTERRUPTED_MARKER).catch(() => {}) }
          try { await message.react('✗') } catch {}
          return
        }
        // A codex turn failed — drop this channel's session pointer so the NEXT turn
        // starts a clean fresh session (a wedged/expired session would otherwise fail
        // every turn; the fresh turn re-grounds from Discord history).
        channelSessions.dropSession(channelId)
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

    // Result is in hand — stop all "still working" indicators before rendering.
    // Cancel the deferred-placeholder timer (a fast turn beat the delay → no
    // transient bubble) and the typing heartbeat, alongside the spinner.
    if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
    stopThinkingAnim()
    // Stash usage in the rolling per-channel telemetry buffer for `/gpt cache info`.
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
    // literal '#### text'. Convert heading lines to bold and swallow the blank
    // line after them so `**Heading**` sits directly above its body.
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
      const formatted = formatThinkingText(result.reasoning!)
      for (const piece of chunk(`💭 **Thinking:**\n${formatted}`)) {
        try { const tm = await message.channel.send(piece); if (flags.thinking === 'collapse') collapseMsgs.push(tm) } catch {}
      }
    }

    // Tool-trace card — gem-bot diff format: `+ ● shortName(argDigest) [Nms]`
    // (green), `- ● ... FAILED [Nms]` (red) on failure, grey `  ⎿ resultPreview`.
    if (willTrace && !liveTraceMsgs.length) {
      const cards = renderTraceCards(buildTraceLines(result.toolCalls))
      for (const card of cards) {
        try { const sm = await message.channel.send(card); if (flags.trace === 'collapse') collapseMsgs.push(sm) } catch {}
      }
    }

    // If we streamed the trace live, replace it with the final canonical version
    // (full names + per-call timings from result.toolCalls).
    if (liveTraceMsgs.length && willTrace && result.toolCalls.length) {
      const lines = buildTraceLines(result.toolCalls)
      const cards = renderTraceCards(lines)
      for (let i = 0; i < cards.length; i++) {
        if (liveTraceMsgs[i]) {
          try { await liveTraceMsgs[i].edit(cards[i]) } catch {}
        } else {
          try { liveTraceMsgs[i] = await message.channel.send(cards[i]) } catch {}
        }
      }
      for (const stale of liveTraceMsgs.slice(cards.length)) {
        try { await stale.delete() } catch {}
      }
      liveTraceMsgs = liveTraceMsgs.slice(0, cards.length)
    }

    stopThinkingAnim()
    // "thought for Ns" sits ON TOP of the reply, in the SAME message block (Jeff
    // 2026-06-24) — small-text first line, then the answer. We reuse the placeholder
    // as the first message so the thought line replaces "thinking…" in place AND the
    // reply flows directly beneath it (one block). Persistence: keep the thought
    // line indefinitely ONLY when trace='on'; for trace 'collapse'/'off' it's a
    // transient duration tag, stripped after a 60s linger (Jeff 2026-06-24).
    // N = total turn time (codex has no per-item timing).
    const thoughtLine = `💭 ✓ **thought for ${fmtDur(result.durationMs)}**`
    const persist = flags.trace === 'on'
    const firstChunkLimit = Math.max(1000, 2000 - thoughtLine.length - 16)
    const parts = chunk(body, firstChunkLimit)
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
    // Attach any screenshots a tool produced this turn (Playwright browser_take_
    // screenshot → saved to disk → path collected on result.files). Sent as a
    // follow-up message so it works regardless of the edit-vs-reply branch above,
    // and so the visual lands right under the text. Discord caps 10 files/msg.
    if (result.files?.length && message.channel.isSendable()) {
      try {
        await message.channel.send({ files: result.files.slice(0, 10) })
      } catch (e) {
        console.error('screenshot attach failed:', e instanceof Error ? e.message : e)
      }
    }
    // Transient thought line: after the linger, strip just the thought prefix from
    // the merged message, leaving the reply body intact.
    if (!persist && mergedMsg) {
      const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 60_000
      deferredActions.schedule(client, { channelId: mergedMsg.channelId, messageId: mergedMsg.id, action: 'strip', content: parts[0] ?? '', dueAt: Date.now() + lingerMs })
    }

    // Collapse: keep the trace/thinking card(s) up for a readable 60s linger (same
    // window as the thought-for line), THEN delete for a clean channel (Jeff 2026-06-24).
    const toCollapse: Message[] = [...collapseMsgs]
    if (flags.trace === 'collapse' && liveTraceMsgs.length) toCollapse.push(...liveTraceMsgs)
    if (toCollapse.length) {
      const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 60_000
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
    if (placeholderTimer) { clearTimeout(placeholderTimer); placeholderTimer = null }
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
    stopThinkingAnim()
    if (placeholderId) pendingPlaceholders.untrack(placeholderId)
  }
}

// Per-channel turn queue: serialize turns within a channel so rapid-fire
// messages don't each spawn a parallel codex process. While a turn runs, new
// messages queue; when it finishes, ALL queued messages are batched into one
// follow-up turn (repeated until the queue drains). Cross-channel stays
// parallel — only same-channel pile-ups serialize. (Jeff 2026-06-25)
const channelTurns = new Map<string, { running: boolean; queue: Message[] }>()

async function runChannelTurn(message: Message, target: Message | null): Promise<void> {
  const cid = message.channel.id
  let st = channelTurns.get(cid)
  if (!st) { st = { running: false, queue: [] }; channelTurns.set(cid, st) }
  if (st.running) {
    // A turn is already in flight for this channel — queue + signal it was seen.
    st.queue.push(message)
    void message.react('\u{1F557}').catch(() => {})
    return
  }
  st.running = true
  try {
    await handleUserMessage(message, target, false)
    if (activeTurns.consumeStopped(cid)) st.queue.length = 0
    while (st.queue.length) {
      const batch = st.queue.splice(0, st.queue.length)
      const carrier = batch[batch.length - 1]
      const combined = batch.map(m => m.content).filter(Boolean).join('\n')
      const botId = client.user?.id
      if (botId) for (const m of batch) {
        void m.reactions.cache.get('\u{1F557}')?.users.remove(botId).catch(() => {})
      }
      await handleUserMessage(carrier, null, false, combined || undefined)
      if (activeTurns.consumeStopped(cid)) { st.queue.length = 0; break }
    }
  } finally {
    st.running = false
    if (!st.queue.length) channelTurns.delete(cid)
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

  // Lone ❌ message: kill the in-flight turn, post canonical interrupted marker + 🔁.
  if (message.content.trim().replace(/️/g, '') === '❌') {
    message.delete().catch(() => {})
    const killed = activeTurns.stop(channelId)
    if (killed) {
      const m = await (message.channel as any).send?.(`${INTERRUPTED_MARKER}\nReact 🔁 on my last message to retry.`)
        .catch(() => null)
      if (m) m.react?.('🔁').catch(() => {})
    }
    return
  }

  // Barge-in (Jeff 2026-07-01/03): a new message takes over, but normal messages
  // defer the stop until Codex reaches the next tool lifecycle boundary. That
  // prevents mid-output death while still letting the queued message cut in.
  {
    const st = channelTurns.get(channelId)
    if (st?.running && activeTurns.canRequestBarge(channelId)) {
      activeTurns.deferStopFor(channelId, { clearQueue: false })
      st.queue.unshift(message)
      void message.react('\u{23ED}\u{FE0F}').catch(() => {})  // ⏭️ "barging — cutting in"
      return
    }
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

  await runChannelTurn(message, target)
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
