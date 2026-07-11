import assert from 'node:assert/strict'
import test from 'node:test'

import { ChannelTurnRunner } from '../src/channel-turns.ts'
import { RestartCoordinator } from '../src/restart.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

test('queues repeated steering FIFO and batches it after the active turn', async () => {
  const first = deferred()
  const seen: string[][] = []
  const runner = new ChannelTurnRunner<string>(async (_channelId, batch) => {
    seen.push(batch)
    if (batch[0] === 'A') await first.promise
  })

  const leader = runner.submit('channel', 'A')
  assert.equal(await runner.submit('channel', 'B'), 'queued')
  assert.equal(await runner.submit('channel', 'C'), 'queued')
  first.resolve()
  assert.equal(await leader, 'drained')
  assert.deepEqual(seen, [['A'], ['B', 'C']])
})

test('restart waits for runner cleanup and queued batches, without API fallback', async () => {
  const codex = deferred()
  const cleanup = deferred()
  let apiCalls = 0
  let launches = 0
  const runner = new ChannelTurnRunner<string>(async (_channelId, batch) => {
    if (batch[0] === 'A') await codex.promise
    await cleanup.promise
  })
  const restart = new RestartCoordinator(
    () => runner.waitForIdle(),
    () => { launches++ },
  )

  const leader = runner.submit('channel', 'A')
  await runner.submit('channel', 'B')
  restart.request()
  codex.resolve()
  await Promise.resolve()
  assert.equal(launches, 0, 'Discord cleanup is still active')
  assert.equal(apiCalls, 0)
  cleanup.resolve()
  await leader
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(launches, 1)
  assert.equal(apiCalls, 0)
})

test('a failed batch drops queued work and releases idle waiters', async () => {
  const gate = deferred()
  const runner = new ChannelTurnRunner<string>(async (_channelId, batch) => {
    if (batch[0] === 'A') {
      await gate.promise
      throw new Error('fake codex failure')
    }
  })

  const leader = runner.submit('channel', 'A')
  assert.equal(await runner.submit('channel', 'B'), 'queued')
  const idle = runner.waitForIdle()
  gate.resolve()
  await assert.rejects(leader, /fake codex failure/)
  await idle
  assert.equal(runner.isIdle(), true)
  assert.equal(runner.queueDepth('channel'), 0)
})
