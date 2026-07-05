import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeTurns, BARGE_GRACE_MS } from '../src/active-turns.ts'

// The barge guard (Jeff 2026-07-01): a new in-flight message may cut off the running
// turn only when canBarge() is true — past the grace window AND not mid a destructive
// tool call. These exercise the guard on the shared singleton using a unique channel
// id per test so per-channel state stays isolated. `canBarge(cid, now)` takes an
// explicit `now` so we can simulate turn age without sleeping.

let n = 0
const cid = () => `barge-test-${n++}`

test('canBarge: false when no turn is active', () => {
  const c = cid()
  assert.equal(activeTurns.canBarge(c), false)
})

test('canBarge: false inside the grace window, true after it', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  // register() stamps startedAt = Date.now(); assert the boundary by passing an
  // explicit `now` relative to that start — within grace vs past grace.
  const started = Date.now()
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS - 1), false, 'just under grace')
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS), true, 'at grace boundary')
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS + 5000), true, 'well past grace')
  activeTurns.done(c)
})

test('canBarge: false while mid a destructive tool call, even past grace', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  const started = Date.now()
  activeTurns.setBusy(c, 'shell')
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS + 10_000), false, 'mid-shell blocks barge')
  assert.equal(activeTurns.canRequestBarge(c, started + BARGE_GRACE_MS + 10_000), true, 'mid-shell can request deferred barge')
  activeTurns.setBusy(c, 'edit')
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS + 10_000), false, 'mid-edit blocks barge')
  assert.equal(activeTurns.canRequestBarge(c, started + BARGE_GRACE_MS + 10_000), true, 'mid-edit can request deferred barge')
  activeTurns.clearBusy(c)
  assert.equal(activeTurns.canBarge(c, started + BARGE_GRACE_MS + 10_000), true, 'clears after tool done')
  activeTurns.done(c)
})

test('stopFor(clearQueue:false) kills without marking stopped; stop() marks stopped', () => {
  const c1 = cid()
  let killed1 = false
  activeTurns.register(c1, () => { killed1 = true })
  assert.equal(activeTurns.stopFor(c1, { clearQueue: false }), true, 'a running turn was killed')
  assert.equal(killed1, true, 'killer fired')
  assert.equal(activeTurns.consumeStopped(c1), false, 'barge does NOT set the stopped flag (queue survives)')

  const c2 = cid()
  activeTurns.register(c2, () => {})
  assert.equal(activeTurns.stop(c2), true)
  assert.equal(activeTurns.consumeStopped(c2), true, 'a user stop DOES set the stopped flag (queue cleared)')
})

test('stopFor: false when no turn is running', () => {
  const c = cid()
  assert.equal(activeTurns.stopFor(c, { clearQueue: false }), false)
})

test('deferStopFor: records a pending barge without killing until boundary', () => {
  const c = cid()
  let killed = false
  activeTurns.register(c, () => { killed = true })
  assert.equal(activeTurns.deferStopFor(c, { clearQueue: false }), true, 'deferred stop was recorded')
  assert.equal(killed, false, 'deferred stop does not kill immediately')
  assert.equal(activeTurns.isActive(c), true, 'turn remains active until boundary')
  assert.equal(activeTurns.stopIfPending(c), true, 'boundary consumes pending stop')
  assert.equal(killed, true, 'killer fired at boundary')
  assert.equal(activeTurns.isActive(c), false, 'turn is no longer active after boundary stop')
  assert.equal(activeTurns.consumeStopped(c), false, 'barge does not clear queued follow-ups')
})

test('deferStopFor(clearQueue:true): pending user stop clears queue at boundary', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  assert.equal(activeTurns.deferStopFor(c, { clearQueue: true }), true)
  assert.equal(activeTurns.consumeStopped(c), false, 'not stopped until boundary')
  assert.equal(activeTurns.stopIfPending(c), true)
  assert.equal(activeTurns.consumeStopped(c), true, 'clearQueue propagates when pending stop fires')
})

test('deferStopFor and stopIfPending: false when no turn is running or pending', () => {
  const c = cid()
  assert.equal(activeTurns.deferStopFor(c, { clearQueue: false }), false)
  assert.equal(activeTurns.stopIfPending(c), false)
})

test('done() clears liveness so a finished turn can never be barged', () => {
  const c = cid()
  activeTurns.register(c, () => {})
  activeTurns.deferStopFor(c, { clearQueue: false })
  activeTurns.done(c)
  assert.equal(activeTurns.canBarge(c, Date.now() + 999_999), false)
  assert.equal(activeTurns.stopIfPending(c), false)
})

test('waitForIdle: resolves only after the last active turn ends', async () => {
  const c1 = cid()
  const c2 = cid()
  activeTurns.register(c1, () => {})
  activeTurns.register(c2, () => {})
  let resolved = false
  const p = activeTurns.waitForIdle().then(() => { resolved = true })
  activeTurns.done(c1)
  await Promise.resolve()
  assert.equal(resolved, false)
  activeTurns.done(c2)
  await p
  assert.equal(resolved, true)
})

test('waitForIdle: resolves immediately when already idle', async () => {
  await activeTurns.waitForIdle()
})
