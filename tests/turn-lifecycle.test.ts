import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { logTurnLifecycle } from '../src/turn-lifecycle.ts'

test('structured lifecycle logs whitelist metadata and omit message content', () => {
  let line = ''
  const prior = console.error
  console.error = value => { line = String(value) }
  try {
    logTurnLifecycle({
      event: 'turn_registered',
      channelId: 'channel',
      generation: 7,
      queueDepth: 2,
      ...({ messageBody: 'private text' } as any),
    })
  } finally {
    console.error = prior
  }

  const record = JSON.parse(line)
  assert.equal(record.event, 'turn_registered')
  assert.equal(record.generation, 7)
  assert.equal(record.queueDepth, 2)
  assert.equal(record.messageBody, undefined)
  assert.doesNotMatch(line, /private text/)
})

test('partial output has no write access to the thought message', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf("if (event.type === 'partial')")
  const end = source.indexOf('\n    }', start)
  const branch = source.slice(start, end)
  assert.ok(start >= 0)
  assert.doesNotMatch(branch, /workMessage\.edit|queueLiveText|postPlaceholder/)
})

test('completed reasoning is merged beneath the thought duration instead of stranded above', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('if (willThinking)')
  const end = source.indexOf('\n    // Tool-trace card', start)
  const branch = source.slice(start, end)

  assert.ok(start >= 0)
  assert.match(branch, /formatReasoningSnapshot/)
  assert.match(branch, /thoughtLine/)
  assert.doesNotMatch(branch, /channel\.send|workMessage\.edit/)
})

test('thinking on and collapse accumulate while live uses the latest thought', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')

  assert.match(source, /flags\.thinking === 'on' \|\| flags\.thinking === 'collapse'/)
  assert.match(source, /const accumulatesReasoning = flags\.thinking === 'on' \|\| flags\.thinking === 'collapse'/)
  assert.match(source, /reasoningTrace: accumulatesReasoning \? liveReasoningTrace : \[\]/)
})

test('live narration is reposted beneath the complete tool trace stack', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const rehomeStart = source.indexOf('const rehomeLiveWorkBelowTrace')
  const rehomeEnd = source.indexOf('\n  const flushLiveTrace', rehomeStart)
  const rehome = source.slice(rehomeStart, rehomeEnd)
  const flushStart = rehomeEnd
  const flushEnd = source.indexOf('\n  const markLiveTraceDirty', flushStart)
  const flush = source.slice(flushStart, flushEnd)

  assert.ok(rehomeStart >= 0)
  assert.match(rehome, /traceChannel\.send\(content\)/)
  assert.match(rehome, /previous\.delete\(\)/)
  assert.match(flush, /await rehomeLiveWorkBelowTrace\(traceChannel\)/)
  assert.match(flush, /liveTraceMsgs\[i\]\.content !== cards\[i\]/)
  assert.ok(
    flush.indexOf('await rehomeLiveWorkBelowTrace(traceChannel)')
      > flush.indexOf('liveTraceMsgs = liveTraceMsgs.slice(0, cards.length)'),
  )
})

test('heartbeat never invents a generic tool-status narration line', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf("if (event.type === 'heartbeat')")
  const end = source.indexOf("\n    if (event.type === 'partial')", start)
  const branch = source.slice(start, end)

  assert.ok(start >= 0)
  assert.match(branch, /const base = lastProgressText/)
  assert.doesNotMatch(branch, /currentStatus/)
})

test('collapsed earlier-call summary is not styled as a tool command', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /MAX_TRACE_CALLS|MAX_DIFF_BODY_LINES/)
  assert.match(source, /renderTraceCards\(buildTraceLines\(liveToolRows\), flags\.trace\)/)
})

test('both rolling-live and full-collapse traces are transient', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')

  assert.match(source, /const transientTrace = flags\.trace === 'live' \|\| flags\.trace === 'collapse'/)
  assert.match(source, /if \(transientTrace && liveTraceMsgs\.length\)/)
})
