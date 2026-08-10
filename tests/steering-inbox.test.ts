import assert from 'node:assert/strict'
import test from 'node:test'

import { SteeringInbox } from '../src/steering-inbox.ts'

test('accepts early steering and delivers it when the active transport attaches', async () => {
  const inbox = new SteeringInbox()
  const accepted = inbox.submit('do this while you are there')
  const seen: string[] = []
  inbox.attach(async text => { seen.push(text); return true })
  assert.equal(await accepted, true)
  assert.deepEqual(seen, ['do this while you are there'])
})
test('returns false so the caller can fall back to a follow-up turn', async () => {
  const inbox = new SteeringInbox()
  inbox.attach(async () => false)
  assert.equal(await inbox.submit('cannot steer this turn'), false)
})
