import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatPinContext,
  formatReplyContext,
  resolvePinContext,
  resolveReplyContext,
} from '../src/reply-context.ts'

describe('reply context', () => {
  test('fetches a referenced message once and renders its text and attachments', async () => {
    let calls = 0
    const message = {
      reference: { messageId: 'old-message' },
      async fetchReference() {
        calls += 1
        return {
          id: 'old-message',
          author: { id: 'bot-id', username: 'gpt', bot: true },
          content: 'the earlier answer',
          attachments: new Map([['a', {
            name: 'chart.png', url: 'https://example.invalid/chart.png',
            size: 123, contentType: 'image/png',
          }]]),
        }
      },
    }

    const first = await resolveReplyContext(message)
    const second = await resolveReplyContext(message)
    assert.equal(calls, 1)
    assert.deepEqual(second, first)
    assert.match(formatReplyContext(first), /the earlier answer/)
    assert.match(formatReplyContext(first), /chart\.png/)
  })

  test('degrades to no context when the reference cannot be fetched', async () => {
    const context = await resolveReplyContext({
      reference: { messageId: 'deleted' },
      async fetchReference() { throw new Error('Unknown Message') },
    })
    assert.equal(context, null)
    assert.equal(formatReplyContext(context), '')
  })

  test('renders channel pin system messages as pin events, not replies', async () => {
    const message = {
      type: 6,
      reference: { messageId: 'pinned-message' },
      async fetchReference() {
        return {
          id: 'pinned-message',
          author: { id: 'user-id', username: 'alice', bot: false },
          content: 'keep this useful answer',
          attachments: new Map(),
        }
      },
    }

    assert.equal(await resolveReplyContext(message), null)
    const pin = await resolvePinContext(message)
    assert.match(formatPinContext(pin), /Discord pin event/)
    assert.match(formatPinContext(pin), /keep this useful answer/)
  })

  test('pin events remain non-empty when the pinned message is unavailable', async () => {
    const pin = await resolvePinContext({
      type: 6,
      reference: { messageId: 'deleted' },
      async fetchReference() { throw new Error('Unknown Message') },
    })
    assert.match(formatPinContext(pin), /deleted/)
    assert.match(formatPinContext(pin), /unavailable/)
  })
})
