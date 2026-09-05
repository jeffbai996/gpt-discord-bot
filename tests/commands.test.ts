import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactChannel,
  fmtClearAcknowledgement,
  fmtContextPressureLine,
  fmtLimitLines,
  fmtModelStatus,
  fmtSettingChange,
  gptCommand,
} from '../src/commands.ts'

const futureReset = () => Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60

test('limits labels a primary weekly window from its duration', () => {
  const lines = fmtLimitLines({
    primary: { usedPercent: 1, windowMinutes: 10_080, resetsAt: futureReset() },
    planType: 'prolite',
  })

  assert.equal(lines.length, 1)
  assert.match(lines[0], /^weekly:/)
  assert.doesNotMatch(lines[0], /5-hour/)
})

test('limits labels a five-hour window from its duration', () => {
  const lines = fmtLimitLines({
    primary: { usedPercent: 20, windowMinutes: 300, resetsAt: futureReset() },
  })

  assert.match(lines[0], /^5-hour:/)
})

test('limits labels other windows from their actual duration', () => {
  const lines = fmtLimitLines({
    primary: { usedPercent: 20, windowMinutes: 1_440, resetsAt: futureReset() },
    secondary: { usedPercent: 30, windowMinutes: 120, resetsAt: futureReset() },
  })

  assert.match(lines[0], /^1-day:/)
  assert.match(lines[1], /^2-hour:/)
})

test('limits slash command names the Codex subscription', () => {
  const command = gptCommand.toJSON()
  const limits = command.options?.find((option: any) => option.name === 'limits')
  assert.equal(limits?.description, 'Show Codex subscription usage')
})

test('stats formats the latest codex prompt pressure against its context window', () => {
  assert.equal(
    fmtContextPressureLine({ lastInputTokens: 208_035, modelContextWindow: 258_400 }),
    'context:  208k / 258k tok  (81%)',
  )
})

test('stats omits context pressure until codex has emitted a usable snapshot', () => {
  assert.equal(fmtContextPressureLine({ lastInputTokens: 0, modelContextWindow: 258_400 }), null)
  assert.equal(fmtContextPressureLine({ lastInputTokens: 1_000, modelContextWindow: 0 }), null)
})

test('clear acknowledgement identifies the reset channel', () => {
  const message = fmtClearAcknowledgement('123456789')

  assert.match(message, /<#123456789>/)
  assert.match(message, /cleared — next turn starts fresh\./)
})

test('/gpt plan is not registered', () => {
  const json = gptCommand.toJSON()
  const plan = json.options?.find((option: any) => option.name === 'plan')

  assert.equal(plan, undefined)
})

test('/gpt poll is not registered', () => {
  const json = gptCommand.toJSON()
  const poll = json.options?.find((option: any) => option.name === 'poll')

  assert.equal(poll, undefined)
})

test('/gpt command menu excludes redundant maintenance controls', () => {
  const names = gptCommand.toJSON().options?.map((option: any) => option.name) ?? []

  for (const removed of ['persona', 'history', 'cache', 'preset']) {
    assert.doesNotMatch(names.join(' '), new RegExp(`(^| )${removed}( |$)`))
  }
  for (const retained of ['channel', 'stop', 'clear', 'compact', 'session', 'doctor', 'stats', 'limits', 'settings']) {
    assert.match(names.join(' '), new RegExp(`(^| )${retained}( |$)`))
  }
})

test('/gpt compact summarizes before dropping only the active Codex session', async () => {
  const events: string[] = []
  const result = await compactChannel('channel-1', {
    summarizer: {
      runForChannel: async channelId => {
        events.push(`summarize:${channelId}`)
        return { messageCount: 42 }
      },
    },
    isTurnActive: () => false,
    dropSession: channelId => {
      events.push(`drop:${channelId}`)
      return true
    },
  })

  assert.deepEqual(events, ['summarize:channel-1', 'drop:channel-1'])
  assert.deepEqual(result, { status: 'compacted', messageCount: 42, droppedSession: true })
})

test('/gpt compact keeps the session when summarization fails', async () => {
  let dropped = false
  await assert.rejects(
    () => compactChannel('channel-1', {
      summarizer: { runForChannel: async () => { throw new Error('ollama unavailable') } },
      isTurnActive: () => false,
      dropSession: () => { dropped = true; return true },
    }),
    /ollama unavailable/,
  )
  assert.equal(dropped, false)
})

test('/gpt compact refuses to race an active turn', async () => {
  let summarized = false
  const result = await compactChannel('channel-1', {
    summarizer: { runForChannel: async () => { summarized = true; return null } },
    isTurnActive: () => true,
    dropSession: () => true,
  })

  assert.deepEqual(result, { status: 'busy' })
  assert.equal(summarized, false)
})

test('/gpt effort labels xhigh without an extra descriptor', () => {
  const json = gptCommand.toJSON()
  const effort: any = json.options?.find((option: any) => option.name === 'effort')
  const value: any = effort?.options?.find((option: any) => option.name === 'value')
  const xhigh = value?.choices?.find((choice: any) => choice.value === 'xhigh')

  assert.equal(xhigh?.name, 'xhigh')
})

test('/gpt engine names the Codex subscription instead of a flat sub', () => {
  const json = gptCommand.toJSON()
  const engine: any = json.options?.find((option: any) => option.name === 'engine')
  const value: any = engine?.options?.find((option: any) => option.name === 'value')
  const codex = value?.choices?.find((choice: any) => choice.value === 'codex')

  assert.equal(codex?.name, 'codex - Codex subscription (default)')
})

test('/gpt stats describes persisted cumulative usage', () => {
  const json = gptCommand.toJSON()
  const stats = json.options?.find((option: any) => option.name === 'stats')

  assert.equal(stats?.description, 'Show cumulative token usage')
})

test('/gpt model choices use durable tier labels', () => {
  const json = gptCommand.toJSON()
  const model: any = json.options?.find((option: any) => option.name === 'model')
  const value: any = model?.options?.find((option: any) => option.name === 'value')

  assert.deepEqual(value?.choices?.map((choice: any) => choice.name), [
    'gpt-6-astra',
    'gpt-5.6-sol - frontier coding',
    'gpt-5.6-terra - balanced',
    'gpt-5.6-luna - high-throughput',
    'Daybreak Blue - defensive cyber',
  ])
})

test('/gpt effort exposes ultra as automatic delegation', () => {
  const json = gptCommand.toJSON()
  const effort: any = json.options?.find((option: any) => option.name === 'effort')
  const value: any = effort?.options?.find((option: any) => option.name === 'value')
  const ultra = value?.choices?.find((choice: any) => choice.value === 'ultra')

  assert.equal(ultra?.name, 'ultra - automatic delegation')
  assert.equal(value?.choices?.some((choice: any) => choice.value === 'none'), false)
})

test('setting acknowledgements include the previous value only when changed', () => {
  assert.equal(fmtSettingChange('effort', 'high', 'medium'), '✅ effort → `high` (was `medium`)')
  assert.equal(fmtSettingChange('effort', 'high', 'high'), '✅ effort → `high`')
})

test('/gpt model status shows the model and effective effort without engine trivia', () => {
  const status = fmtModelStatus('123456789012345678', 'gpt-5.6-sol', 'high')

  assert.equal(status, '🤖 <#123456789012345678> model `gpt-5.6-sol` · effort `high`')
  assert.doesNotMatch(status, /postmortem|engine|\(|\)/i)
})
