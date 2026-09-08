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

test('notifies the Discord handoff only after the transport accepts the steer', async () => {
  const inbox = new SteeringInbox()
  const events: string[] = []
  inbox.attach(async () => { events.push('accepted'); return true })

  assert.equal(await inbox.submit('cross over now', () => { events.push('consumed') }), true)
  assert.deepEqual(events, ['accepted', 'consumed'])
})

test('does not move the Discord reaction target when steering falls back', async () => {
  const inbox = new SteeringInbox()
  let consumed = false
  inbox.attach(async () => false)

  assert.equal(await inbox.submit('queue me instead', () => { consumed = true }), false)
  assert.equal(consumed, false)
})

test('bounds accepted and pre-attach steering for the lifetime of one turn', async () => {
  const inbox = new SteeringInbox(2)
  const first = inbox.submit('first')
  const second = inbox.submit('second')
  assert.equal(await inbox.submit('overflow'), false)

  inbox.attach(async () => true)
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(await inbox.submit('still full after acceptance'), false)
})

test('rejected steering releases its reserved slot for queue fallback retries', async () => {
  const inbox = new SteeringInbox(1)
  let deliveries = 0
  inbox.attach(async () => { deliveries += 1; return false })
  assert.equal(await inbox.submit('not accepted'), false)
  assert.equal(await inbox.submit('slot was released'), false)
  assert.equal(deliveries, 2)
})
