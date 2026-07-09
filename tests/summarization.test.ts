import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSummarization } from '../src/summarization/summarizer.ts'
import { SummaryStore } from '../src/summarization/store.ts'
import { SummarizationScheduler } from '../src/summarization/scheduler.ts'

function fakeOpenAI(replyContent: string) {
  return {
    chat: {
      completions: {
        create: async (_args: any) => ({
          choices: [{ message: { content: replyContent }, finish_reason: 'stop' }]
        })
      }
    }
  } as any
}

test('runSummarization: empty messages throws', async () => {
  await assert.rejects(
    () => runSummarization(null, [], { client: fakeOpenAI('x'), model: 'gpt-5.6-sol' }),
    /empty/
  )
})

test('runSummarization: returns trimmed summary + last message id', async () => {
  const out = await runSummarization(
    null,
    [
      { authorName: 'a', content: 'hi', timestamp: '2025-01-01', messageId: '100' },
      { authorName: 'b', content: 'hello', timestamp: '2025-01-02', messageId: '200' }
    ],
    { client: fakeOpenAI('  channel summary text  '), model: 'gpt-5.6-sol' }
  )
  assert.equal(out.summary, 'channel summary text')
  assert.equal(out.lastMessageId, '200')
})

test('SummaryStore: get + upsert via injected deps', () => {
  let lastUpsert: { c: string; s: string; id: string } | null = null
  const fakeRow = { channel_id: 'c1', summary: 's', last_summarized_message_id: '99', updated_at: 'now' }
  const store = new SummaryStore({
    getSummary: (c) => c === 'c1' ? fakeRow : null,
    upsertSummary: (c, s, id) => { lastUpsert = { c, s, id } }
  })

  const got = store.get('c1')
  assert.equal(got?.channelId, 'c1')
  assert.equal(got?.summary, 's')
  assert.equal(got?.lastSummarizedMessageId, '99')

  store.upsert('c2', 'new summary', '500')
  assert.deepEqual(lastUpsert, { c: 'c2', s: 'new summary', id: '500' })
})

test('SummarizationScheduler: skips when below threshold', async () => {
  let upsertCalled = false
  const store = new SummaryStore({
    getSummary: () => null,
    upsertSummary: () => { upsertCalled = true }
  })
  const scheduler = new SummarizationScheduler({
    store,
    fetchSinceForSummarization: async () => [{ authorName: 'a', content: 'hi', timestamp: 't', messageId: '1' }],
    client: fakeOpenAI('summary'),
    model: 'gpt-5.6-sol',
    threshold: 50
  })
  scheduler.scheduleIfNeeded('c1')
  // Wait for the in-flight promise to settle.
  await new Promise(r => setTimeout(r, 50))
  assert.equal(upsertCalled, false)
})

test('SummarizationScheduler: runs and upserts when threshold met', async () => {
  const upserts: Array<{ c: string; s: string; id: string }> = []
  const store = new SummaryStore({
    getSummary: () => null,
    upsertSummary: (c, s, id) => upserts.push({ c, s, id })
  })
  const messages = Array.from({ length: 60 }, (_, i) => ({
    authorName: 'u',
    content: `msg ${i}`,
    timestamp: 't',
    messageId: String(1000 + i)
  }))
  const scheduler = new SummarizationScheduler({
    store,
    fetchSinceForSummarization: async () => messages,
    client: fakeOpenAI('rolled-up summary'),
    model: 'gpt-5.6-sol',
    threshold: 50
  })
  scheduler.scheduleIfNeeded('c1')
  // Drain the in-flight promise via runForChannel which awaits the in-flight
  // run if one exists.
  await new Promise(r => setTimeout(r, 100))
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].c, 'c1')
  assert.equal(upserts[0].s, 'rolled-up summary')
  assert.equal(upserts[0].id, '1059')
})

test('SummarizationScheduler: runForChannel returns null when nothing to summarize', async () => {
  const store = new SummaryStore({
    getSummary: () => null,
    upsertSummary: () => {}
  })
  const scheduler = new SummarizationScheduler({
    store,
    fetchSinceForSummarization: async () => [],
    client: fakeOpenAI('x'),
    model: 'gpt-5.6-sol',
    threshold: 50
  })
  const result = await scheduler.runForChannel('c1')
  assert.equal(result, null)
})

test('SummarizationScheduler: runForChannel returns count when forced', async () => {
  const store = new SummaryStore({
    getSummary: () => null,
    upsertSummary: () => {}
  })
  const scheduler = new SummarizationScheduler({
    store,
    fetchSinceForSummarization: async () => [
      { authorName: 'u', content: 'a', timestamp: 't', messageId: '1' },
      { authorName: 'u', content: 'b', timestamp: 't', messageId: '2' }
    ],
    client: fakeOpenAI('s'),
    model: 'gpt-5.6-sol',
    threshold: 50
  })
  const result = await scheduler.runForChannel('c1')
  assert.deepEqual(result, { messageCount: 2 })
})
