import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { AccessManager } from '../src/access.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-access-'))
  process.env.GPT_STATE_DIR = tmpDir
})

test('access: canHandle requires user allowlist + channel enabled', async () => {
  const a = new AccessManager()
  await a.load()

  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), false)

  await a.allowUser('u1')
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), false, 'channel still disabled')

  await a.setChannel('c1', true, false)
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), true)
})

test('access: requireMention=true gates non-mentions', async () => {
  const a = new AccessManager()
  await a.load()
  await a.allowUser('u1')
  await a.setChannel('c1', true, true)

  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), false)
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: true }), true)
})

test('access: setChannelFlags preserves enabled/requireMention', async () => {
  const a = new AccessManager()
  await a.load()
  await a.allowUser('u1')
  await a.setChannel('c1', true, true)
  await a.setChannelFlags('c1', { codexModel: 'gpt-5.4', reasoning: 'high' })

  const flags = a.channelFlags('c1')
  assert.equal(flags.codexModel, 'gpt-5.4')
  assert.equal(flags.reasoning, 'high')
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: true }), true)
})

// NOTE: the per-channel API `model` override was removed 2026-06-29 (orphaned —
// no slash setter; API model is env-driven via DEFAULT_MODEL, like gemma). The
// old 'model=null clears override' test went with it.
