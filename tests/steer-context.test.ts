import assert from 'node:assert/strict'
import test from 'node:test'

import { frameSteeredMessages } from '../src/steer-context.ts'

test('steering asks the model to judge now versus later versus replacement', () => {
  const framed = frameSteeredMessages(['also audit the cache later'])

  assert.match(framed, /Do it now when/)
  assert.match(framed, /durable todo/)
  assert.match(framed, /corrects or narrows/)
  assert.match(framed, /also audit the cache later$/)
})

test('an immediate side task cannot silently replace unfinished active work', () => {
  const framed = frameSteeredMessages(['quickly check the logs too'])

  assert.match(framed, /side task does not cancel the active task/)
  assert.match(framed, /resume the original task in the same turn/)
  assert.match(framed, /do not give a final response until both are complete or genuinely blocked/)
  assert.match(framed, /Only abandon or replace the original task when the user clearly cancels it/)
})

test('steering preserves a rapid FIFO burst as one decision context', () => {
  const framed = frameSteeredMessages(['first correction', 'second correction'])

  assert.match(framed, /first correction\nsecond correction$/)
  assert.equal(framed.match(/\[Steering context:/g)?.length, 1)
})
