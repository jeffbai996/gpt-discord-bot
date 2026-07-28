import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PLAN_MODE_ACK, PlanModeStore } from '../src/plan-mode.ts'

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plan-'))
  return path.join(dir, 'plans.json')
}

test('plan mode acknowledgement stays on the approved exact copy', () => {
  assert.equal(
    PLAN_MODE_ACK,
    'Plan mode is armed and will apply on the next message.\n'
      + 'React ✅ to execute, ✏️ to revise, or ❌ to cancel.',
  )
})

test('plan mode arms exactly one next message from the requesting user', () => {
  const store = new PlanModeStore(tempFile())
  store.arm('channel-1', 'user-1')

  assert.equal(store.consumeArm('channel-1', 'user-2'), null)
  assert.equal(store.consumeArm('channel-1', 'user-1')?.kind, 'plan')
  assert.equal(store.consumeArm('channel-1', 'user-1'), null)
})

test('pending plan actions are requester-bound and single-use', () => {
  const store = new PlanModeStore(tempFile())
  store.registerPending({
    messageId: 'plan-message',
    channelId: 'channel-1',
    requesterId: 'user-1',
    sourceMessageId: 'source-message',
    planText: '1. inspect\n2. patch',
    createdAt: Date.now(),
  })

  assert.equal(store.takeAction('plan-message', 'user-2', 'execute').status, 'forbidden')
  const picked = store.takeAction('plan-message', 'user-1', 'execute')
  assert.equal(picked.status, 'accepted')
  assert.equal(picked.plan?.sourceMessageId, 'source-message')
  assert.equal(store.takeAction('plan-message', 'user-1', 'execute').status, 'missing')
})

test('revision arms another read-only planning turn', () => {
  const store = new PlanModeStore(tempFile())
  store.registerPending({
    messageId: 'plan-message',
    channelId: 'channel-1',
    requesterId: 'user-1',
    sourceMessageId: 'source-message',
    planText: 'old plan',
    createdAt: Date.now(),
  })

  assert.equal(store.takeAction('plan-message', 'user-1', 'revise').status, 'accepted')
  const arm = store.consumeArm('channel-1', 'user-1')
  assert.equal(arm?.kind, 'revise')
  assert.equal(arm?.priorPlan, 'old plan')
})

test('plan state survives process restart', () => {
  const file = tempFile()
  new PlanModeStore(file).arm('channel-1', 'user-1')

  assert.equal(new PlanModeStore(file).consumeArm('channel-1', 'user-1')?.kind, 'plan')
})
