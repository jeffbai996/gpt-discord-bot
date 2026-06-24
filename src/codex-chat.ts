import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { rm, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type OpenAI from 'openai'
import type { RespondResult, ToolCall, LifecycleEvent } from './openai.ts'

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
const VECGREP_BIN = process.env.GPT_VECGREP_BIN || '/home/user/.local/bin/vecgrep'

export interface CodexChatInput {
  systemPrompt: string
  // Same shape gpt.ts already builds (history.ts/formatHistoryForOpenAI).
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  extraText?: string
  channelId?: string
  onEvent?: (event: LifecycleEvent) => void
}

// Discord's reasoning flag → Codex's config knob. Codex defaults to xhigh
// (~59s, too slow for chat); we never want that here. medium is the chat
// sweet spot; only an explicit 'high' flag opts into the slower deep mode.
function mapEffort(effort?: string): string {
  switch (effort) {
    case 'none':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh': return effort
    case 'minimal': return 'low' // legacy alias
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
    `For deeper semantic search across the whole squad corpus (past Discord conversations, indexed files, all memories/journals), run: ${VECGREP_BIN} search "<query>" — use it when recall isn't enough or you need older chat context; only when the question genuinely needs it.`,
    `You are a FULL squad member — you can RECORD to the shared brain, not just read it. When `
      + `something durable is worth saving (a decision, a preference, a person/project fact, a `
      + `to-do), run ONE of these (always pass the --discord-chat-id shown so an undo card posts):\n`
      + `  ${SQUAD_STORE_BIN} memory add --type project|user|feedback|reference --name "<short name>" --tags "a,b" --discord-chat-id "${input.channelId ?? ''}" "<body>"\n`
      + `  ${SQUAD_STORE_BIN} journal add --discord-chat-id "${input.channelId ?? ''}" "<moment>"\n`
      + `  ${SQUAD_STORE_BIN} todo add --discord-chat-id "${input.channelId ?? ''}" "<task>"\n`
      + `Save ONLY genuinely durable, reusable facts — never chit-chat, recaps, or progress notes.`,
    `You can set your own Discord status: include [[presence: <short status>]] anywhere in your reply and it'll be applied to your presence + stripped from the message. Use it sparingly — only for a genuine status change.`,
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

interface ParsedEvents {
  toolCalls: ToolCall[]
  reasoning: string
  usage: RespondResult['usage']
  lastAgentMessage: string
}

// Parse codex's `--json` JSONL event stream so the codex path can populate the
// SAME RespondResult fields the API path does — keeping the per-channel `trace`,
// `thinking`, and `verbose` flags working on codex turns. Event shapes (codex
// 0.x): item.completed{item:{type:'command_execution'|'reasoning'|'agent_message'
// |'web_search'|'mcp_tool_call', …}} and turn.completed{usage:{input_tokens,
// cached_input_tokens, output_tokens, reasoning_output_tokens}}.
function parseCodexEvents(jsonl: string): ParsedEvents {
  const toolCalls: ToolCall[] = []
  const reasoningParts: string[] = []
  let usage: RespondResult['usage'] = null
  let lastAgentMessage = ''

  const clip = (s: unknown, n: number) =>
    String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

  for (const line of jsonl.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let ev: any
    try { ev = JSON.parse(s) } catch { continue }

    if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage
      const input = u.input_tokens ?? 0
      const output = u.output_tokens ?? 0
      usage = {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        cachedInputTokens: u.cached_input_tokens ?? 0,
        reasoningTokens: u.reasoning_output_tokens ?? 0,
      }
      continue
    }

    if (ev.type !== 'item.completed' || !ev.item) continue
    const it = ev.item
    switch (it.type) {
      case 'agent_message':
        if (it.text) lastAgentMessage = String(it.text)
        break
      case 'reasoning':
        if (it.text) reasoningParts.push(String(it.text))
        break
      case 'command_execution': {
        // codex wraps shell cmds as `/bin/bash -lc '<inner>'`. Unwrap + basename the
        // leading path so the trace header reads `shared-memory recall "x"` (short, like
        // Claude's) instead of the full /home/... path that wraps in Discord.
        const rawCmd = String(it.command ?? '')
        const inner = rawCmd.match(/-l?c\s+'([\s\S]*)'\s*$/)
        let cmd = (inner ? inner[1] : rawCmd).trim()
        cmd = cmd.replace(/^\/\S*\/([^/\s]+)/, '$1')
        toolCalls.push({
          name: 'shell',
          args: { command: clip(cmd, 80) },
          durationMs: 0, // codex JSONL carries no per-item timing
          resultPreview: clip(it.aggregated_output, 200),
          failed: typeof it.exit_code === 'number' ? it.exit_code !== 0 : false,
        })
        break
      }
      case 'file_change':
        // codex now writes/edits files (workspace-write). The --json file_change item
        // carries the changed paths + kind (add/update/delete) but NOT the hunk text,
        // so we surface the edited files (these can wrap — they're the "diffs").
        for (const ch of (Array.isArray(it.changes) ? it.changes : [])) {
          toolCalls.push({
            name: 'edit',
            args: { file_path: String(ch.path ?? '') },
            durationMs: 0,
            resultPreview: String(ch.kind ?? 'update'),
            failed: false,
          })
        }
        break
      case 'web_search':
        toolCalls.push({
          name: 'web_search',
          args: { query: clip(it.query, 140) },
          durationMs: 0,
          resultPreview: clip(it.result ?? it.aggregated_output, 200),
          failed: false,
        })
        break
      case 'mcp_tool_call':
        toolCalls.push({
          name: clip(it.tool ?? it.name ?? 'mcp', 40) || 'mcp',
          args: typeof it.arguments === 'object' && it.arguments ? it.arguments : {},
          durationMs: 0,
          resultPreview: clip(it.result, 200),
          failed: it.status ? it.status !== 'completed' : false,
        })
        break
      default:
        break
    }
  }

  return { toolCalls, reasoning: reasoningParts.join('\n\n'), usage, lastAgentMessage }
}

// Run a chat turn through the Codex CLI instead of the OpenAI API. Returns a
// RespondResult shaped exactly like openai.respond(), so gpt.ts can use it
// interchangeably. THROWS on any failure (timeout, empty answer, exec error)
// so the caller can fall back to the API — this never silently returns junk.
const clip2 = (x: unknown, n: number) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// Strip codex's `/bin/bash -lc '<inner>'` wrapper + basename the leading path.
function cleanCmd(raw: string): string {
  const m = raw.match(/-l?c\s+'([\s\S]*)'\s*$/)
  const cmd = (m ? m[1] : raw).trim()
  return cmd.replace(/^\/\S*\/([^/\s]+)/, '$1')
}

// One-line live label for the placeholder as codex works (from item.started events).
function liveLabel(ev: any): string | null {
  if (ev?.type !== 'item.started' || !ev.item) return null
  const it = ev.item
  switch (it.type) {
    case 'command_execution': return `🔧 ${clip2(cleanCmd(String(it.command ?? '')), 70)}`
    case 'web_search':        return `🌐 searching: ${clip2(it.query, 60)}`
    case 'file_change': {
      const paths = Array.isArray(it.changes) ? it.changes.map((c: any) => c.path).join(', ') : ''
      return `✎ editing ${clip2(paths, 70)}`
    }
    case 'reasoning':         return '🧠 thinking…'
    default:                  return null
  }
}

export async function respondViaCodex(input: CodexChatInput): Promise<RespondResult> {
  const t0 = Date.now()
  input.onEvent?.({ type: 'thinking_start' })

  const prompt = buildPrompt(input)
  const effort = mapEffort(input.reasoningEffort)
  const outfile = `/tmp/gpt_codexchat_${randomBytes(6).toString('hex')}.txt`
  const secs = Math.floor(TIMEOUT_MS / 1000)

  // --json → JSONL events on stdout (parsed for tool calls / reasoning / token
  // usage so trace+thinking+verbose work on codex turns). -o → the clean final
  // reply text to a file (kept separate from the event stream). Prompt goes via
  // env (CODEX_PROMPT) so user text can't break out of the shell command.
  // Neutral cwd (/tmp) + workspace-write: codex auto-runs within the sandbox
  // (writes confined to the /tmp workspace; reads allowed). Jeff opted into write 2026-06-24.
  const script =
    `cd /tmp && timeout -k 5 ${secs} "${CODEX_BIN}" exec --skip-git-repo-check --add-dir /home/user ` +
    `-s workspace-write -c sandbox_workspace_write.network_access=true -c model_reasoning_effort=${effort} --json -o "${outfile}" "$CODEX_PROMPT" ` +
    `</dev/null 2>/dev/null`

  // Stream codex's JSONL events line-by-line so we can surface what it's doing
  // LIVE (running cmd / searching / editing) to the placeholder via onEvent, while
  // still collecting every line for the post-turn trace/usage parse.
  const child = spawn('bash', ['-lc', script], {
    env: { ...process.env, CODEX_PROMPT: prompt, SQUAD_STORE_URL: process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005' },
  })
  const lines: string[] = []
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    if (!line.trim()) return
    lines.push(line)
    try {
      const label = liveLabel(JSON.parse(line))
      if (label) input.onEvent?.({ type: 'partial', reply: label })
    } catch { /* non-JSON line */ }
  })
  let replyFromFile = ''
  let timedOut = false
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); resolve() }, TIMEOUT_MS + 8_000)
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('close', () => { clearTimeout(timer); resolve() })
    })
    replyFromFile = await readFile(outfile, 'utf8').catch(() => '')
  } finally {
    rl.close()
    await rm(outfile, { force: true }).catch(() => {})
  }

  const parsed = parseCodexEvents(lines.join('\n'))
  // Prefer the -o file (the clean final message); fall back to the last
  // agent_message in the event stream if the file came back empty.
  const reply = (replyFromFile.trim() || parsed.lastAgentMessage).trim()
  if (!reply) {
    throw new Error(`codex chat produced no answer (timedOut=${timedOut}, lines=${lines.length})`)
  }

  input.onEvent?.({ type: 'done' })

  return {
    react: null,
    reply,
    usage: parsed.usage,
    finishReason: 'stop',
    durationMs: Date.now() - t0,
    modelUsed: 'codex',
    reasoning: parsed.reasoning,
    toolCalls: parsed.toolCalls,
  }
}
