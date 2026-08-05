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
  await a.setChannelFlags('c1', { codexModel: 'gpt-5.6-terra', reasoning: 'high' })

  const flags = a.channelFlags('c1')
  assert.equal(flags.codexModel, 'gpt-5.6-terra')
  assert.equal(flags.reasoning, 'high')
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: true }), true)
})

test('access: unconfigured channels default to live thinking and collapsing trace', async () => {
  const a = new AccessManager()
  await a.load()

  const flags = a.channelFlags('unconfigured')
  assert.equal(flags.thinking, 'live')
  assert.equal(flags.trace, 'collapse')
})

test('access: live is a valid rolling trace mode', async () => {
  const a = new AccessManager()
  await a.load()
  await a.setChannel('c1', true, false)
  await a.setChannelFlags('c1', { trace: 'live' })

  await a.load()
  assert.equal(a.channelFlags('c1').trace, 'live')
})

test('access: max is a valid reasoning effort', async () => {
  const a = new AccessManager()
  await a.load()
  await a.setChannel('c1', true, false)
  await a.setChannelFlags('c1', { reasoning: 'max' })
  assert.equal(a.channelFlags('c1').reasoning, 'max')
})

test('access: retired saved codexModel normalizes to current default', async () => {
  const a = new AccessManager()
  await a.load()
  await a.setChannel('c1', true, false)

  const file = path.join(tmpDir, 'access.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.channels.c1.codexModel = 'retired-model'
  await fs.writeFile(file, JSON.stringify(raw, null, 2))

  await a.load()
  const flags = a.channelFlags('c1')
  assert.equal(flags.codexModel, 'gpt-5.6-sol')
})

test('access: migrates the old thinking collapse mode to live once', async () => {
  const file = path.join(tmpDir, 'access.json')
  await fs.writeFile(file, JSON.stringify({
    users: {},
    channels: {
      c1: { enabled: true, requireMention: false, thinking: 'collapse', trace: 'collapse' },
    },
  }, null, 2))

  const a = new AccessManager()
  await a.load()

  assert.equal(a.channelFlags('c1').thinking, 'live')
  assert.equal(a.channelFlags('c1').trace, 'collapse')
  const migrated = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(migrated.version, 2)
  assert.equal(migrated.channels.c1.thinking, 'live')
})

test('access: preserves new thinking collapse mode after migration', async () => {
  const a = new AccessManager()
  await a.load()
  await a.setChannel('c1', true, false)
  await a.setChannelFlags('c1', { thinking: 'collapse' })

  await a.load()
  assert.equal(a.channelFlags('c1').thinking, 'collapse')
})

test('access: thread inherits parent policy and flags until explicitly overridden', async () => {
  const a = new AccessManager()
  await a.load()
  await a.allowUser('u1')
  await a.setChannel('parent', true, false, { reasoning: 'max', trace: 'live' })

  assert.equal(a.canHandle({ channelId: 'thread', parentChannelId: 'parent', userId: 'u1', isMention: false }), true)
  assert.equal(a.canReact('u1', 'thread', 'parent'), true)
  assert.equal(a.channelFlags('thread').reasoning, 'max')
  assert.equal(a.channelFlags('thread').trace, 'live')
  const inheritedOverride = await a.setChannelFlags('thread', { trace: 'off' })
  assert.equal(inheritedOverride.reasoning, 'max')
  assert.equal(inheritedOverride.trace, 'off')

  await a.setChannel('thread', true, true, { reasoning: 'low', trace: 'off' })
  assert.equal(a.canHandle({ channelId: 'thread', parentChannelId: 'parent', userId: 'u1', isMention: false }), false)
  assert.equal(a.channelFlags('thread', 'parent').reasoning, 'low')
  assert.equal(a.channelFlags('thread', 'parent').trace, 'off')
})

// NOTE: the per-channel API `model` override was removed 2026-06-29 (orphaned —
// no slash setter; API model is env-driven via DEFAULT_MODEL, like gemma). The
// old 'model=null clears override' test went with it.
