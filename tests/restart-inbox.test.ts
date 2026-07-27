import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RestartInbox } from '../src/restart-inbox.ts'

const tmp = path.join(os.tmpdir(), `gpt-restart-inbox-${process.pid}`)
const file = path.join(tmp, 'restart-inbox.json')

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('persists final-window messages once and replays them after boot', async () => {
  const inbox = new RestartInbox(file)
  inbox.defer('channel-a', 'message-1')
  inbox.defer('channel-a', 'message-1')
  inbox.defer('channel-b', 'message-2')

  const replayed: string[] = []
  const nextBoot = new RestartInbox(file)
  const count = await nextBoot.replay(async (channelId, messageId) => {
    replayed.push(`${channelId}/${messageId}`)
  })

  assert.equal(count, 2)
  assert.deepEqual(replayed, ['channel-a/message-1', 'channel-b/message-2'])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [])
})

test('keeps a failed replay entry for the next boot', async () => {
  const inbox = new RestartInbox(file)
  inbox.defer('channel-a', 'message-1')
  inbox.defer('channel-b', 'message-2')

  await inbox.replay(async (_channelId, messageId) => {
    if (messageId === 'message-1') throw new Error('Discord unavailable')
  })

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [
    { channelId: 'channel-a', messageId: 'message-1' },
  ])
})
