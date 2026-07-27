import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type PlanAction = 'execute' | 'revise' | 'cancel'

export interface PlanArm {
  kind: 'plan' | 'revise'
  userId: string
  armedAt: number
  priorPlan?: string
}

export interface PendingPlan {
  messageId: string
  channelId: string
  requesterId: string
  sourceMessageId: string
  planText: string
  createdAt: number
}

interface PersistedState {
  armed: Record<string, PlanArm>
  pending: Record<string, PendingPlan>
}

export type PlanActionResult =
  | { status: 'accepted'; plan: PendingPlan }
  | { status: 'forbidden' | 'missing' | 'expired' }

const DEFAULT_TTL_MS = Number(process.env.GPT_PLAN_TTL_MS) || 12 * 60 * 60_000
const DEFAULT_FILE = path.join(
  process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord'),
  'plan-mode.json',
)

export class PlanModeStore {
  private state: PersistedState = { armed: {}, pending: {} }

  constructor(
    private readonly file = DEFAULT_FILE,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    this.load()
  }

  arm(channelId: string, userId: string): void {
    this.state.armed[channelId] = { kind: 'plan', userId, armedAt: Date.now() }
    this.save()
  }

  consumeArm(channelId: string, userId: string): PlanArm | null {
    const arm = this.state.armed[channelId]
    if (!arm || arm.userId !== userId) return null
    delete this.state.armed[channelId]
    this.save()
    if (Date.now() - arm.armedAt > this.ttlMs) return null
    return arm
  }

  registerPending(plan: PendingPlan): void {
    this.prune()
    this.state.pending[plan.messageId] = plan
    this.save()
  }

  takeAction(messageId: string, userId: string, action: PlanAction): PlanActionResult {
    const plan = this.state.pending[messageId]
    if (!plan) return { status: 'missing' }
    if (plan.requesterId !== userId) return { status: 'forbidden' }
    delete this.state.pending[messageId]
    if (Date.now() - plan.createdAt > this.ttlMs) {
      this.save()
      return { status: 'expired' }
    }
    if (action === 'revise') {
      this.state.armed[plan.channelId] = {
        kind: 'revise',
        userId,
        armedAt: Date.now(),
        priorPlan: plan.planText,
      }
    }
    this.save()
    return { status: 'accepted', plan }
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs
    for (const [id, plan] of Object.entries(this.state.pending)) {
      if (plan.createdAt < cutoff) delete this.state.pending[id]
    }
    for (const [channelId, arm] of Object.entries(this.state.armed)) {
      if (arm.armedAt < cutoff) delete this.state.armed[channelId]
    }
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedState>
      this.state = {
        armed: parsed.armed && typeof parsed.armed === 'object' ? parsed.armed : {},
        pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
      }
      this.prune()
    } catch {
      this.state = { armed: {}, pending: {} }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    fs.renameSync(tmp, this.file)
  }
}

export const PLAN_ONLY_INSTRUCTION = [
  'PLAN MODE: inspect and reason, but do not modify files, run mutating commands,',
  'change services, commit, push, send messages, or perform external writes.',
  'Return a concrete implementation plan for approval. End after the plan.',
].join(' ')

export function revisionInstruction(priorPlan: string): string {
  return `${PLAN_ONLY_INSTRUCTION}\n\nThe user is revising this prior plan:\n${priorPlan}`
}

export function executePlanInstruction(plan: string): string {
  return [
    'The user approved the plan below. Execute it now through implementation,',
    'verification, deployment/reload, commit, and push where applicable.',
    'Do not stop at another plan or ask for redundant approval.',
    '',
    plan,
  ].join('\n')
}
