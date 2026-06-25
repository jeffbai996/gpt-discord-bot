import type { TextChannel, DMChannel, ThreadChannel } from 'discord.js'
import type OpenAI from 'openai'
import { selectWithinBudget, defaultCountTokens, type CountTokens } from './token-budget.ts'

export interface HistoryAttachment {
  name: string
  url: string
  mimeType: string | null
}

export interface HistoryMessage {
  id: string
  authorId: string
  authorName: string
  content: string
  attachments: HistoryAttachment[]
}

// Upper bound for the raw Discord fetch. Discord caps fetch at 100 per call.
// We fetch this many, then trimToTokenBudget() drops the oldest until the
// remaining content fits within GPT_HISTORY_TOKEN_BUDGET.
const HISTORY_RAW_LIMIT = 30

// Approximate token-budget cap on conversation history sent per turn. The
// previous behavior was "fetch last 30, send them all" — a chatty channel
// with 30 multi-paragraph messages would silently send 10k+ tokens of
// history on every reply. With GPT-5.5 at $5/$30 per 1M tokens that's
// nontrivial cost per turn before the model has even started reasoning.
//
// 8k tokens covers ~12-20 typical Discord turns of context, which is plenty
// for chat. Override via GPT_HISTORY_TOKEN_BUDGET=<n>. Set to 0 to disable the
// token cap (keeps a recency window of the last 20 messages instead).
//
// The actual windowing now lives in token-budget.ts (gem-parity: dynamic
// token-aware windowing as a reusable, testable module). It approximates token
// count as chars/4 — accurate enough for budgeting without pulling in tiktoken
// — and the budget is intentionally generous (the trim is a fail-safe, not a
// tight squeeze).
const HISTORY_TOKEN_BUDGET = parseInt(
  process.env.GPT_HISTORY_TOKEN_BUDGET ?? '8000',
  10,
)

// Always retain at least this many recent messages even if they exceed
// the budget, so we never drop conversation completely.
const MIN_RETAIN = 3

export async function fetchHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string,
  limit: number = HISTORY_RAW_LIMIT
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({ limit, before: beforeMessageId })
  const arr: HistoryMessage[] = []
  for (const m of fetched.values()) {
    arr.push({
      id: m.id,
      authorId: m.author.id,
      authorName: m.author.username,
      content: m.content,
      attachments: [...m.attachments.values()].map(a => ({
        name: a.name,
        url: a.url,
        mimeType: a.contentType
      }))
    })
  }
  // Discord returns newest-first; reverse to chronological order.
  return arr.reverse()
}

function describeAttachment(att: HistoryAttachment): string {
  const mime = att.mimeType ?? ''
  const kind = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : 'file'
  return `[previous ${kind}: ${att.name}]`
}

// Strip metadata lines the bot adds to its own replies (verbose footer, etc.)
// before feeding past replies back into context. Without this, the model
// pattern-matches its own footer format and starts hallucinating
// `↑ X · ↓ Y · ◷ Zs` lines inside its reply text. Discord's `-# ` directive
// is reserved for metadata in this bot, so any line starting with `-# ` drops.
export function stripBotMetadata(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('-# ')) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

// Convert Discord history into OpenAI Chat Completions message format, then
// window it to fit the token budget. Bot's own messages become `assistant`;
// everyone else becomes `user`. Author name is prefixed inside `user` content
// because OpenAI's `name` field strips non-ASCII and is finicky with Discord
// usernames.
//
// Async because windowing is delegated to selectWithinBudget (token-budget.ts),
// whose counter signature is async to allow an exact-count backend later. With
// the default chars/4 counter the await resolves synchronously.
//
// `budget` defaults to HISTORY_TOKEN_BUDGET; pass an explicit value (e.g. in
// tests) to override. `countTokens` is pluggable for the same reason.
export async function formatHistoryForOpenAI(
  messages: HistoryMessage[],
  selfId: string,
  budget: number = HISTORY_TOKEN_BUDGET,
  countTokens: CountTokens = defaultCountTokens
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  for (const m of messages) {
    const isBot = m.authorId === selfId
    const attachmentNote = m.attachments.length
      ? '\n' + m.attachments.map(describeAttachment).join('\n')
      : ''
    const content = isBot
      ? stripBotMetadata(m.content) + attachmentNote
      : `${m.authorName}: ${m.content}${attachmentNote}`

    if (!content.trim()) continue

    out.push({
      role: isBot ? 'assistant' : 'user',
      content
    })
  }
  return selectWithinBudget(out, countTokens, { budget, minRetain: MIN_RETAIN })
}
