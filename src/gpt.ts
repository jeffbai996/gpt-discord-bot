import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message, type TextChannel, type DMChannel, type ThreadChannel } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { chunk } from './chunk.ts'
import { gptCommand, executeGptCommand } from './commands.ts'
import { OpenAIProvider, OpenAIRequestRejected } from './openai.ts'
import type { LifecycleEvent } from './openai.ts'
import type { Provider } from './core/provider.ts'
import { fetchHistory, formatHistoryForOpenAI } from './history.ts'
import { processAttachments } from './attachments.ts'
import { applyLifecycle } from './reactions/lifecycle.ts'
import { isValidOutboundReactEmoji } from './reactions/vocabulary.ts'
import { recordTurn as recordCacheTurn } from './cache-stats.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { MemoryStore, embed } from './memory.ts'
import { shouldEmbed } from './embed-throttle.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { handleReaction } from './reactions/handler.ts'
import { SummaryStore } from './summarization/store.ts'
import { SummarizationScheduler } from './summarization/scheduler.ts'
import OpenAI from 'openai'

const STATE_DIR = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

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
const DEFAULT_MODEL: string = process.env.GPT_MODEL || 'gpt-5.4-mini'
const ADMIN_USER_ID: string | undefined = process.env.DISCORD_ADMIN_USER_ID

const access = new AccessManager()
const persona = new PersonaLoader()
const pendingEdits = new PendingEditsStore()
const pinnedFacts = new PinnedFactsStore(path.join(STATE_DIR, 'pinned-facts.md'))
persona.setPinnedFactsStore(pinnedFacts)
const openai: Provider = new OpenAIProvider(OPENAI_KEY, DEFAULT_MODEL)
// Raw SDK client for non-chat endpoints (audio.transcriptions, embeddings,
// web-search side-call). Sharing the same key/instance avoids spinning up two
// HTTP pools.
const openaiRaw = new OpenAI({ apiKey: OPENAI_KEY })

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
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction]
})

client.once('ready', async () => {
  console.error(`gpt online as ${client.user?.tag} (${client.user?.id})`)
  client.user?.setPresence({
    status: 'online',
    activities: [{ name: '📎 actually, on reflection—', type: ActivityType.Custom, state: '📎 actually, on reflection—' }]
  })

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    await rest.put(Routes.applicationCommands(APP_ID), { body: [gptCommand.toJSON()] })
    console.error('slash commands registered')
  } catch (e) {
    console.error('slash command registration failed:', e)
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.commandName !== 'gpt') return
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

  let workMessage: Message | null = targetMessage
  if (!workMessage) {
    try {
      workMessage = await message.reply('💭 thinking…')
    } catch (e) {
      console.error('placeholder reply failed:', e)
    }
  }

  // Tool-trace accumulator — diff-style lines, posted before the reply
  // when flags.trace is on (parity with the Claude bots' tool trace).
  const traceLines: string[] = []

  // Throttle Discord edits during streaming.
  let lastEditAt = 0
  let lastEditedText = ''
  const EDIT_INTERVAL_MS = 700

  const onEvent = (event: LifecycleEvent) => {
    if (event.type === 'thinking_start') { void applyLifecycle(message, 'thinking'); return }
    if (event.type === 'reasoning_start') { void applyLifecycle(message, 'reasoning'); traceLines.push('+ ● 🧠 reasoning'); return }
    if (event.type === 'searching') { void applyLifecycle(message, 'searching'); traceLines.push('+ ● web_search'); return }
    if (event.type === 'tool_start') {
      void applyLifecycle(message, 'tooling')
      const a = (event as { args?: string }).args
      traceLines.push(`+ ● ${event.name}(${a ?? ''})`)
      return
    }
    if (event.type === 'partial' && workMessage) {
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
    const result = await openai.respond({
      systemPrompt,
      history,
      userMessage: message.content,
      userName: message.author.username,
      model,
      reasoningEffort: flags.reasoning,
      imageParts,
      extraText,
      toolRegistry,
      channelId,
      userId,
      onEvent
    })

    // Stash usage in the rolling per-channel telemetry buffer for `/gpt cache info`.
    recordCacheTurn(channelId, result)

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
      if (!flags.verbose || !result.usage) return ''
      const u = result.usage
      // Main telemetry line: tokens in/out, reasoning shard, elapsed.
      const parts = [
        `↑ ${u.inputTokens.toLocaleString('en-US')}`,
        `↓ ${u.outputTokens.toLocaleString('en-US')}`,
        ...(u.reasoningTokens > 0
          ? [`(reasoning ${u.reasoningTokens.toLocaleString('en-US')})`]
          : []),
        `» ${(result.durationMs / 1000).toFixed(1)}s`,
      ]
      // Cache info gets its own subtle code block beneath the main line so the
      // prompt-cache hit is legible at a glance without cluttering the headline
      // token counts. Only rendered when there was a cache hit.
      const cacheLine =
        u.cachedInputTokens > 0
          ? `\n\n-# \`cached ↑ ${u.cachedInputTokens.toLocaleString('en-US')}\``
          : ''
      // Leading blank line so the footer sits a line below the reply body
      // (not crammed against the last line of text). The non-verbose path
      // returns '' so a quiet reply gets no trailing whitespace.
      return `\n\n-# \`${parts.join(' · ')}\`${cacheLine}`
    })()

    // Discord has no h1-h6 headings; markdown '#'..'######' render as a
    // literal '#### text'. Convert heading lines to bold before sending so
    // they read as headings. Inline '#' and '#tags' (no following space) are
    // left alone. Applied to the reply only, not the verbose footer.
    const headingsToBold = (t: string): string =>
      t.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '**$1**')
    const body = headingsToBold((result.reply ?? '').trim()) + verbose

    if (!body.trim()) {
      await applyLifecycle(message, 'silenced')
      if (workMessage && !targetMessage) {
        try { await workMessage.delete() } catch {}
      }
      return
    }

    // Tool-trace card — posted before the reply when enabled and any
    // tool/reasoning step ran this turn. Diff fences render red/green.
    if (flags.trace && traceLines.length > 0 && message.channel.isSendable()) {
      const card = '🔧 **Tool trace**\n```diff\n' + traceLines.join('\n') + '\n```'
      try { await message.channel.send(card.length > 1900 ? card.slice(0, 1900) + '\n```' : card) } catch {}
    }

    const parts = chunk(body)
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && workMessage) {
        await workMessage.edit(parts[i])
      } else if (i === 0) {
        await message.reply(parts[i])
      } else if (message.channel.isSendable()) {
        await message.channel.send(parts[i])
      }
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
    console.error('respond failed:', e)
    try {
      if (workMessage) await workMessage.edit(errMsg)
      else await message.reply(errMsg)
    } catch {}
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
