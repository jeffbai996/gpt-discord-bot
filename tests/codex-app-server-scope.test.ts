import assert from 'node:assert/strict'
import test from 'node:test'

import { appServerNotificationBelongsToTurn } from '../src/codex-chat.ts'

test('rejects final answers and completions from foreign app-server turns', () => {
  const activeThread = 'thread-active'
  const activeTurn = 'turn-active'

  assert.equal(appServerNotificationBelongsToTurn({
    method: 'item/completed',
    params: {
      threadId: 'thread-foreign',
      turnId: 'turn-foreign',
      item: { type: 'agentMessage', text: 'wrong task', phase: 'final_answer' },
    },
  }, activeThread, activeTurn), false)

  assert.equal(appServerNotificationBelongsToTurn({
    method: 'item/completed',
    params: {
      threadId: activeThread,
      turnId: 'turn-foreign',
      item: { type: 'agentMessage', text: 'wrong turn', phase: 'final_answer' },
    },
  }, activeThread, activeTurn), false)

  assert.equal(appServerNotificationBelongsToTurn({
    method: 'turn/completed',
    params: {
      threadId: 'thread-foreign',
      turn: { id: 'turn-foreign', status: 'completed' },
    },
  }, activeThread, activeTurn), false)
})

test('accepts only fully scoped notifications for the active app-server turn', () => {
  const activeThread = 'thread-active'
  const activeTurn = 'turn-active'

  for (const message of [
    {
      method: 'item/completed',
      params: {
        threadId: activeThread,
        turnId: activeTurn,
        item: { type: 'agentMessage', text: 'right task', phase: 'final_answer' },
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: activeThread,
        turn: { id: activeTurn, status: 'completed' },
      },
    },
  ]) {
    assert.equal(
      appServerNotificationBelongsToTurn(message, activeThread, activeTurn),
      true,
    )
  }

  assert.equal(appServerNotificationBelongsToTurn({
    method: 'item/completed',
    params: { item: { type: 'agentMessage', text: 'unscoped', phase: 'final_answer' } },
  }, activeThread, activeTurn), false)
})
