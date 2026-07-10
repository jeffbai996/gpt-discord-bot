import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSupervisedProcess } from '../src/process-supervisor.ts'

test('supervisor observes a fast child exit without missing the close event', async () => {
  const proc = spawnSupervisedProcess(process.execPath, ['-e', 'process.exit(0)'], {}, {
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000,
    heartbeatMs: 50,
    killGraceMs: 100,
  })
  const result = await proc.wait()
  assert.equal(result.stopReason, null)
  assert.equal(result.code, 0)
})

test('supervisor kills a silent child at the meaningful-idle deadline', async () => {
  const proc = spawnSupervisedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, {
    idleTimeoutMs: 40,
    hardTimeoutMs: 1_000,
    heartbeatMs: 10,
    killGraceMs: 100,
  })
  const result = await proc.wait()
  assert.equal(result.stopReason, 'idle')
})

test('supervisor hard deadline wins even when activity keeps arriving', async () => {
  const proc = spawnSupervisedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, {
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 60,
    heartbeatMs: 10,
    killGraceMs: 100,
  })
  const activity = setInterval(() => proc.markActivity(), 5)
  const result = await proc.wait()
  clearInterval(activity)
  assert.equal(result.stopReason, 'hard')
})

test('supervisor emits visible heartbeats while the child is silent', async () => {
  const beats: Array<{ elapsedMs: number; idleMs: number }> = []
  const proc = spawnSupervisedProcess(process.execPath, ['-e', 'setTimeout(() => {}, 80)'], {}, {
    idleTimeoutMs: 500,
    hardTimeoutMs: 1_000,
    heartbeatMs: 15,
    killGraceMs: 100,
  }, {
    onHeartbeat: beat => beats.push(beat),
  })
  await proc.wait()
  assert.ok(beats.length >= 2, `expected >=2 heartbeats, got ${beats.length}`)
  assert.ok(beats.at(-1)!.elapsedMs >= beats[0].elapsedMs)
  assert.ok(beats.at(-1)!.idleMs >= beats[0].idleMs)
})

test('a broken heartbeat renderer cannot crash process supervision', async () => {
  const proc = spawnSupervisedProcess(process.execPath, ['-e', 'setTimeout(() => {}, 45)'], {}, {
    idleTimeoutMs: 500,
    hardTimeoutMs: 1_000,
    heartbeatMs: 10,
    killGraceMs: 100,
  }, {
    onHeartbeat: () => { throw new Error('Discord edit exploded') },
  })
  const result = await proc.wait()
  assert.equal(result.stopReason, null)
  assert.equal(result.code, 0)
})

test('supervisor force-settles even if the kill hook fails', async () => {
  const proc = spawnSupervisedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, {
    idleTimeoutMs: 30,
    hardTimeoutMs: 1_000,
    heartbeatMs: 10,
    killGraceMs: 30,
  }, {
    kill: () => {},
  })
  const result = await proc.wait()
  assert.equal(result.stopReason, 'idle')
  assert.equal(result.forced, true)
  proc.child.kill('SIGKILL')
})

test('supervisor reports spawn errors instead of hanging', async () => {
  const proc = spawnSupervisedProcess('/definitely/missing/codex', [], {}, {
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000,
    heartbeatMs: 50,
    killGraceMs: 100,
  })
  const result = await proc.wait()
  assert.ok(result.error)
  assert.match(result.error!.message, /ENOENT/)
})
