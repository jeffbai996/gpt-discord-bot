import assert from 'node:assert/strict'
import test from 'node:test'

import { settleWithin } from '../src/promise-deadline.ts'

test('settleWithin returns a fulfilled value before its deadline', async () => {
  const result = await settleWithin(Promise.resolve('done'), 100)

  assert.deepEqual(result, { status: 'fulfilled', value: 'done' })
})

test('settleWithin releases the caller when its dependency never settles', async () => {
  const startedAt = Date.now()
  const result = await settleWithin(new Promise<never>(() => {}), 10)

  assert.deepEqual(result, { status: 'timed-out' })
  assert.ok(Date.now() - startedAt < 250)
})
