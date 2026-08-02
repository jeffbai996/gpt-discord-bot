export type CodexAgentStatus = 'running' | 'done' | 'failed'

export interface CodexAgentSnapshot {
  id: string
  path: string
  label: string
  nickname: string
  model: string
  status: CodexAgentStatus
  startedAt: number
  endedAt?: number
  tokens: number
}

interface MutableAgent extends CodexAgentSnapshot {
  spawnCallId?: string
}

function objectFromJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function eventMs(event: any, fallback: number): number {
  const parsed = Date.parse(String(event?.timestamp ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function pathLabel(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) || 'agent'
}

function totalTokens(event: any): number | null {
  const total = Number(event?.payload?.info?.total_token_usage?.total_tokens)
  if (Number.isFinite(total)) return Math.max(0, total)
  const usage = event?.usage ?? event?.payload?.usage
  const input = Number(usage?.input_tokens)
  const output = Number(usage?.output_tokens)
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return Math.max(0, (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0))
  }
  return null
}

/** Pure registry for the root rollout and every child rollout in one workflow. */
export class CodexAgentRegistry {
  private readonly agents = new Map<string, MutableAgent>()
  private readonly knownThreads = new Set<string>()
  private readonly spawnPaths = new Map<string, string>()

  constructor(
    readonly rootThreadId: string,
    private readonly fallbackStartedAt: number,
  ) {
    this.knownThreads.add(rootThreadId)
  }

  threadIds(): string[] {
    return [...this.knownThreads]
  }

  acceptsParent(parentThreadId: string): boolean {
    return this.knownThreads.has(parentThreadId)
  }

  consumeRoot(event: any): boolean {
    if (event?.type !== 'response_item') return false
    const payload = event.payload
    if (payload?.type === 'function_call'
        && payload?.namespace === 'collaboration'
        && payload?.name === 'spawn_agent') {
      const args = objectFromJson(payload.arguments)
      const callId = String(payload.call_id ?? payload.id ?? '')
      const taskName = String(args.task_name ?? 'agent').replace(/^\/+/, '') || 'agent'
      const path = taskName.startsWith('root/') ? `/${taskName}` : `/root/${taskName}`
      const id = callId ? `spawn:${callId}` : `spawn:${path}:${this.agents.size}`
      if (!this.agents.has(id)) {
        this.agents.set(id, {
          id,
          path,
          label: taskName.split('/').at(-1) || 'agent',
          nickname: '',
          model: String(args.model ?? ''),
          status: 'running',
          startedAt: eventMs(event, this.fallbackStartedAt),
          tokens: 0,
          spawnCallId: callId || undefined,
        })
      }
      if (callId) this.spawnPaths.set(callId, path)
      return true
    }
    if (payload?.type === 'function_call_output') {
      const callId = String(payload.call_id ?? '')
      if (!callId || !this.spawnPaths.has(callId)) return false
      const output = objectFromJson(payload.output)
      const path = String(output.task_name ?? this.spawnPaths.get(callId) ?? '')
      const agent = [...this.agents.values()].find(row => row.spawnCallId === callId)
      if (!agent || !path) return false
      agent.path = path
      agent.label = pathLabel(path)
      this.spawnPaths.set(callId, path)
      return true
    }
    if (payload?.type === 'agent_message') {
      const path = String(payload.author ?? '')
      const agent = [...this.agents.values()].find(row => row.path === path)
      if (!agent || agent.status !== 'running') return false
      agent.status = 'done'
      agent.endedAt = eventMs(event, Date.now())
      return true
    }
    return false
  }

  consumeChild(threadId: string, event: any): boolean {
    if (!threadId) return false
    if (event?.type === 'session_meta') {
      const payload = event.payload ?? {}
      const parentThreadId = String(payload.parent_thread_id ?? '')
      if (!this.acceptsParent(parentThreadId)) return false
      this.knownThreads.add(threadId)
      const path = String(payload.agent_path ?? `/root/${threadId.slice(0, 8)}`)
      const existingEntry = [...this.agents.entries()].find(([, row]) => row.path === path)
      const existing = existingEntry?.[1]
      const agent: MutableAgent = {
        id: threadId,
        path,
        label: pathLabel(path),
        nickname: String(payload.agent_nickname ?? existing?.nickname ?? ''),
        model: existing?.model ?? '',
        status: existing?.status ?? 'running',
        startedAt: existing?.startedAt ?? eventMs(event, this.fallbackStartedAt),
        endedAt: existing?.endedAt,
        tokens: existing?.tokens ?? 0,
      }
      if (existingEntry) this.agents.delete(existingEntry[0])
      this.agents.set(threadId, agent)
      return true
    }

    const agent = this.agents.get(threadId)
    if (!agent) return false
    let changed = false
    if (event?.type === 'turn_context') {
      const model = String(event?.payload?.model ?? '')
      if (model && model !== agent.model) {
        agent.model = model
        changed = true
      }
    }
    const tokens = totalTokens(event)
    if (tokens !== null && tokens !== agent.tokens) {
      agent.tokens = tokens
      changed = true
    }
    const payloadType = String(event?.payload?.type ?? '')
    if (event?.type === 'turn.failed' || payloadType === 'task_failed' || payloadType === 'turn_aborted') {
      agent.status = 'failed'
      agent.endedAt = eventMs(event, Date.now())
      return true
    }
    if ((event?.type === 'event_msg' && payloadType === 'task_complete')
        || event?.type === 'turn.completed') {
      agent.status = 'done'
      agent.endedAt = eventMs(event, Date.now())
      return true
    }
    return changed
  }

  snapshot(): CodexAgentSnapshot[] {
    return [...this.agents.values()].map(({ spawnCallId: _spawnCallId, ...agent }) => ({ ...agent }))
  }
}

const SPINNER = ['◐', '◓', '◑', '◒'] as const
const RUN_BLINK = ['○', '◉'] as const

function fmtElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60)
    return seconds % 60 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${minutes}m`
  }
  return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function modelAlias(model: string): string {
  const lower = model.toLowerCase()
  for (const alias of ['terra', 'luna', 'sol']) if (lower.includes(alias)) return alias
  return model ? model.replace(/^gpt-/, '').slice(0, 10) : '?'
}

export function renderAgentsPanel(
  agents: CodexAgentSnapshot[],
  now = Date.now(),
  spinnerFrame = 0,
  final = false,
): string {
  if (!agents.length) return ''
  const running = agents.filter(agent => agent.status === 'running').length
  const done = agents.length - running
  const total = agents.reduce((sum, agent) => sum + agent.tokens, 0)
  const spinner = final || running === 0 ? '●' : SPINNER[spinnerFrame % SPINNER.length]
  const header = `${spinner} agents · gpt · ${running} running · ${done} done · ${fmtTokens(total)} tok`
  const cells = agents.map(agent => {
    const glyph = agent.status === 'running'
      ? RUN_BLINK[spinnerFrame % RUN_BLINK.length]
      : agent.status === 'done' ? '●' : '✗'
    const end = agent.endedAt ?? now
    return [
      glyph,
      agent.label.slice(0, 40),
      modelAlias(agent.model),
      fmtElapsed(end - agent.startedAt),
      fmtTokens(agent.tokens),
    ]
  })
  const widths = Array.from({ length: 5 }, (_, column) =>
    Math.max(...cells.map(row => row[column].length)))
  const rows = cells.map(row => `  ${row[0]}  ${row[1].padEnd(widths[1])}  `
    + `${row[2].padEnd(widths[2])}  ${row[3].padStart(widths[3])}  ${row[4].padStart(widths[4])}`)
  return `\`\`\`\n${header}\n\n${rows.join('\n')}\n\`\`\``
}

export function appendAgentsPanel(
  cards: string[],
  agents: CodexAgentSnapshot[],
  now = Date.now(),
  spinnerFrame = 0,
  final = false,
): string[] {
  const panel = renderAgentsPanel(agents, now, spinnerFrame, final)
  if (!panel) return cards
  if (!cards.length) return [panel]
  const out = [...cards]
  const last = out.at(-1) ?? ''
  const combined = `${last}\n${panel}`
  if (combined.length <= 2_000) out[out.length - 1] = combined
  else out.push(panel)
  return out
}
