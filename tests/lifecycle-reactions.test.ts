import assert from 'node:assert/strict'
import test from 'node:test'

import { applyLifecycle, type LifecycleState } from '../src/reactions/lifecycle.ts'
import { TurnLifecycleTracker } from '../src/reactions/turn-lifecycle.ts'

type FakeMessage = {
  id: string
  client: { user: { id: string } }
  reactions: { cache: Map<string, any> }
  react(emoji: string): Promise<void>
  fetch(): Promise<void>
}

function fakeMessage(id: string, initial: string[] = []) {
  const removed: string[] = []
  const reacted: string[] = []
  const cache = new Map<string, any>()
  const add = (emoji: string) => cache.set(emoji, {
    users: { remove: async () => { removed.push(emoji); cache.delete(emoji) } },
  })
  for (const emoji of initial) add(emoji)
  const message: FakeMessage = {
    id,
    client: { user: { id: 'bot' } },
    reactions: { cache },
    react: async emoji => { reacted.push(emoji); add(emoji) },
    fetch: async () => {},
  }
  return { message, removed, reacted, cache }
}

test('tooling evicts thinking so active phases cannot stack', async () => {
  const f = fakeMessage('one', ['🤔'])
  await applyLifecycle(f.message as any, 'tooling')

  assert.deepEqual(f.removed, ['🤔'])
  assert.deepEqual(f.reacted, ['🔧'])
  assert.equal(f.cache.has('🤔'), false)
  assert.equal(f.cache.has('🔧'), true)
})

test('thinking after a tool evicts the tool reaction', async () => {
  const f = fakeMessage('one', ['🔧'])
  await applyLifecycle(f.message as any, 'thinking')

  assert.deepEqual(f.removed, ['🔧'])
  assert.deepEqual(f.reacted, ['🤔'])
})

test('a consumed steer clears the prior message and inherits the current phase', async () => {
  const first = fakeMessage('first')
  const steer = fakeMessage('steer')
  const calls: Array<[string, LifecycleState]> = []
  const tracker = new TurnLifecycleTracker(first.message as any, async (message, state) => {
    calls.push([(message as any).id, state])
  })

  await tracker.transition('thinking')
  await tracker.moveTo(steer.message as any)

  assert.deepEqual(calls, [
    ['first', 'thinking'],
    ['first', 'silenced'],
    ['steer', 'thinking'],
  ])
})

test('rapid steering moves the phase forward instead of editing a stale message', async () => {
  const first = fakeMessage('first')
  const second = fakeMessage('second')
  const third = fakeMessage('third')
  const calls: Array<[string, LifecycleState]> = []
  const tracker = new TurnLifecycleTracker(first.message as any, async (message, state) => {
    calls.push([(message as any).id, state])
  })

  await tracker.transition('thinking')
  await Promise.all([
    tracker.moveTo(second.message as any),
    tracker.moveTo(third.message as any),
  ])
  await tracker.toolStarted()

  assert.deepEqual(calls.slice(-5), [
    ['first', 'silenced'],
    ['second', 'thinking'],
    ['second', 'silenced'],
    ['third', 'thinking'],
    ['third', 'tooling'],
  ])
})

test('tool completion returns the newest steering message to thinking', async () => {
  const first = fakeMessage('first')
  const steer = fakeMessage('steer')
  const calls: Array<[string, LifecycleState]> = []
  const tracker = new TurnLifecycleTracker(first.message as any, async (message, state) => {
    calls.push([(message as any).id, state])
  })

  await tracker.transition('thinking')
  await tracker.toolStarted()
  await tracker.moveTo(steer.message as any)
  await tracker.toolEnded()

  assert.deepEqual(calls.slice(-3), [
    ['first', 'silenced'],
    ['steer', 'tooling'],
    ['steer', 'thinking'],
  ])
})
