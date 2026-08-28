import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

process.env.GPT_CODEX_BIN = fileURLToPath(
  new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
)
process.env.GPT_CODEX_ROLLOUT_POLL_MS = '60000'

const { respondViaCodex } = await import('../src/codex-chat.ts')

test('foreign app-server completion cannot settle or replace the active Discord turn', async () => {
  const resultPromise = respondViaCodex({
    systemPrompt: 'Test system prompt.',
    history: [],
    userMessage: 'Return the active result.',
    userName: 'alice',
    readOnly: true,
  })

  const settledAfterForeignCompletion = await Promise.race([
    resultPromise.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 100)),
  ])

  assert.equal(settledAfterForeignCompletion, false)
  const result = await resultPromise
  assert.equal(result.reply, 'ACTIVE RESULT')
  assert.equal(result.threadId, 'thread-active')
})
