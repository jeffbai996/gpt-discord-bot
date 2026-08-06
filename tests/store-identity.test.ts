// gpt names itself when it writes to the shared store.
//
// The store CLI reads the writer's identity out of the environment:
// CLAUDE_CONFIG_DIR for a Claude-based bot, otherwise SQUAD_STORE_BOT. codex
// has neither, so a to-do filed through the shell was recorded against the
// box's default identity. That bot was not in the channel the card landed in,
// so tapping the card's proceed button relayed to nobody and left a raw
// marker in the message (2026-08-05).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { codexSpawnEnv, SQUAD_STORE_IDENTITY } from '../src/codex-chat.ts'

test('every codex spawn carries an identity for the store', () => {
  assert.equal(codexSpawnEnv().SQUAD_STORE_BOT, SQUAD_STORE_IDENTITY)
  assert.equal(SQUAD_STORE_IDENTITY, process.env.SQUAD_STORE_BOT || 'gpt')
})

test('the identity does not depend on a systemd drop-in existing', () => {
  // A drop-in is host state — a rebuilt box or a DR restore drops it. The
  // repo default is what makes attribution survive that.
  assert.notEqual(SQUAD_STORE_IDENTITY, '')
  assert.notEqual(SQUAD_STORE_IDENTITY, undefined)
})

test('an explicit override still wins over the identity', () => {
  const env = codexSpawnEnv({ SQUAD_STORE_BOT: 'somebody-else' })
  assert.equal(env.SQUAD_STORE_BOT, 'somebody-else')
})

test('adding the identity did not undo the secret stripping', () => {
  process.env.DISCORD_BOT_TOKEN = 'should-not-leak'
  try {
    const env = codexSpawnEnv()
    assert.equal(env.DISCORD_BOT_TOKEN, undefined)
    assert.equal(env.GEMINI_API_KEY, undefined)
  } finally {
    delete process.env.DISCORD_BOT_TOKEN
  }
})
