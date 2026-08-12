import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TrustedRelayVerifier, type RelayConfig } from '../src/trusted-relay.ts'

const config: RelayConfig = {
  helper_id: 'helper-bot',
  secret: 'deadbeef'.repeat(8),
  relay_user: 'choice-tap',
  relay_user_id: 'owner-user',
  self_id: 'gpt',
}

function marker(target: string, payload: string, channelId = 'channel-1'): string {
  const sig = createHmac('sha256', config.secret)
    .update(`${channelId}\n${target}\n${payload}`)
    .digest('hex')
  return `⟦vc-relay:${target}:${sig}⟧ ${payload}`
}

test('accepts a valid relay targeted to gpt and preserves owner identity', () => {
  const verifier = new TrustedRelayVerifier(() => config)
  assert.deepEqual(verifier.verify({
    messageId: 'message-1',
    channelId: 'channel-1',
    authorId: 'helper-bot',
    content: marker('gpt', 'You chose option 1: proceed'),
  }), {
    payload: 'You chose option 1: proceed',
    userId: 'owner-user',
    userName: 'choice-tap',
  })
})

test('rejects a valid signature addressed to another bot', () => {
  const verifier = new TrustedRelayVerifier(() => config)
  assert.equal(verifier.verify({
    messageId: 'message-2',
    channelId: 'channel-1',
    authorId: 'helper-bot',
    content: marker('bricky', 'not yours'),
  }), null)
})

test('rejects broadcasts so only explicitly targeted relays wake gpt', () => {
  const verifier = new TrustedRelayVerifier(() => config)
  assert.equal(verifier.verify({
    messageId: 'message-3',
    channelId: 'channel-1',
    authorId: 'helper-bot',
    content: marker('', 'broadcast'),
  }), null)
})

test('rejects bad signatures and ordinary bot chatter', () => {
  const verifier = new TrustedRelayVerifier(() => config)
  assert.equal(verifier.verify({
    messageId: 'message-4',
    channelId: 'channel-1',
    authorId: 'helper-bot',
    content: `⟦vc-relay:gpt:${'0'.repeat(64)}⟧ forged`,
  }), null)
  assert.equal(verifier.verify({
    messageId: 'message-5',
    channelId: 'channel-1',
    authorId: 'random-bot',
    content: 'hello from another bot',
  }), null)
})

test('rejects a duplicate Discord delivery of an already consumed relay', () => {
  const verifier = new TrustedRelayVerifier(() => config)
  const input = {
    messageId: 'message-6',
    channelId: 'channel-1',
    authorId: 'helper-bot',
    content: marker('gpt', 'proceed once'),
  }
  assert.ok(verifier.verify(input))
  assert.equal(verifier.verify(input), null)
})

test('Discord ingress verifies bot messages instead of dropping them wholesale', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const inbound = source.slice(
    source.indexOf('async function dispatchInboundMessage'),
    source.indexOf("client.on('messageCreate'"),
  )
  assert.doesNotMatch(inbound, /if \(message\.author\.bot\) return/)
  assert.match(inbound, /message\.author\.bot \? trustedRelays\.verify\(relayInput, false\)/)
  assert.match(inbound, /await handleInboundMessage\(message, replyContext, acceptedRelay\)/)
})
