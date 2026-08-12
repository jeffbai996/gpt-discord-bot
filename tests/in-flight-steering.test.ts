import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SOURCE = new URL('../src/gpt.ts', import.meta.url)

test('ordinary in-flight messages queue without aborting the active Codex turn', async () => {
  const source = await readFile(SOURCE, 'utf8')
  const inbound = source.slice(
    source.indexOf('async function handleInboundMessage'),
    source.indexOf("client.on('messageCreate'"),
  )

  assert.doesNotMatch(inbound, /deferStopFor\(channelId/)
  assert.doesNotMatch(inbound, /stopFor\(channelId/)
  assert.match(inbound, /await runChannelTurn\(message, target(?:,[^)]*)?\)/)
})

test('ordinary steering has no queue or fast-forward reaction UI', async () => {
  const source = await readFile(SOURCE, 'utf8')

  assert.doesNotMatch(source, /LatestQueueMarker/)
  assert.doesNotMatch(source, /FAST_FORWARD_REACTION/)
  assert.doesNotMatch(source, /queueMarker\.(?:mark|clear)/)
})

test('native steering frames the message as additive same-turn guidance', async () => {
  const source = await readFile(SOURCE, 'utf8')
  const runner = source.slice(
    source.indexOf('async function runChannelTurn'),
    source.indexOf('async function dispatchInboundMessage'),
  )

  assert.match(runner, /activeTurns\.steer\([\s\S]*?frameLiveSteerMessage\(/)
  assert.match(runner, /activeLifecycleTrackers\.get\(cid\)\?\.moveTo\(message\)/)
})
