import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  GlobalTurnAdmission,
  TurnAdmissionCancelledError,
} from '../src/global-turn-admission.ts'
import { readSelfCgroupMemoryBytes } from '../src/cgroup-memory.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('runs at most two turns and admits waiting channels FIFO', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const started: string[] = []
  const queued: Array<[string, number]> = []
  const admission = new GlobalTurnAdmission({ maxActive: 2 })

  const runs = ['one', 'two', 'three'].map((channelId, index) => admission.run(
    channelId,
    async () => {
      started.push(channelId)
      await gates[index].promise
      return channelId
    },
    { onQueued: position => { queued.push([channelId, position]) } },
  ))

  await tick()
  assert.deepEqual(started, ['one', 'two'])
  assert.deepEqual(queued, [['three', 1]])
  assert.deepEqual(admission.snapshot(), {
    running: 2,
    queued: 1,
    oldestWaitMs: admission.snapshot().oldestWaitMs,
    pausedForMemory: false,
  })

  gates[0].resolve()
  await tick()
  assert.deepEqual(started, ['one', 'two', 'three'])
  gates[1].resolve()
  gates[2].resolve()
  assert.deepEqual(await Promise.all(runs), ['one', 'two', 'three'])
  assert.equal(admission.isIdle(), true)
})

test('cancels queued work without disturbing a running channel', async () => {
  const gate = deferred()
  const admission = new GlobalTurnAdmission({ maxActive: 1 })
  const running = admission.run('one', async () => { await gate.promise })
  const queued = admission.run('two', async () => { throw new Error('must not start') })

  await tick()
  assert.equal(admission.cancel('two'), 1)
  await assert.rejects(queued, TurnAdmissionCancelledError)
  assert.deepEqual(admission.snapshot(), {
    running: 1,
    queued: 0,
    oldestWaitMs: 0,
    pausedForMemory: false,
  })
  gate.resolve()
  await running
})

test('cancellation waits for an in-flight queue receipt before cleaning it up', async () => {
  const gate = deferred()
  const receiptGate = deferred()
  const events: string[] = []
  const admission = new GlobalTurnAdmission({ maxActive: 1 })
  const running = admission.run('one', async () => { await gate.promise })
  const queued = admission.run('two', async () => {}, {
    onQueued: async () => {
      await receiptGate.promise
      events.push('receipt created')
    },
    onCancelled: () => { events.push('receipt deleted') },
  })
  await tick()
  assert.equal(admission.cancel('two'), 1)
  await assert.rejects(queued, TurnAdmissionCancelledError)
  receiptGate.resolve()
  await tick()
  assert.deepEqual(events, ['receipt created', 'receipt deleted'])
  gate.resolve()
  await running
})

test('memory hysteresis pauses new dispatch until usage crosses the low-water mark', async () => {
  let memoryBytes = 900
  const admission = new GlobalTurnAdmission({
    maxActive: 2,
    highWaterBytes: 800,
    lowWaterBytes: 600,
    memoryBytes: () => memoryBytes,
    pollMs: 5,
  })
  let started = false
  const run = admission.run('one', async () => { started = true })

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(started, false)
  assert.equal(admission.snapshot().pausedForMemory, true)

  memoryBytes = 700
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(started, false, 'between thresholds remains paused')

  memoryBytes = 500
  await run
  assert.equal(started, true)
  assert.equal(admission.snapshot().pausedForMemory, false)
})

test('reports queue wait age for stats and doctor telemetry', async () => {
  let now = 1_000
  const gate = deferred()
  const admission = new GlobalTurnAdmission({ maxActive: 1, now: () => now })
  const first = admission.run('one', async () => { await gate.promise })
  const second = admission.run('two', async () => {})
  await tick()

  now = 4_250
  assert.equal(admission.snapshot().oldestWaitMs, 3_250)
  gate.resolve()
  await Promise.all([first, second])
})

test('reads descendant-inclusive memory from the current cgroup path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-cgroup-'))
  const procFile = path.join(root, 'cgroup')
  const cgroupRoot = path.join(root, 'sys')
  fs.mkdirSync(path.join(cgroupRoot, 'app.slice', 'gpt.service'), { recursive: true })
  fs.writeFileSync(procFile, '0::/app.slice/gpt.service\n')
  fs.writeFileSync(path.join(cgroupRoot, 'app.slice', 'gpt.service', 'memory.current'), '123456\n')
  assert.equal(readSelfCgroupMemoryBytes(procFile, cgroupRoot), 123456)
})
