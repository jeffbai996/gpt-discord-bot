import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FailedTurnStore, formatFailureDiagnostic } from '../src/failed-turn-store.ts'

const tmp = path.join(os.tmpdir(), `gpt-failed-turn-store-${process.pid}`)
const file = path.join(tmp, 'failed-turns.json')

test('button and emoji share a durable single-use retry claim; a new failure rearms it', () => {
  const store = new FailedTurnStore(file)
  const turn = { channelId: 'channel-a', sourceMessageId: 'source', diagnostic: 'failed' }
  store.set('receipt', turn)
  assert.ok(store.claim('receipt'))
  assert.equal(store.claim('receipt'), undefined)
  assert.equal(new FailedTurnStore(file).claim('receipt'), undefined)
  store.set('receipt', turn)
  assert.ok(store.claim('receipt'))
})

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('failed turns survive process restart with source and diagnostic intact', () => {
  const store = new FailedTurnStore(file)
  store.set('error-message', {
    channelId: 'channel-a',
    sourceMessageId: 'source-message',
    diagnostic: 'Error: upstream exploded\n    at run (src/gpt.ts:1:1)',
  })

  const nextBoot = new FailedTurnStore(file)
  assert.deepEqual(nextBoot.get('error-message'), {
    channelId: 'channel-a',
    sourceMessageId: 'source-message',
    diagnostic: 'Error: upstream exploded\n    at run (src/gpt.ts:1:1)',
  })
})

test('failure diagnostic is fenced safely and bounded for an ephemeral reply', () => {
  const diagnostic = `Error: bad \`\`\` payload\n${'x'.repeat(3_000)}`
  const rendered = formatFailureDiagnostic(diagnostic)

  assert.match(rendered, /^Failure diagnostic \(private\):\n```text\n/)
  assert.ok(rendered.endsWith('\n```'))
  assert.ok(!rendered.slice('Failure diagnostic (private):\n```text\n'.length, -4).includes('```'))
  assert.ok(rendered.length <= 2_000)
})
