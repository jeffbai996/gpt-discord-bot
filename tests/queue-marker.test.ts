import assert from 'node:assert/strict'
import test from 'node:test'

import { LatestQueueMarker, QUEUED_REACTION } from '../src/queue-marker.ts'

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
    'remove:first:bot',
    `add:second:${QUEUED_REACTION}`,
  ])

  await marker.clear('channel')
  assert.equal(events.at(-1), 'remove:second:bot')
})
