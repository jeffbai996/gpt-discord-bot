import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PresenceOwner, isPresenceRequest } from '../src/presence-owner.ts'

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'presence-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sent: string[] = []
  const make = () => new PresenceOwner(dir, text => sent.push(text))
  return { sent, make, dir }
}

test('startup generates once; reconnect restores without regenerating', async t => {
  const { make, sent } = fixture(t), owner = make()
  let calls = 0
  const generate = async () => { calls++; return 'a fresh thought' }
  await Promise.all([owner.start('voice', generate), owner.start('voice', generate)])
  owner.restore()
  assert.equal(calls, 1)
  assert.deepEqual(sent, ['a fresh thought', 'a fresh thought'])
})

test('a new process avoids previous startup statuses', async t => {
  const { make, sent } = fixture(t)
  await make().start('voice', async () => 'old thought')
  const next = make()
  let calls = 0
  await next.start('voice', async prompt => {
    assert.match(prompt, /old thought/)
    return ++calls === 1 ? 'old thought' : 'different thought'
  })
  assert.deepEqual(sent, ['old thought', 'different thought'])
})

test('ordinary channel replies cannot change account status', async t => {
  const { make, sent } = fixture(t), owner = make()
  await owner.start('voice', async () => 'startup thought')
  assert.equal(owner.update(owner.request('fix the menu'), 'uninvited thought'), false)
  assert.deepEqual(sent, ['startup thought'])
})

test('newest explicit request wins across out-of-order channel completions', t => {
  const { make, sent } = fixture(t), owner = make()
  const earlier = owner.request('change your status to cooking')
  const later = owner.request('set your Discord status to testing')
  assert.equal(owner.update(later, 'testing'), true)
  assert.equal(owner.update(earlier, 'cooking'), false)
  assert.deepEqual(sent, ['testing'])
})

test('late startup generation cannot overwrite an explicit request', async t => {
  const { make, sent } = fixture(t), owner = make()
  let finish!: (text: string) => void
  const boot = owner.start('voice', () => new Promise(resolve => { finish = resolve }))
  owner.update(owner.request('set your status to busy'), 'busy')
  finish('too late')
  await boot
  assert.deepEqual(sent, ['busy'])
})

test('a replaced process cannot update or restore the same identity', async t => {
  const { make, sent } = fixture(t), old = make()
  const ticket = old.request('change your status')
  await make().start('voice', async () => 'new process')
  assert.equal(old.update(ticket, 'old process'), false)
  old.restore()
  assert.deepEqual(sent, ['new process'])
})

test('generation failure and repeated output are bounded', async t => {
  const { make } = fixture(t)
  await make().start('voice', async () => 'same thought')
  let count = 0
  await assert.rejects(make().start('voice', async () => { count++; return 'same thought' }))
  assert.equal(count, 3)
})

test('status requests exclude unrelated software status questions', () => {
  assert.equal(isPresenceRequest('what is the deployment status?'), false)
  assert.equal(isPresenceRequest('the status dropdown needs fixing'), false)
  assert.equal(isPresenceRequest('change your Discord status to hello'), true)
  assert.equal(isPresenceRequest('换个状态'), true)
})


test('legacy status is excluded from the first upgraded startup', async t => {
  const { make, dir } = fixture(t)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ presence: 'legacy thought' }))
  await make().start('voice', async prompt => {
    assert.match(prompt, /legacy thought/)
    return 'fresh upgraded thought'
  })
})

test('negative status instructions do not grant a status update', () => {
  assert.equal(isPresenceRequest("don't change your status"), false)
  assert.equal(isPresenceRequest('do not reset your Discord status'), false)
})
