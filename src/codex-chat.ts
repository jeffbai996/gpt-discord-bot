import { createInterface } from 'node:readline'
import { rm, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { activeTurns } from './active-turns.ts'
import { killProcessTree } from './kill-tree.ts'
import { spawnSupervisedProcess, type ProcessSupervisorResult } from './process-supervisor.ts'
import { formatTurnOutcome, type TurnOutcome } from './turn-log.ts'
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

export class CodexProcessDiedError extends Error {
  constructor(public readonly afterMs: number, detail: string, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'CodexProcessDiedError'
  }
}

export class CodexStoppedError extends Error {
  constructor(public readonly afterMs: number) {
    super(`codex turn stopped by user (/gpt stop) after ${Math.round(afterMs/1000)}s`)
    this.name = 'CodexStoppedError'
  }
}

// Same binary the codex *tool* uses — Codex (OpenAI GPT-5.6) under nvm v22.
const CODEX_BIN = process.env.GPT_CODEX_BIN || '/home/user/.nvm/versions/node/v22.22.2/bin/codex'
// Watchdog policy, not a guessed "turn should be done by now" timer.
// Real repo work can run for a long time as long as Codex is still emitting JSONL
// progress. The idle watchdog kills only a silent/wedged child; the hard timeout is
// a final runaway fuse so a broken process cannot live forever.
const DEFAULT_TASK_IDLE_TIMEOUT_MS = Number(process.env.GPT_CODEX_IDLE_TIMEOUT_MS) || 10 * 60_000
const DEFAULT_TASK_HARD_TIMEOUT_MS = Number(process.env.GPT_CODEX_CHAT_TIMEOUT_MS) || 45 * 60_000
const DEFAULT_QUICK_TIMEOUT_MS = Number(process.env.GPT_CODEX_QUICK_TIMEOUT_MS) || 120_000
// Five seconds keeps the live row visibly animated while remaining far below
// Discord's REST edit pressure. discord.js still owns bucket-level throttling.
const DEFAULT_HEARTBEAT_MS = Number(process.env.GPT_CODEX_HEARTBEAT_MS) || 5_000
const DEFAULT_KILL_GRACE_MS = Number(process.env.GPT_CODEX_KILL_GRACE_MS) || 5_000
const MAX_STDERR_CHARS = Number(process.env.GPT_CODEX_STDERR_MAX_CHARS) || 64 * 1024

// Squad-memory in the codex path: rather than an MCP server, we lean on codex's
// agentic shell — it can run the shared-memory CLI directly (verified: works under
// `-s read-only`, the CLI POSTs/GETs the local Flask store over loopback). The
// model decides when to recall, exactly like a tool call. This is how the codex
// path keeps squad-memory after the chat-engine swap (codex already has web).
const SQUAD_STORE_BIN = process.env.GPT_SQUAD_STORE_BIN || '/home/user/.local/bin/shared-memory'
const VECGREP_BIN = process.env.GPT_VECGREP_BIN || '/home/user/.local/bin/vecgrep'
const IBKR_BIN = process.env.GPT_IBKR_BIN || '/home/user/.local/bin/ibkr'
const LIVE_PROGRESS_INSTRUCTION =
  'Keep the Discord user visibly informed while you work: send a concise commentary update early, ' +
  'then another whenever the activity changes or roughly once a minute during long work. Commentary ' +
  'is progress, not the final answer; do not expose private hidden reasoning.'

export interface CodexChatInput {
  systemPrompt: string
  // Same shape gpt.ts already builds (history.ts/formatHistoryForOpenAI).
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  codexModel?: string
  extraText?: string
  imagePaths?: string[]
  readOnly?: boolean
  channelId?: string
  turnGeneration?: number
  resumeSessionId?: string
  signal?: AbortSignal
  onEvent?: (event: LifecycleEvent) => void
}

// Discord's reasoning flag → Codex's config knob.
// medium is the chat default; deeper levels are explicit per-channel choices.
export function mapEffort(effort?: string): string {
  switch (effort) {
    case 'none':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max': return effort
    case 'minimal': return 'low' // legacy alias
    default: return 'medium'
  }
}

export interface CodexWatchdogPolicy {
  idleTimeoutMs: number
  hardTimeoutMs: number
  quick: boolean
}

export function codexWatchdogPolicy(input: Pick<CodexChatInput, 'userMessage' | 'extraText'>): CodexWatchdogPolicy {
  const text = `${input.userMessage}\n${input.extraText ?? ''}`.toLowerCase()
  // Recovery/meta pings should fail fast into the API fallback instead of tying
  // up the channel behind a 10-minute Codex leash. But an actionable repair
  // request can contain the same words ("fix why gpt is hung") and still needs
  // the full task window; otherwise debugging the hang self-sabotages at 120s.
  const isRecoveryPing = /\b(where'?d ya go|where did you go|pooping out|hung|stuck|choked|timeout|token limit|response time|alive|ping)\b/.test(text)
  const asksForWork = /\b(fix|solve|squash|patch|debug|diagnose|diagnosis|investigate|figure out|prevent|repair|implement)\b/.test(text)
  // A message that ASKS FOR AN EXPLANATION ("why are you stuck", "what made you
  // time out", "how come you hung") is a real diagnostic question, not a throwaway
  // status poke — it needs the full window or the answer self-sabotages at 120s.
  // Bare pokes ("you alive?", "where'd ya go?") have no why/what/how, so they still
  // fail fast. (Jeff 2026-07-05 — real questions were getting killed mid-work.)
  const asksForExplanation = /\b(why|what made|what caused|what happened|how come|how'?d|how did)\b/.test(text)
  if (text.length < 400 && isRecoveryPing && !asksForWork && !asksForExplanation) {
    return { idleTimeoutMs: DEFAULT_QUICK_TIMEOUT_MS, hardTimeoutMs: DEFAULT_QUICK_TIMEOUT_MS, quick: true }
  }
  return {
    idleTimeoutMs: DEFAULT_TASK_IDLE_TIMEOUT_MS,
    hardTimeoutMs: Math.max(DEFAULT_TASK_HARD_TIMEOUT_MS, DEFAULT_TASK_IDLE_TIMEOUT_MS + 60_000),
    quick: false,
  }
}

export function codexTimeoutMs(input: Pick<CodexChatInput, 'userMessage' | 'extraText'>): number {
  return codexWatchdogPolicy(input).hardTimeoutMs
}

export function isIntentionalCodexSilence(
  reply: string,
  processResult: ProcessSupervisorResult | null,
): boolean {
  return !reply.trim()
    && processResult?.code === 0
    && processResult.signal === null
    && processResult.stopReason === null
    && !processResult.error
}

export interface CodexArgsInput {
  prompt: string
  model: string
  effort: string
  outfile: string
  resumeSessionId?: string
  imagePaths?: string[]
  readOnly?: boolean
}

export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args = ['exec']
  if (input.resumeSessionId) args.push('resume')
  args.push(
    '--skip-git-repo-check',
    ...(input.readOnly
      ? ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"']
      : ['--dangerously-bypass-approvals-and-sandbox']),
    '-c', `model="${input.model}"`,
    '-c', `model_reasoning_effort=${input.effort}`,
    '-c', 'model_reasoning_summary=detailed',
  )
  // Fresh `codex exec --image` accepts one-or-more files and greedily consumes
  // following positional arguments. Keep another option after the image list so
  // the final prompt can never be mistaken for an image path.
  for (const imagePath of input.imagePaths ?? []) args.push('--image', imagePath)
  args.push('--json', '-o', input.outfile)
  if (input.resumeSessionId) args.push(input.resumeSessionId)
  args.push(input.prompt)
  return args
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
    LIVE_PROGRESS_INSTRUCTION,
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
  const agentMessages: string[] = []
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
        if (it.text) {
          lastAgentMessage = String(it.text)
          agentMessages.push(lastAgentMessage)
        }
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

  // 0.144.0 flattens commentary and final prose to agent_message items. Preserve
  // every pre-final message as the reasoning/progress summary so the post-hoc
  // "Thinking" card remains useful even when no reasoning item is emitted.
  const publicProgress = agentMessages.slice(0, -1)
  return {
    toolCalls,
    reasoning: [...reasoningParts, ...publicProgress].join('\n\n'),
    usage,
    lastAgentMessage,
  }
}

// Run a chat turn through the Codex CLI instead of the OpenAI API. Returns a
// RespondResult shaped exactly like openai.respond(), so gpt.ts can use it
// interchangeably. THROWS on process failures and timeouts so the caller can
// apply its explicit fallback policy. A clean exit with no answer is deliberate
// model silence and returns an empty reply for gpt.ts to remove the placeholder.

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
  const args = parseFunctionCallArgs(payload?.arguments ?? payload?.input)
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
  if (ev?.type === 'response_item'
      && (ev.payload?.type === 'function_call' || ev.payload?.type === 'custom_tool_call')) {
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

export function commentaryProgress(ev: any): string | null {
  // Rollout/older protocol: phase is explicit, so never surface final_answer as
  // an in-flight update.
  if (ev?.type === 'event_msg'
      && ev.payload?.type === 'agent_message'
      && ev.payload?.phase === 'commentary') {
    const message = typeof ev.payload.message === 'string' ? ev.payload.message.trim() : ''
    return message || null
  }
  // codex-cli 0.144.0 --json stdout flattens commentary and final prose to the
  // same item.completed agent_message shape. Surface each one live; `-o` remains
  // authoritative for the final answer and replaces this placeholder afterward.
  if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message') {
    const message = typeof ev.item.text === 'string' ? ev.item.text.trim() : ''
    return message || null
  }
  return null
}

export function reasoningProgress(ev: any): string | null {
  // Only render reasoning text Codex explicitly places on the public JSONL
  // protocol. Encrypted/internal thought state is intentionally ignored.
  if (ev?.type !== 'item.completed' || ev.item?.type !== 'reasoning') return null
  const text = typeof ev.item.text === 'string' ? ev.item.text.trim() : ''
  return text || null
}

export function isMeaningfulCodexActivity(ev: any): boolean {
  if (!ev || typeof ev !== 'object') return false
  if (ev.type === 'thread.started'
      || ev.type === 'turn.started'
      || ev.type === 'turn.completed'
      || ev.type === 'turn.failed') return true
  if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item) return true
  if (ev.type === 'response_item'
      && (ev.payload?.type === 'function_call' || ev.payload?.type === 'custom_tool_call')) return true
  if (ev.type === 'event_msg') {
    return ev.payload?.type === 'agent_message'
      || ev.payload?.type === 'mcp_tool_call_begin'
      || ev.payload?.type === 'mcp_tool_call_end'
      || ev.payload?.type === 'function_call'
      || ev.payload?.type === 'task_complete'
  }
  return false
}

export function isInFlightStatusPing(text: string): boolean {
  const s = text.trim().toLowerCase()
  if (!s || s.length > 180) return false
  const statusOnly = /^(?:wait[,.! ]+)?(?:did (?:this|that|you) (?:just )?get stuck|are you (?:still )?(?:working|running|alive)|you (?:still )?(?:working|running|alive)|still (?:working|running)|where(?:'d| did) (?:you|ya) go|alive\??|ping\??)[?!. ]*$/i
  return statusOnly.test(s)
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
export interface RateLimits {
  primary?: RateWindow
  secondary?: RateWindow
  planType?: string
  lastInputTokens?: number
  modelContextWindow?: number
}

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
        const event = JSON.parse(lines[i])
        const rl = findRateLimits(event)
        if (rl) {
          const w = (x: any): RateWindow | undefined =>
            x ? { usedPercent: Number(x.used_percent), windowMinutes: Number(x.window_minutes), resetsAt: Number(x.resets_at) } : undefined
          const info = event?.payload?.info
          return {
            primary: w(rl.primary),
            secondary: w(rl.secondary),
            planType: rl.plan_type ?? undefined,
            lastInputTokens: Number(info?.last_token_usage?.input_tokens) || undefined,
            modelContextWindow: Number(info?.model_context_window) || undefined,
          }
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
  return `${who}${input.userMessage}${extra}\n\n${LIVE_PROGRESS_INSTRUCTION}`
}

export async function respondViaCodex(input: CodexChatInput): Promise<RespondResult> {
  const t0 = Date.now()
  const throwIfStopped = () => {
    if (input.signal?.aborted) throw new CodexStoppedError(Date.now() - t0)
  }
  throwIfStopped()
  input.onEvent?.({ type: 'thinking_start' })

  const resuming = !!input.resumeSessionId
  // On resume, codex already holds the persona + full prior conversation in the
  // session, so send a LEAN prompt (just the new message); re-injecting persona +
  // history every turn would bloat the session. Fresh turns get the full prompt.
  const prompt = resuming ? buildResumePrompt(input) : buildPrompt(input)
  const effort = mapEffort(input.reasoningEffort)
  const outfile = `/tmp/gpt_codexchat_${randomBytes(6).toString('hex')}.txt`
  const watchdog = codexWatchdogPolicy(input)
  const model = input.codexModel || 'gpt-5.6-sol'

  // Spawn Codex directly: no bash, shell interpolation, inherited stdin, stderr
  // temp file, or intermediate process whose exit can race the real child. Resume
  // still carries only the flags it accepts and inherits sandbox/dirs from the
  // original session. The bypass flag is required for non-interactive MCP calls.
  const args = buildCodexArgs({
    prompt,
    model,
    effort,
    outfile,
    resumeSessionId: input.resumeSessionId,
    imagePaths: input.imagePaths,
    readOnly: input.readOnly,
  })
  const supervisor = spawnSupervisedProcess(CODEX_BIN, args, {
    cwd: '/tmp',
    detached: true,
    env: { ...process.env, SQUAD_STORE_URL: process.env.SQUAD_STORE_URL || 'http://127.0.0.1:5005' },
  }, {
    idleTimeoutMs: watchdog.idleTimeoutMs,
    hardTimeoutMs: watchdog.hardTimeoutMs,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
  }, {
    kill: child => {
      try {
        if (child.pid) killProcessTree(child.pid)
        else child.kill('SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* supervisor force-settles */ }
      }
    },
    onHeartbeat: beat => input.onEvent?.({ type: 'heartbeat', ...beat }),
  })
  const child = supervisor.child
  let stoppedByUser = false
  const stopRunningTurn = () => { stoppedByUser = true; supervisor.stop('user') }
  if (input.signal) {
    if (input.signal.aborted) stopRunningTurn()
    else input.signal.addEventListener('abort', stopRunningTurn, { once: true })
  }
  const lines: string[] = []
  let threadId = ''
  let stderrTail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_CHARS)
  })
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    if (!line.trim()) return
    lines.push(line)
    try {
      const obj = JSON.parse(line)
      if (isMeaningfulCodexActivity(obj)) supervisor.markActivity()
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
          if (isToolItemType(obj.item.type) &&
              activeTurns.stopIfPending(input.channelId, input.turnGeneration)) return
          if (obj.item.type === 'command_execution') {
            activeTurns.setBusy(input.channelId, 'shell', input.turnGeneration)
          } else if (obj.item.type === 'file_change') {
            activeTurns.setBusy(input.channelId, 'edit', input.turnGeneration)
          }
        } else if (obj?.type === 'item.completed' && obj.item &&
                   (obj.item.type === 'command_execution' || obj.item.type === 'file_change')) {
          activeTurns.clearBusy(input.channelId, input.turnGeneration)
        }
      }
      const ev = liveEvent(obj)
      if (ev) {
        input.onEvent?.({ type: 'status', label: ev.status })
        if (ev.tool) input.onEvent?.({ type: 'tool_start', name: ev.tool.name, args: ev.tool.args })
      }
      const progress = commentaryProgress(obj)
      if (progress) input.onEvent?.({ type: 'progress', reply: progress })
      const reasoning = reasoningProgress(obj)
      if (reasoning) input.onEvent?.({ type: 'reasoning_progress', text: reasoning })
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
  let codexStderr = ''
  let timedOut = false
  let timeoutKind: 'idle' | 'hard' | null = null
  let processResult: Awaited<ReturnType<typeof supervisor.wait>> | null = null
  try {
    processResult = await supervisor.wait()
    timedOut = processResult.stopReason === 'idle' || processResult.stopReason === 'hard'
    timeoutKind = timedOut ? processResult.stopReason as 'idle' | 'hard' : null
    replyFromFile = await readFile(outfile, 'utf8').catch(() => '')
    codexStderr = stderrTail.trim()
  } finally {
    if (input.signal) input.signal.removeEventListener('abort', stopRunningTurn)
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

  // One scannable outcome line per turn (the codex path was silent before, so a
  // mid-turn death left no trace). stderr tail rides along on a failure. (Jeff 2026-07-05)
  const logOutcome = (outcome: TurnOutcome, detail?: string) => {
    const errTail = codexStderr ? ` stderr: ${codexStderr.replace(/\s+/g, ' ').slice(-300)}` : ''
    console.error(formatTurnOutcome({
      outcome, durationMs: Date.now() - t0, lines: lines.length,
      replyChars: reply.length, timedOut, stoppedByUser,
      detail: (detail ?? '') + errTail || undefined,
    }))
  }

  if (stoppedByUser || processResult?.stopReason === 'user') {
    logOutcome('stopped')
    throw new CodexStoppedError(Date.now() - t0)
  }
  if (timedOut) {
    const forced = processResult?.forced ? '; forced settle after failed child close' : ''
    logOutcome('timeout', `${timeoutKind ?? 'unknown'} watchdog fired${forced}`)
    throw new CodexInterruptedError(Date.now() - t0)
  }
  if (processResult?.error) {
    logOutcome('error', processResult.error.message)
    throw new CodexProcessDiedError(Date.now() - t0, processResult.error.message, { cause: processResult.error })
  }
  if (processResult && processResult.code !== 0) {
    const detail = `codex exited code=${processResult.code} signal=${processResult.signal ?? 'none'}`
    logOutcome('error', detail)
    throw new CodexProcessDiedError(Date.now() - t0, detail)
  }
  if (isIntentionalCodexSilence(reply, processResult)) {
    logOutcome('empty', `no answer (lines=${lines.length})`)
  } else if (!reply) {
    // Defensive: all known unsuccessful process states are handled above. Do
    // not silently accept an unknown completion shape as intentional silence.
    logOutcome('error', `no answer from unclassified completion (lines=${lines.length})`)
    throw new Error(`codex chat produced no answer from an unclassified completion (lines=${lines.length})`)
  } else {
    logOutcome('completed')
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
