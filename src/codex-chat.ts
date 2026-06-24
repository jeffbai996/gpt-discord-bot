import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type OpenAI from 'openai'
import type { RespondResult, LifecycleEvent } from './openai.ts'

const execFileAsync = promisify(execFile)

// Same binary the codex *tool* uses — Codex (OpenAI gpt-5.5) under nvm v22.
const CODEX_BIN = process.env.GPT_CODEX_BIN || '/home/user/.nvm/versions/node/v22.22.2/bin/codex'
// Chat must feel snappy. medium ≈ 10s, low ≈ 5s (measured 2026-06-23); web
// search can add a few seconds. If a turn blows past this something is wrong —
// we throw and the caller falls back to the API so the bot never hangs.
const TIMEOUT_MS = Number(process.env.GPT_CODEX_CHAT_TIMEOUT_MS) || 75_000

// Squad-memory in the codex path: rather than an MCP server, we lean on codex's
// agentic shell — it can run the shared-memory CLI directly (verified: works under
// `-s read-only`, the CLI POSTs/GETs the local Flask store over loopback). The
// model decides when to recall, exactly like a tool call. This is how the codex
// path keeps squad-memory after the chat-engine swap (codex already has web).
const SQUAD_STORE_BIN = process.env.GPT_SQUAD_STORE_BIN || '/home/user/.local/bin/shared-memory'

export interface CodexChatInput {
  systemPrompt: string
  // Same shape gpt.ts already builds (history.ts/formatHistoryForOpenAI).
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  extraText?: string
  onEvent?: (event: LifecycleEvent) => void
}

// Discord's reasoning flag → Codex's config knob. Codex defaults to xhigh
// (~59s, too slow for chat); we never want that here. medium is the chat
// sweet spot; only an explicit 'high' flag opts into the slower deep mode.
function mapEffort(effort?: string): string {
  switch (effort) {
    case 'high': return 'high'
    case 'minimal':
    case 'low': return 'low'
    default: return 'medium'
  }
}

// Codex exec is single-shot (no conversation memory), so we bridge the whole
// turn — persona + recent history + the new message — into one prompt, the same
// way gpt.ts hands persona+history to the API. Codex web-searches on its own,
// so we don't lose web grounding by routing through it.
function buildPrompt(input: CodexChatInput): string {
  const transcript = input.history
    .map((h) => {
      const c = typeof h.content === 'string' ? h.content : JSON.stringify(h.content)
      // user content already carries a "Name: …" prefix from formatHistoryForOpenAI;
      // assistant content is the bot's stripped reply — label it so roles are clear.
      return h.role === 'assistant' ? `Assistant: ${c}` : c
    })
    .filter((l) => l.trim())
    .join('\n')

  return [
    input.systemPrompt.trim(),
    '',
    '--- You are chatting in a Discord conversation. Recent history (oldest first): ---',
    transcript || '(no prior messages)',
    input.extraText?.trim() ? `\n[Additional context]\n${input.extraText.trim()}` : '',
    '--- Squad memory (use when relevant) ---',
    `You can search the squad's shared long-term memory — durable facts about Jeff, his ` +
      `family, his portfolio/projects, preferences, and past decisions — by running this shell ` +
      `command:\n  ${SQUAD_STORE_BIN} recall "<search query>"\nRun it BEFORE replying whenever ` +
      `the message turns on squad-specific knowledge you don't already have (a person, a ` +
      `preference, a project, prior context). Skip it for general knowledge, code, or casual ` +
      `chat — don't slow those down.`,
    '--- New message ---',
    `${input.userName}: ${input.userMessage}`,
    '',
    'Reply as yourself (the persona described above) to that new message. Output ONLY ' +
      'your reply text — no "Assistant:" label, no preamble, no meta-commentary. Keep it ' +
      'natural for a Discord chat.',
  ]
    .filter(Boolean)
    .join('\n')
}

// Run a chat turn through the Codex CLI instead of the OpenAI API. Returns a
// RespondResult shaped exactly like openai.respond(), so gpt.ts can use it
// interchangeably. THROWS on any failure (timeout, empty answer, exec error)
// so the caller can fall back to the API — this never silently returns junk.
export async function respondViaCodex(input: CodexChatInput): Promise<RespondResult> {
  const t0 = Date.now()
  input.onEvent?.({ type: 'thinking_start' })

  const prompt = buildPrompt(input)
  const effort = mapEffort(input.reasoningEffort)
  const outfile = `/tmp/gpt_codexchat_${randomBytes(6).toString('hex')}.txt`
  const logfile = `/tmp/gpt_codexchat_log.txt`
  const secs = Math.floor(TIMEOUT_MS / 1000)

  // Prompt goes via env (CODEX_PROMPT) so arbitrary user text can't break out
  // of the shell command — same injection-safe pattern as the codex tool.
  // Neutral cwd (/tmp) + read-only: this is chat, not a repo operation.
  const script =
    `cd /tmp && timeout -k 5 ${secs} "${CODEX_BIN}" exec --skip-git-repo-check ` +
    `-s read-only -c model_reasoning_effort=${effort} -o "${outfile}" "$CODEX_PROMPT" ` +
    `</dev/null >"${logfile}" 2>&1; ` +
    `if [ -s "${outfile}" ]; then cat "${outfile}"; else echo "__CODEX_EMPTY__"; tail -5 "${logfile}"; fi`

  let stdout = ''
  try {
    const res = await execFileAsync('bash', ['-lc', script], {
      timeout: TIMEOUT_MS + 8_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEX_PROMPT: prompt },
    })
    stdout = res.stdout || ''
  } finally {
    await rm(outfile, { force: true }).catch(() => {})
  }

  const out = stdout.trim()
  if (!out || out.startsWith('__CODEX_EMPTY__')) {
    throw new Error(`codex chat produced no answer: ${out.slice(0, 200)}`)
  }

  input.onEvent?.({ type: 'done' })

  return {
    react: null,
    reply: out,
    usage: null,
    finishReason: 'stop',
    durationMs: Date.now() - t0,
    modelUsed: 'codex',
    reasoning: '',
    toolCalls: [],
  }
}
