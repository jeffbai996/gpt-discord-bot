import assert from 'node:assert/strict'
import test from 'node:test'

import { frameSteeredMessages } from '../src/steer-context.ts'

test('steering asks the model to judge now versus later versus replacement', () => {
  const framed = frameSteeredMessages(['also audit the cache later'])

  assert.match(framed, /allowed to finish/)
  assert.match(framed, /not a reset or replacement/)
  assert.match(framed, /durable todo/)
  assert.match(framed, /corrects or narrows/)
  assert.match(framed, /also audit the cache later$/)
})

test('an immediate side task builds on completed active work without redoing it', () => {
  const framed = frameSteeredMessages(['quickly check the logs too'])

  assert.match(framed, /Use the prior turn's result and tool work as context/)
  assert.match(framed, /do not redo the completed task/)
  assert.match(framed, /Only abandon or replace the original task when the user clearly cancels it/)
})

test('steering preserves a rapid FIFO burst as one decision context', () => {
  const framed = frameSteeredMessages(['first correction', 'second correction'])

  assert.match(framed, /first correction\nsecond correction$/)
  assert.equal(framed.match(/\[Queued follow-up context:/g)?.length, 1)
})
