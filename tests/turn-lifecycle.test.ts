import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { logTurnLifecycle } from '../src/turn-lifecycle.ts'

test('structured lifecycle logs whitelist metadata and omit message content', () => {
  let line = ''
  const prior = console.error
  console.error = value => { line = String(value) }
  try {
    logTurnLifecycle({
      event: 'turn_registered',
      channelId: 'channel',
      generation: 7,
      queueDepth: 2,
      ...({ messageBody: 'private text' } as any),
    })
  } finally {
    console.error = prior
  }

  const record = JSON.parse(line)
  assert.equal(record.event, 'turn_registered')
  assert.equal(record.generation, 7)
  assert.equal(record.queueDepth, 2)
  assert.equal(record.messageBody, undefined)
  assert.doesNotMatch(line, /private text/)
})

test('partial output has no write access to the thought message', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf("if (event.type === 'partial')")
  const end = source.indexOf('\n    }', start)
  const branch = source.slice(start, end)
  assert.ok(start >= 0)
  assert.doesNotMatch(branch, /workMessage\.edit|queueLiveText|postPlaceholder/)
})
