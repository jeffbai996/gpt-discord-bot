import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * gpt-bot sits in channels it does not answer in — it has read access to the
 * whole server, but `access.canHandle` decides where it actually responds.
 *
 * Any reaction placed on an INBOUND USER MESSAGE is bot output, so it belongs
 * behind that same gate. The shutdown-deferral ⏳ was not, and it landed on a
 * message in the family channel where gpt-bot is not the responder and the
 * Claude bots already handle in-flight messages themselves (Jeff 2026-07-31).
 *
 * The guarded function is not exported, so assert on the source: inside the
 * `if (!release)` block, the access check must come before the react.
 */
const SOURCE = new URL('../src/gpt.ts', import.meta.url)

test('shutdown-deferral reaction is gated on access.canHandle', async () => {
  const source = await readFile(SOURCE, 'utf8')

  const dispatch = source.slice(source.indexOf('async function dispatchInboundMessage'))
  const block = dispatch.slice(dispatch.indexOf('if (!release)'), dispatch.indexOf('try {'))
  assert.ok(block.length > 0, 'could not locate the shutdown-deferral block')

  const gate = block.indexOf('access.canHandle')
  const react = block.indexOf("react('⏳')")

  assert.ok(gate !== -1, 'shutdown deferral must consult access.canHandle')
  assert.ok(react !== -1, 'expected the deferral reaction in this block')
  assert.ok(
    gate < react,
    'access.canHandle must run BEFORE reacting — otherwise gpt-bot stamps ⏳ on '
    + 'messages in channels it does not serve',
  )
})

test('deferral does not persist messages from channels gpt-bot cannot handle', async () => {
  const source = await readFile(SOURCE, 'utf8')

  const dispatch = source.slice(source.indexOf('async function dispatchInboundMessage'))
  const block = dispatch.slice(dispatch.indexOf('if (!release)'), dispatch.indexOf('try {'))

  const gate = block.indexOf('access.canHandle')
  const defer = block.indexOf('restartInbox.defer')

  assert.ok(defer !== -1, 'expected the restart-inbox deferral in this block')
  assert.ok(
    gate < defer,
    'replaying a message gpt-bot would never answer just re-delivers it after '
    + 'the restart — gate the defer too',
  )
})
