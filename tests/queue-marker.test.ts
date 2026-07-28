import assert from 'node:assert/strict'
import test from 'node:test'

import { FAST_FORWARD_REACTION, LatestQueueMarker, QUEUED_REACTION } from '../src/queue-marker.ts'

function fakeMessage(id: string, events: string[]) {
  const reaction = {
    users: {
      async remove(userId: string) {
        events.push(`remove:${id}:${userId}`)
      },
    },
  }
  return {
    id,
    reactions: { cache: new Map([[QUEUED_REACTION, reaction]]) },
    async react(emoji: string) {
      events.push(`add:${id}:${emoji}`)
      return reaction
    },
  }
}

test('moves one clock forward across rapid queued messages and clears it on drain', async () => {
  const events: string[] = []
  const marker = new LatestQueueMarker(() => 'bot')
  const first = fakeMessage('first', events)
  const second = fakeMessage('second', events)

  const firstMark = marker.mark('channel', first)
  const secondMark = marker.mark('channel', second)
  await Promise.all([firstMark, secondMark])

  assert.deepEqual(events, [
    `add:first:${QUEUED_REACTION}`,
    `add:first:${FAST_FORWARD_REACTION}`,
    'remove:first:bot',
    'remove:first:bot',
    `add:second:${QUEUED_REACTION}`,
    `add:second:${FAST_FORWARD_REACTION}`,
  ])

  await marker.clear('channel')
  assert.deepEqual(events.slice(-2), ['remove:second:bot', 'remove:second:bot'])
})
