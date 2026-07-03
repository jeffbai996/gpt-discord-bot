import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { rm, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { activeTurns } from './active-turns.ts'
import type OpenAI from 'openai'
import type { RespondResult, ToolCall, LifecycleEvent } from './openai.ts'

// Thrown when the runaway-process backstop SIGKILLs codex, so the caller can
// surface an explicit 'interrupted' indicator instead of failing silently.
export class CodexInterruptedError extends Error {
  constructor(public readonly afterMs: number) {
    super(`codex turn interrupted by runaway-process backstop after ${Math.round(afterMs/1000)}s`)
    this.name = 'CodexInterruptedError'
  }
}

export class CodexStoppedError extends Error {
  constructor(public readonly afterMs: number) {
    super(`codex turn stopped by user (/gpt stop) after ${Math.round(afterMs/1000)}s`)
    this.name = 'CodexStoppedError'
  }
}

const execFileAsync = promisify(execFile)

// Same binary the codex *tool* uses — Codex (OpenAI gpt-5.5) under nvm v22.
const CODEX_BIN = process.env.GPT_CODEX_BIN || '/home/user/.nvm/versions/node/v22.22.2/bin/codex'
// Runaway-process BACKSTOP, not a turn timer. Legitimate reasoning turns can run
// for minutes, so we do NOT cap on a guessed duration (the old 75s killed real
// long turns). This only exists so a genuinely hung codex process can't live
// forever. When it DOES fire, we surface an explicit "interrupted" signal rather
// than silently swapping to the API (Jeff 2026-06-24).
const DEFAULT_TASK_TIMEOUT_MS = Number(process.env.GPT_CODEX_CHAT_TIMEOUT_MS) || 600_000
const DEFAULT_QUICK_TIMEOUT_MS = Number(process.env.GPT_CODEX_QUICK_TIMEOUT_MS) || 120_000

// Squad-memory in the codex path: rather than an MCP server, we lean on codex's
// agentic shell — it can run the shared-memory CLI directly (verified: works under
// `-s read-only`, the CLI POSTs/GETs the local Flask store over loopback). The
// model decides when to recall, exactly like a tool call. This is how the codex
// path keeps squad-memory after the chat-engine swap (codex already has web).
const SQUAD_STORE_BIN = process.env.GPT_SQUAD_STORE_BIN || '/home/user/.local/bin/shared-memory'
const VECGREP_BIN = process.env.GPT_VECGREP_BIN || '/home/user/.local/bin/vecgrep'
const IBKR_BIN = process.env.GPT_IBKR_BIN || '/home/user/.local/bin/ibkr'

export interface CodexChatInput {
  systemPrompt: string
  // Same shape gpt.ts already builds (history.ts/formatHistoryForOpenAI).
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  codexModel?: string
  extraText?: string
  channelId?: string
  resumeSessionId?: string
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

export function codexTimeoutMs(input: Pick<CodexChatInput, 'userMessage' | 'extraText'>): number {
  const text = `${input.userMessage}\n${input.extraText ?? ''}`.toLowerCase()
  // Recovery/meta pings should fail fast into the API fallback instead of tying
  // up the channel behind a 10-minute Codex leash.
  if (text.length < 400 && /\b(where'?d ya go|where did you go|pooping out|hung|stuck|choked|timeout|token limit|response time|alive|ping)\b/.test(text)) {
    return DEFAULT_QUICK_TIMEOUT_MS
  }
  return DEFAULT_TASK_TIMEOUT_MS
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
    `For Jeff's live IBKR brokerage data (real quotes, positions, margin/liquidity, P&L, technicals, risk metrics), run the ${IBKR_BIN} CLI. Examples: ${IBKR_BIN} quote MU  |  ${IBKR_BIN} positions  |  ${IBKR_BIN} margin  |  ${IBKR_BIN} pnl  |  ${IBKR_BIN} tools (lists all 34, then ${IBKR_BIN} <tool> '<json-args>' to call any). Use it whenever the question needs real account or market numbers - never guess prices or invent positions. Output is sensitive: only share portfolio specifics where Jeff already is.`,
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

const clip2 = (x: unknown, n: number) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const countOutputLines = (x: unknown) => {
  const t = String(x ?? '').replace(/\n+$/, '')
  return t ? t.split('\n').length : 0
}

// Strip codex's `/bin/bash -lc '<inner>'` wrapper + basename the leading path.
function cleanCmd(raw: string): string {
  const m = raw.match(/-l?c\s+'([\s\S]*)'\s*$/)
  const cmd = (m ? m[1] : raw).trim().replace(/\s+/g, ' ')
  return cmd.replace(/^\/\S*\/([^/\s]+)/, '$1')
}

export function toolCallsFromCompletedItem(it: any): ToolCall[] {
  switch (it?.type) {
    case 'command_execution':
      return [{
        name: 'shell',
        args: { command: clip2(cleanCmd(String(it.command ?? '')), 80) },
        durationMs: 0,
        resultPreview: clip2(it.aggregated_output, 200),
        resultLines: countOutputLines(it.aggregated_output),
        failed: typeof it.exit_code === 'number' ? it.exit_code !== 0 : false,
      }]
    case 'file_change':
      return (Array.isArray(it.changes) ? it.changes : []).map((ch: any) => ({
        name: 'edit',
        args: { file_path: String(ch.path ?? '') },
        durationMs: 0,
        resultPreview: String(ch.kind ?? 'update'),
        failed: false,
      }))
    case 'web_search':
      return [{
        name: 'web_search',
        args: { query: clip2(it.query, 140) },
        durationMs: 0,
        resultPreview: clip2(it.result ?? it.aggregated_output, 200),
        failed: false,
      }]
    case 'mcp_tool_call':
      return [{
        name: clip2(it.tool ?? it.name ?? 'mcp', 40) || 'mcp',
        args: typeof it.arguments === 'object' && it.arguments ? it.arguments : {},
        durationMs: 0,
        resultPreview: clip2(it.result, 200),
        failed: it.status ? it.status !== 'completed' : false,
      }]
    default:
      return []
  }
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
        toolCalls.push(...toolCallsFromCompletedItem(it))
        break
      }
      case 'file_change':
        // codex now writes/edits files (workspace-write). The --json file_change item
        // carries the changed paths + kind (add/update/delete) but NOT the hunk text,
        // so we surface the edited files (these can wrap — they're the "diffs").
        toolCalls.push(...toolCallsFromCompletedItem(it))
        break
      case 'web_search':
        toolCalls.push(...toolCallsFromCompletedItem(it))
        break
      case 'mcp_tool_call':
        toolCalls.push(...toolCallsFromCompletedItem(it))
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

function parseFunctionCallArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return { arguments: raw }
  }
}

function responseFunctionCallEvent(payload: any): { status: string; tool?: { name: string; args: string } } | null {
  const name = String(payload?.name ?? '').trim()
  if (!name) return null
  const args = parseFunctionCallArgs(payload?.arguments)
  if (name === 'exec_command') {
    return { status: '🛠️ running', tool: { name: 'shell', args: cleanCmd(String(args.cmd ?? args.command ?? '')) } }
  }
  if (name === 'apply_patch') {
    return { status: '✏️ editing', tool: { name: 'edit', args: String(args.patch ?? args.arguments ?? '') } }
  }
  if (name === 'web_search' || name === 'web.run') {
    return { status: '🌐 searching', tool: { name, args: JSON.stringify(args) } }
  }
  return { status: '🔧 tooling', tool: { name, args: JSON.stringify(args) } }
}

// From a codex item.started event, derive BOTH a generic animated status for the
// placeholder AND the real tool call (name + args) for the live trace — so the
// placeholder stays clean ("running…") while the trace shows the actual command.
function mcpToolEvent(invocation: any): { status: string; tool?: { name: string; args: string } } | null {
  const toolName = String(invocation?.tool ?? invocation?.name ?? '').trim()
  if (!toolName) return null
  const server = String(invocation?.server ?? '').trim()
  const name = server ? `${server}.${toolName}` : toolName
  const args = invocation?.arguments ?? invocation?.args ?? {}
  return { status: '🔌 plugin', tool: { name, args: typeof args === 'string' ? args : JSON.stringify(args) } }
}

function isToolItemType(type: unknown): boolean {
  return type === 'command_execution'
    || type === 'file_change'
    || type === 'web_search'
    || type === 'mcp_tool_call'
}

export function liveEvent(ev: any): { status: string; tool?: { name: string; args: string } } | null {
  if (ev?.type === 'event_msg' && ev.payload?.type === 'mcp_tool_call_begin') {
    return mcpToolEvent(ev.payload.invocation)
  }
  if (ev?.type === 'event_msg' && ev.payload?.type === 'function_call') {
    return responseFunctionCallEvent(ev.payload)
  }
  if (ev?.type === 'response_item' && ev.payload?.type === 'function_call') {
    return responseFunctionCallEvent(ev.payload)
  }

  if (ev?.type !== 'item.started' || !ev.item) return null
  const it = ev.item
  switch (it.type) {
    case 'command_execution':
      return { status: '🛠️ running', tool: { name: 'shell', args: cleanCmd(String(it.command ?? '')) } }
    case 'web_search':
      return { status: '🌐 searching', tool: { name: 'web_search', args: String(it.query ?? '') } }
    case 'file_change': {
      const paths = Array.isArray(it.changes) ? it.changes.map((c: any) => c.path).join(', ') : ''
      return { status: '✏️ editing', tool: { name: 'edit', args: paths } }
    }
    case 'mcp_tool_call':
      return mcpToolEvent(it.invocation ?? it)
    case 'reasoning':
      return { status: '🧠 thinking' }
    default:
      return null
  }
}

// The --json exec stream omits file-edit hunk text; codex's session rollout keeps
// it. Locate the rollout by thread_id (== the rollout filename suffix) and pull
// each path's unified_diff from the patch_apply_end events. Best-effort.
async function readRolloutDiffs(threadId: string): Promise<Array<{ path: string; diff: string }>> {
  const out: Array<{ path: string; diff: string }> = []
  const base = path.join(os.homedir(), '.codex', 'sessions')
  let entries: string[] = []
  try { entries = (await readdir(base, { recursive: true })) as string[] } catch { return out }
  const rel = entries.find(e => e.endsWith(`${threadId}.jsonl`))
  if (!rel) return out
  let content = ''
  try { content = await readFile(path.join(base, rel), 'utf8') } catch { return out }
  // Ordered list, not a per-path map: multiple edits to the SAME file each get
  // their own patch_apply_end, and we must pair them to edit toolCalls in order
  // (else two edits to one file both show the last diff — Jeff 2026-06-24).
  for (const line of content.split('\n')) {
    if (!line.includes('patch_apply_end')) continue
    try {
      const ev = JSON.parse(line)
      const changes = ev?.payload?.changes
      if (changes && typeof changes === 'object') {
        for (const [p, info] of Object.entries(changes as Record<string, any>)) {
          if (info?.unified_diff) out.push({ path: p, diff: String(info.unified_diff) })
        }
      }
    } catch { /* skip malformed line */ }
  }
  return out
}

// Extract the user/assistant conversation from a codex session rollout, for
// /gpt history. event_msg events carry the clean turns (user_message /
// agent_message); developer/permissions noise is skipped. Oldest-first; [] if
// the session file can't be found.
export async function readSessionHistory(sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
  const base = path.join(os.homedir(), '.codex', 'sessions')
  let entries: string[] = []
  try { entries = (await readdir(base, { recursive: true })) as string[] } catch { return turns }
  const rel = entries.find(e => e.endsWith(`${sessionId}.jsonl`))
  if (!rel) return turns
  let content = ''
  try { content = await readFile(path.join(base, rel), 'utf8') } catch { return turns }
  for (const line of content.split('\n')) {
    if (!line.includes('event_msg')) continue
    try {
      const o = JSON.parse(line)
      if (o?.type !== 'event_msg') continue
      const p = o.payload || {}
      const text = String(p.message ?? p.text ?? '').trim()
      if (!text) continue
      if (p.type === 'user_message') turns.push({ role: 'user', text })
      else if (p.type === 'agent_message') turns.push({ role: 'assistant', text })
    } catch { /* skip malformed */ }
  }
  return turns
}

export interface RateWindow { usedPercent: number; windowMinutes: number; resetsAt: number }
export interface RateLimits { primary?: RateWindow; secondary?: RateWindow; planType?: string }

function findRateLimits(o: any): any {
  if (!o || typeof o !== 'object') return null
  if (o.rate_limits && (o.rate_limits.primary || o.rate_limits.secondary)) return o.rate_limits
  for (const k of Object.keys(o)) { const r = findRateLimits(o[k]); if (r) return r }
  return null
}

// Freshest ChatGPT-sub rate-limit snapshot codex logged — rides a token_count event
// in the session rollout (not the --json stream), so scan the newest rollouts for the
// most recent one. primary = 5h window, secondary = weekly. Best-effort; null if none.
export async function readLatestRateLimits(): Promise<RateLimits | null> {
  const base = path.join(os.homedir(), '.codex', 'sessions')
  let entries: string[] = []
  try { entries = (await readdir(base, { recursive: true })) as string[] } catch { return null }
  const rollouts = entries.filter(e => e.includes('rollout-') && e.endsWith('.jsonl')).sort().reverse()
  for (const rel of rollouts.slice(0, 40)) {
    let content = ''
    try { content = await readFile(path.join(base, rel), 'utf8') } catch { continue }
    const lines = content.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue
      try {
        const rl = findRateLimits(JSON.parse(lines[i]))
        if (rl) {
          const w = (x: any): RateWindow | undefined =>
            x ? { usedPercent: Number(x.used_percent), windowMinutes: Number(x.window_minutes), resetsAt: Number(x.resets_at) } : undefined
          return { primary: w(rl.primary), secondary: w(rl.secondary), planType: rl.plan_type ?? undefined }
        }
      } catch { /* skip non-JSON */ }
    }
  }
  return null
}

// Lean prompt for a RESUMED session: codex already holds persona + history in the
// session, so send only the new user turn (+ any extra context). Keeping it minimal
// is what stops the session from bloating turn over turn.
function buildResumePrompt(input: CodexChatInput): string {
  const who = input.userName ? `[${input.userName}] ` : ''
  const extra = input.extraText?.trim() ? `\n\n[Additional context]\n${input.extraText.trim()}` : ''
  return `${who}${input.userMessage}${extra}`
}

export async function respondViaCodex(input: CodexChatInput): Promise<RespondResult> {
  const t0 = Date.now()
  input.onEvent?.({ type: 'thinking_start' })

  const resuming = !!input.resumeSessionId
  // On resume, codex already holds the persona + full prior conversation in the
  // session, so send a LEAN prompt (just the new message); re-injecting persona +
  // history every turn would bloat the session. Fresh turns get the full prompt.
  const prompt = resuming ? buildResumePrompt(input) : buildPrompt(input)
  const effort = mapEffort(input.reasoningEffort)
  const outfile = `/tmp/gpt_codexchat_${randomBytes(6).toString('hex')}.txt`
  const timeoutMs = codexTimeoutMs(input)
  const secs = Math.floor(timeoutMs / 1000)
  const model = input.codexModel || 'gpt-5.5'

  // --json → JSONL events on stdout; -o → clean final reply to a file; prompt via
  // env (CODEX_PROMPT) so user text can't break out of the shell. `exec resume` is
  // pickier than fresh `exec`: it REJECTS --add-dir and -s (the resumed session
  // INHERITS its sandbox + dirs from the original), so resume carries only the
  // minimal flags. Fresh exec keeps the full sandbox setup. (verified 2026-06-25)
  const common = `-c model="${model}" -c model_reasoning_effort=${effort} --json -o "${outfile}"`
  // --dangerously-bypass-approvals-and-sandbox is the ONLY way codex exec runs MCP
  // tool calls (Playwright browser) non-interactively — without it every MCP call is
  // auto-cancelled ("user cancelled MCP tool call", codex GH #24135). Tradeoff Jeff
  // accepted 2026-06-25: gpt runs UNSANDBOXED (full /home/user write, not just /tmp).
  const BYPASS = '--dangerously-bypass-approvals-and-sandbox'
  const execPart = resuming
    ? `exec resume --skip-git-repo-check ${BYPASS} ${common} "${input.resumeSessionId}" "$CODEX_PROMPT"`
    : `exec --skip-git-repo-check ${BYPASS} ${common} "$CODEX_PROMPT"`
  const script = `cd /tmp && timeout -k 5 ${secs} "${CODEX_BIN}" ${execPart} </dev/null 2>/dev/null`

  // Stream codex's JSONL events line-by-line so we can surface what it's doing
  // LIVE (running cmd / searching / editing) to the placeholder via onEvent, while
  // still collecting every line for the post-turn trace/usage parse.
  const child = spawn('bash', ['-lc', script], {
    detached: true,  // own process group so /gpt stop can SIGKILL the whole codex tree
    env: { ...process.env, CODEX_PROMPT: prompt, SQUAD_STORE_URL: process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005' },
  })
  // Kill the whole group (bash + timeout + codex), not just bash, so a stuck
  // tool-loop actually dies; falls back to a plain kill if the group send fails.
  const killTree = () => { try { process.kill(-(child.pid as number), 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} } }
  let stoppedByUser = false
  if (input.channelId) activeTurns.register(input.channelId, () => { stoppedByUser = true; killTree() })
  const lines: string[] = []
  let threadId = ''
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    if (!line.trim()) return
    lines.push(line)
    try {
      const obj = JSON.parse(line)
      if (obj?.type === 'thread.started' && obj.thread_id) threadId = String(obj.thread_id)
      // Barge-safety: track whether codex is mid a DESTRUCTIVE tool (shell/file-edit)
      // so canBarge() blocks a barge that would SIGKILL a half-written file. Set on
      // the item.started, cleared on the matching item.completed. web_search/reasoning
      // are non-destructive → not tracked (safe to barge through). (Jeff 2026-07-01)
      if (input.channelId) {
        if (obj?.type === 'item.started' && obj.item) {
          // Normal message barge-in is deferred until a tool boundary so we do
          // not kill Codex mid-thought/output. Stop before surfacing the next
          // tool row; the queued replacement message will run as this turn exits.
          if (isToolItemType(obj.item.type) && activeTurns.stopIfPending(input.channelId)) return
          if (obj.item.type === 'command_execution') activeTurns.setBusy(input.channelId, 'shell')
          else if (obj.item.type === 'file_change') activeTurns.setBusy(input.channelId, 'edit')
        } else if (obj?.type === 'item.completed' && obj.item &&
                   (obj.item.type === 'command_execution' || obj.item.type === 'file_change')) {
          activeTurns.clearBusy(input.channelId)
        }
      }
      const ev = liveEvent(obj)
      if (ev) {
        input.onEvent?.({ type: 'status', label: ev.status })
        if (ev.tool) input.onEvent?.({ type: 'tool_start', name: ev.tool.name, args: ev.tool.args })
      }
      if (obj?.type === 'item.completed' && obj.item) {
        const completed = toolCallsFromCompletedItem(obj.item)
        for (const call of completed) input.onEvent?.({ type: 'tool_end', ...call })
        // Codex only exposes edit hunks in the rollout file. The write is close
        // behind the JSONL stream, so give it a beat and enrich the live row if
        // the diff is already available. Final rendering still does the same
        // enrichment after the process exits.
        if (threadId && completed.some(c => c.name === 'edit')) {
          setTimeout(() => {
            readRolloutDiffs(threadId)
              .then((diffs) => {
                for (const call of completed.filter(c => c.name === 'edit')) {
                  const p = String(call.args.file_path ?? '')
                  const d = diffs.find(x => x.path === p)
                  if (d) input.onEvent?.({ type: 'tool_end', ...call, diff: d.diff })
                }
              })
              .catch(() => {})
          }, 250)
        }
      }
    } catch { /* non-JSON line */ }
  })
  let replyFromFile = ''
  let timedOut = false
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { timedOut = true; killTree(); resolve() }, timeoutMs + 8_000)
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('close', () => { clearTimeout(timer); resolve() })
    })
    replyFromFile = await readFile(outfile, 'utf8').catch(() => '')
  } finally {
    if (input.channelId) activeTurns.done(input.channelId)
    rl.close()
    await rm(outfile, { force: true }).catch(() => {})
  }

  const parsed = parseCodexEvents(lines.join('\n'))
  // Enrich file edits with the real unified diff from codex's session rollout.
  if (threadId && parsed.toolCalls.some(t => t.name === 'edit')) {
    try {
      const diffs = await readRolloutDiffs(threadId)
      const used = new Array(diffs.length).fill(false)
      for (const tc of parsed.toolCalls) {
        if (tc.name !== 'edit') continue
        const p = String(tc.args.file_path ?? '')
        const idx = diffs.findIndex((d, i) => !used[i] && d.path === p)
        if (idx >= 0) { tc.diff = diffs[idx].diff; used[idx] = true }
      }
    } catch { /* diff is best-effort enrichment */ }
  }
  // Prefer the -o file (the clean final message); fall back to the last
  // agent_message in the event stream if the file came back empty.
  const reply = (replyFromFile.trim() || parsed.lastAgentMessage).trim()
  if (stoppedByUser) throw new CodexStoppedError(Date.now() - t0)
  if (!reply) {
    if (timedOut) throw new CodexInterruptedError(Date.now() - t0)
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
    threadId,
  }
}
