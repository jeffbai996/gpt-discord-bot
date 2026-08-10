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
  assert.match(inbound, /await runChannelTurn\(message, target\)/)
})

test('fast-forward remains the explicit way to interrupt queued work', async () => {
  const source = await readFile(SOURCE, 'utf8')
  const reactions = source.slice(source.indexOf("client.on('messageReactionAdd'"))

  assert.match(reactions, /FAST_FORWARD_REACTION/)
  assert.match(reactions, /activeTurns\.stopFor\(reaction\.message\.channelId, \{ clearQueue: false \}\)/)
})
