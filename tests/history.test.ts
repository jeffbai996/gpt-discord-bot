import test from 'node:test'
import assert from 'node:assert/strict'
import { formatHistoryForOpenAI, stripBotMetadata, type HistoryMessage } from '../src/history.ts'
import { stripToolTraceCard } from '../src/render-cleanup.ts'

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

test('stripBotMetadata: drops trace and thinking cards', () => {
  assert.equal(stripBotMetadata('🔧 **Tool trace 2/3**\n```diff\n+ ● shell(rg)\n```'), '')
  assert.equal(stripBotMetadata('💭 **Thinking:**\n> checking the repo'), '')
})

test('stripToolTraceCard: strips leading trace card from reply text', () => {
  const input = `🔧 **Tool trace**
\`\`\`diff
+ ● search_squad_memory
+ ● shell
\`\`\`

actual answer`

  assert.equal(stripToolTraceCard(input), 'actual answer')
})

test('stripToolTraceCard: strips numbered and quoted trace cards', () => {
  const input = `> 🔧 **Tool trace 2/2**
> \`\`\`diff
> + ● Edit
> - ● Bash FAILED
> \`\`\`

actual answer`

  assert.equal(stripToolTraceCard(input), 'actual answer')
})

test('stripBotMetadata: drops headerless trace continuation card', () => {
  // Post-2026-07-05 pagination: only card 1 has the "Tool trace" header; the
  // continuation cards are bare ```diff fences of trace rows. History must still
  // drop them, or the model re-ingests its own trace and mimics the format.
  assert.equal(stripBotMetadata('```diff\n+ ● shell(rg -n foo)\n⎿ match\n```'), '')
  assert.equal(stripBotMetadata('```diff\n ⎿ [+3, -1]\n+  12 new line\n```'), '')
})

test('stripBotMetadata: keeps a real answer that happens to contain a diff block', () => {
  // A genuine reply with a fenced diff (no ● / ⎿ trace rows) must survive.
  const reply = 'here is the patch:\n```diff\n+ added a line\n- removed a line\n```'
  assert.equal(stripBotMetadata(reply), reply)
})

test('stripToolTraceCard: strips a headerless trace continuation between prose', () => {
  const input = `first chunk

\`\`\`diff
+ ● Bash(ls)
⎿ output
\`\`\`

second chunk`
  assert.equal(stripToolTraceCard(input), `first chunk

second chunk`)
})

test('stripToolTraceCard: strips embedded card without eating surrounding prose', () => {
  const input = `first chunk

🔧 **Tool trace**
\`\`\`diff
+ ● Search
\`\`\`

second chunk`

  assert.equal(stripToolTraceCard(input), `first chunk

second chunk`)
})

test('stripToolTraceCard: strips malformed leaked diff body', () => {
  const input = `actual answer

Tool trace 2/2
diff
+ ● apply_patch(src/gpt.ts)
+ ● tsc
  ⎿ passed

next answer line`

  assert.equal(stripToolTraceCard(input), `actual answer

next answer line`)
})

test('stripToolTraceCard: handles repeated trace headers without hanging', () => {
  const input = `Tool trace
Tool trace 2/2
diff
+ ● shell

reply`

  assert.equal(stripToolTraceCard(input), 'reply')
})

test('stripBotMetadata: drops thought status line but keeps reply', () => {
  const text = '💭 ✓ **thought for 12s**\nfixed the trace splitter'
  assert.equal(stripBotMetadata(text), 'fixed the trace splitter')
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
