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

test('collapse narration stays beneath its paginated trace stack', async () => {
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
  assert.match(flush, /flags\.trace === 'collapse' && appendedTraceCard/)
  assert.match(flush, /await rehomeLiveWorkBelowTrace\(traceChannel\)/)
  assert.match(flush, /liveTraceMsgs\[i\]\.content !== cards\[i\]/)
  assert.ok(
    flush.indexOf('await rehomeLiveWorkBelowTrace(traceChannel)')
      > flush.indexOf('liveTraceMsgs = liveTraceMsgs.slice(0, cards.length)'),
  )
})

test('rolling live trace is reposted beneath newer bot output without duplicates', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const rehomeLiveTraceAtBottom')
  const end = source.indexOf('\n  const flushLiveTrace', start)
  const helper = source.slice(start, end)
  const finalStart = source.indexOf('let mergedMsg: Message | null = null')
  const finalEnd = source.indexOf('\n    // Transient thought line', finalStart)
  const finalRender = source.slice(finalStart, finalEnd)

  assert.ok(start >= 0)
  assert.match(helper, /flags\.trace !== 'live'/)
  assert.match(helper, /isNewerDiscordMessage\(below\.id, anchor\.id\)/)
  assert.match(helper, /traceChannel\.send\(current\.content\)/)
  assert.ok(helper.indexOf('traceChannel.send(current.content)') < helper.indexOf('previous.delete()'))
  assert.match(finalRender, /await rehomeLiveTraceAtBottom\(/)
})

test('collapse narration accumulates and survives reasoning redraws until turn end', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const progressStart = source.indexOf("if (event.type === 'progress')")
  const progressEnd = source.indexOf("if (event.type === 'reasoning_progress')", progressStart)
  const progressBranch = source.slice(progressStart, progressEnd)
  const reasoningStart = progressEnd
  const reasoningEnd = source.indexOf("if (event.type === 'heartbeat')", reasoningStart)
  const reasoningBranch = source.slice(reasoningStart, reasoningEnd)

  assert.match(progressBranch, /flags\.thinking === 'collapse'/)
  assert.match(progressBranch, /appendNarrationTrace\(liveNarrationTrace, event\.reply\)/)
  assert.doesNotMatch(reasoningBranch, /liveNarrationTrace\s*=/)
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

test('session rollover cannot block final trace collapse indefinitely', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const compactAndDropCodexSession')
  const end = source.indexOf('\n  // Live tool trace:', start)
  const rollover = source.slice(start, end)

  assert.ok(start >= 0)
  assert.match(rollover, /settleWithin\(/)
  assert.match(rollover, /SESSION_ROLLOVER_SUMMARY_TIMEOUT_MS/)
  assert.match(rollover, /channelSessions\.dropSession\(channelId\)/)
  assert.match(rollover, /setLiveCompacting\(true\)/)
  assert.match(rollover, /setLiveCompacting\(false\)/)
})

test('post-turn rollover runs only after the reply and trace cleanup are armed', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const resultStart = source.indexOf('// Post-turn rollover still matters')
  const renderStart = source.indexOf('// Result is in hand', resultStart)
  const cleanupStart = source.indexOf('const toDelete: Message[]', renderStart)
  const cleanupEnd = source.indexOf('await finishPostTurnRollover()', cleanupStart)

  assert.ok(resultStart >= 0)
  assert.ok(renderStart > resultStart)
  assert.ok(cleanupStart > renderStart)
  assert.ok(cleanupEnd > cleanupStart)
  assert.doesNotMatch(source.slice(resultStart, renderStart), /await compactAndDropCodexSession/)
  assert.match(source.slice(resultStart, renderStart), /pendingPostTurnRolloverUsage\s*=/)
  assert.match(source.slice(cleanupStart, cleanupEnd), /scheduleTransientTraceCleanup/)
})

test('silent and file-only completions also arm transient trace cleanup', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const silentStart = source.indexOf("if (!body.trim() && !result.files?.length)")
  const fileOnlyStart = source.indexOf("if (!body.trim() && result.files?.length)", silentStart)
  const normalStart = source.indexOf("const willThinking", fileOnlyStart)
  const silentBranch = source.slice(silentStart, fileOnlyStart)
  const fileOnlyBranch = source.slice(fileOnlyStart, normalStart)

  assert.ok(silentStart >= 0)
  assert.ok(fileOnlyStart > silentStart)
  assert.match(silentBranch, /scheduleTransientTraceCleanup\(liveTraceMsgs\)/)
  assert.match(fileOnlyBranch, /scheduleTransientTraceCleanup\(liveTraceMsgs\)/)
})
