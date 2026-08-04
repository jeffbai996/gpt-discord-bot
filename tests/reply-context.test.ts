import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatReplyContext, resolveReplyContext } from '../src/reply-context.ts'

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
})
