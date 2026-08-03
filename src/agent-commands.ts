import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { renderAgentsPanel, type CodexAgentSnapshot } from './codex-agents.ts'

export type AgentCommand =
  | { action: 'snapshot', workflow?: string }
  | { action: 'clear', scope: 'finished' | 'all' }
  | { action: 'help' }

interface StoredWorkflow {
  channelId: string
  workflowId: string
  updatedAt: number
  agents: Record<string, CodexAgentSnapshot>
  hidden: string[]
}

interface StoredState {
  version: 1
  instanceId: string
  workflows: Record<string, StoredWorkflow>
}

export interface AgentClearResult {
  found: boolean
  cleared: number
  kept: number
  scope: 'finished' | 'all'
}

function workflowKey(channelId: string, workflowId: string): string {
  return JSON.stringify([channelId, workflowId])
}

function safeInstanceFilename(instanceId: string): string {
  const readable = instanceId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'gpt'
  const hash = crypto.createHash('sha256').update(instanceId).digest('hex').slice(0, 12)
  return `${readable}-${hash}.json`
}

function newestWorkflow(
  workflows: Record<string, StoredWorkflow>,
  channelId: string,
  selector?: string,
): StoredWorkflow | undefined {
  const candidates = Object.values(workflows).filter(workflow =>
    workflow.channelId === channelId
      && (!selector || workflow.workflowId === selector || workflow.workflowId.endsWith(selector)))
  return candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/**
 * Durable, per-bot-instance agent view state.
 *
 * Each instance writes a separate atomic JSON shard. That avoids cross-process
 * lost updates without a shared lock, and keeps gpt's registry completely
 * separate from Claude's agent-view state.
 */
export class GptAgentCommandStore {
  private readonly file: string
  private state: StoredState
  private writeSerial = 0

  constructor(
    directory: string,
    readonly instanceId: string,
  ) {
    this.file = path.join(directory, safeInstanceFilename(instanceId))
    this.state = this.load()
  }

  record(
    channelId: string,
    workflowId: string,
    agents: CodexAgentSnapshot[],
    updatedAt = Date.now(),
  ): void {
    if (!agents.length) return
    const key = workflowKey(channelId, workflowId)
    const workflow = this.state.workflows[key] ?? {
      channelId,
      workflowId,
      updatedAt,
      agents: {},
      hidden: [],
    }
    const hidden = new Set(workflow.hidden)
    for (const agent of agents) {
      if (!hidden.has(agent.id)) workflow.agents[agent.id] = { ...agent }
    }
    workflow.updatedAt = updatedAt
    this.state.workflows[key] = workflow
    this.flush()
  }

  snapshot(channelId: string, workflow?: string): CodexAgentSnapshot[] {
    const found = newestWorkflow(this.state.workflows, channelId, workflow)
    if (!found) return []
    return Object.values(found.agents).map(agent => ({ ...agent }))
  }

  clear(channelId: string, scope: 'finished' | 'all'): AgentClearResult {
    const workflow = newestWorkflow(this.state.workflows, channelId)
    const agents = workflow ? Object.values(workflow.agents) : []
    if (!workflow || !agents.length) return { found: false, cleared: 0, kept: 0, scope }

    const remove = scope === 'all'
      ? agents
      : agents.filter(agent => agent.status !== 'running')
    const removedIds = new Set(remove.map(agent => agent.id))
    workflow.hidden = [...new Set([...workflow.hidden, ...removedIds])]
    workflow.agents = Object.fromEntries(
      Object.entries(workflow.agents).filter(([id]) => !removedIds.has(id)),
    )
    workflow.updatedAt = Date.now()
    this.flush()
    return {
      found: true,
      cleared: remove.length,
      kept: Object.keys(workflow.agents).length,
      scope,
    }
  }

  private load(): StoredState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredState>
      if (parsed.version === 1 && parsed.instanceId === this.instanceId
          && parsed.workflows && typeof parsed.workflows === 'object') {
        return parsed as StoredState
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[agents] registry load failed:', error)
      }
    }
    return { version: 1, instanceId: this.instanceId, workflows: {} }
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${this.writeSerial++}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export function parseAgentCommand(content: string, botUserId = ''): AgentCommand | null {
  let body = content.trim()
  const mention = body.match(/^<@!?(\d+)>\s*/)
  if (mention) {
    if (!botUserId || mention[1] !== botUserId) return null
    body = body.slice(mention[0].length).trim()
  }
  const match = body.match(/^!(agents?|agent)(?:\s+(.*))?$/i)
  if (!match) return null
  const args = (match[2] ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = args[0]?.toLowerCase()
  if (!sub) return { action: 'snapshot' }
  if (sub === 'help') return { action: 'help' }
  if (sub === 'clear') {
    return { action: 'clear', scope: args[1]?.toLowerCase() === 'all' ? 'all' : 'finished' }
  }
  return { action: 'snapshot', workflow: args.join(' ') }
}

const AGENTS_HELP = `agents view — live Codex subagent panel

  !agents            snapshot of the current panel
  !agents clear      drop finished agents, keep any still running
  !agents clear all  drop everything, running rows included
  !agents help       this page

While subagents run, the panel rides the bottom of gpt's tool trace.
Each row shows status, task, model, elapsed time, and tokens.

  ○ / ◉   running
  ●       finished
  ✗       failed

\`clear\` is view-only: it never kills a running subagent. Registries are
isolated by gpt instance and Discord channel.`

export function runAgentCommand(
  store: GptAgentCommandStore,
  channelId: string,
  command: AgentCommand,
  now = Date.now(),
): string {
  if (command.action === 'help') return `\`\`\`\n${AGENTS_HELP}\n\`\`\``
  if (command.action === 'snapshot') {
    const panel = renderAgentsPanel(store.snapshot(channelId, command.workflow), now, 0, true)
    return panel || '```\nno agents running this session\n```'
  }

  const result = store.clear(channelId, command.scope)
  if (!result.found) return 'no agent panel to clear'
  if (command.scope === 'all') return `agent list cleared — ${result.cleared} dropped`
  if (result.kept) {
    return `cleared — ${result.cleared} finished dropped, ${result.kept} running kept`
  }
  return `agent list cleared — ${result.cleared} finished dropped`
}
