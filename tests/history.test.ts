import test from 'node:test'
import assert from 'node:assert/strict'
import { formatHistoryForOpenAI, stripBotMetadata, type HistoryMessage } from '../src/history.ts'

const SELF = 'bot-id'

function userMsg(id: string, name: string, content: string): HistoryMessage {
  return { id, authorId: `u-${name}`, authorName: name, content, attachments: [], createdTimestamp: 0 }
}
function botMsg(id: string, content: string): HistoryMessage {
  return { id, authorId: SELF, authorName: 'gpt', content, attachments: [], createdTimestamp: 0 }
}

test('stripBotMetadata: drops -# directive lines', () => {
  const text = 'real reply\n-# ↑ 1 · ↓ 2 · ◷ 3s'
  assert.equal(stripBotMetadata(text), 'real reply')
})

test('stripBotMetadata: empty input returns empty', () => {
  assert.equal(stripBotMetadata(''), '')
})

test('formatHistoryForOpenAI: maps roles by author', async () => {
  const msgs = [userMsg('1', 'alice', 'hi'), botMsg('2', 'hello alice')]
  const out = await formatHistoryForOpenAI(msgs, SELF)
  assert.equal(out.length, 2)
  assert.equal(out[0].role, 'user')
  assert.equal(out[0].content, 'alice: hi')
  assert.equal(out[1].role, 'assistant')
  assert.equal(out[1].content, 'hello alice')
})

test('formatHistoryForOpenAI: skips messages that strip to empty', async () => {
  // A bot message that is entirely a -# metadata directive strips to nothing
  // and must be dropped (the user prefix keeps user messages non-empty).
  const msgs = [botMsg('1', '-# ↑ 1 · ↓ 0'), userMsg('2', 'bob', 'real')]
  const out = await formatHistoryForOpenAI(msgs, SELF)
  assert.equal(out.length, 1)
  assert.equal(out[0].content, 'bob: real')
})

test('formatHistoryForOpenAI: describes attachments as breadcrumbs', async () => {
  const msgs: HistoryMessage[] = [{
    id: '1', authorId: 'u-alice', authorName: 'alice', content: 'look',
    attachments: [{ name: 'pic.png', url: 'http://x/pic.png', mimeType: 'image/png' }],
    createdTimestamp: 0,
  }]
  const out = await formatHistoryForOpenAI(msgs, SELF)
  assert.match(String(out[0].content), /\[previous image: pic\.png\]/)
})

test('formatHistoryForOpenAI: windows to token budget, keeps newest', async () => {
  // 6 large messages; tiny budget forces a trim down to minRetain (3).
  const big = 'x'.repeat(4000) // ~1000 tokens each at chars/4
  const msgs = Array.from({ length: 6 }, (_, i) => userMsg(String(i), `u${i}`, big))
  const out = await formatHistoryForOpenAI(msgs, SELF, 500) // budget below one msg
  assert.equal(out.length, 3) // floored at MIN_RETAIN
  // The kept messages are the newest three (u3, u4, u5).
  assert.match(String(out[0].content), /^u3:/)
  assert.match(String(out[2].content), /^u5:/)
})

test('formatHistoryForOpenAI: generous budget keeps everything', async () => {
  const msgs = [userMsg('1', 'a', 'one'), userMsg('2', 'b', 'two'), userMsg('3', 'c', 'three')]
  const out = await formatHistoryForOpenAI(msgs, SELF, 100000)
  assert.equal(out.length, 3)
})
