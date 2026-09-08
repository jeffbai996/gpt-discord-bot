import assert from 'node:assert/strict'
import test from 'node:test'
import { handleReaction } from '../src/reactions/handler.ts'

test('registered failure reaction uses retry after authorization and never generic regeneration', async () => {
  let retries = 0
  const message = { author: { id: 'bot' }, channelId: 'channel', channel: {},
    fetchReference: async () => { throw new Error('must not use reply reference') } }
  const reaction = { message, emoji: { name: '🔁' } } as any
  const deps = { client: { user: { id: 'bot' } }, access: { canReact: () => true },
    buildContext: () => ({ message }), retryFailure: async () => { retries++; return true } } as any
  await handleReaction(reaction, { id: 'alice', bot: false } as any, deps)
  assert.equal(retries, 1)
  deps.access.canReact = () => false
  await handleReaction(reaction, { id: 'alice', bot: false } as any, deps)
  assert.equal(retries, 1)
  deps.access.canReact = () => true
  await handleReaction(reaction, { id: 'bot', bot: true } as any, deps)
  assert.equal(retries, 1)
  message.author.id = 'other-bot'
  await handleReaction(reaction, { id: 'alice', bot: false } as any, deps)
  assert.equal(retries, 1)
})
