import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  GptAgentCommandStore,
  parseAgentCommand,
  runAgentCommand,
} from '../src/agent-commands.ts'
import type { CodexAgentSnapshot } from '../src/codex-agents.ts'

const running: CodexAgentSnapshot = {
  id: 'child-1',
  path: '/root/luna',
  label: 'luna',
  nickname: '',
  model: 'gpt-5.6-luna',
  status: 'running',
  startedAt: 1_000,
  tokens: 1_500,
}

const done: CodexAgentSnapshot = {
  ...running,
  id: 'child-2',
  path: '/root/review',
  label: 'review',
  model: 'gpt-5.6-sol',
  status: 'done',
  endedAt: 3_000,
  tokens: 500,
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-agent-commands-'))
}

test('parses only the reserved agents command family, including a bot mention', () => {
  assert.deepEqual(parseAgentCommand('!agents'), { action: 'snapshot' })
  assert.deepEqual(parseAgentCommand('!agent clear'), { action: 'clear', scope: 'finished' })
  assert.deepEqual(parseAgentCommand('!agents clear all'), { action: 'clear', scope: 'all' })
  assert.deepEqual(parseAgentCommand('<@123> !agents help', '123'), { action: 'help' })
  assert.equal(parseAgentCommand('!agentsmith'), null)
  assert.equal(parseAgentCommand('please run !agents'), null)
  assert.equal(parseAgentCommand('<@456> !agents', '123'), null)
})

test('snapshot, clear, clear all, and help match the established command surface', () => {
  const store = new GptAgentCommandStore(tempDir(), 'gpt-one')
  store.record('channel-1', 'workflow-1', [running, done], 4_000)

  const snapshot = runAgentCommand(store, 'channel-1', { action: 'snapshot' }, 5_000)
  assert.match(snapshot, /agents · gpt · 1 running · 1 done · 2\.0k tok/)
  assert.match(snapshot, /luna/)
  assert.match(snapshot, /review/)

  const cleared = runAgentCommand(store, 'channel-1', { action: 'clear', scope: 'finished' }, 5_000)
  assert.equal(cleared, 'cleared — 1 finished dropped, 1 running kept')
  assert.deepEqual(store.snapshot('channel-1').map(agent => agent.id), ['child-1'])

  const clearedAll = runAgentCommand(store, 'channel-1', { action: 'clear', scope: 'all' }, 5_000)
  assert.equal(clearedAll, 'agent list cleared — 1 dropped')
  assert.equal(runAgentCommand(store, 'channel-1', { action: 'snapshot' }, 5_000), '```\nno agents running this session\n```')

  const help = runAgentCommand(store, 'channel-1', { action: 'help' }, 5_000)
  assert.match(help, /!agents clear all/)
  assert.match(help, /view-only/)
})

test('clear all remains hidden when a running workflow publishes another update', () => {
  const store = new GptAgentCommandStore(tempDir(), 'gpt-one')
  store.record('channel-1', 'workflow-1', [running], 4_000)
  store.clear('channel-1', 'all')
  store.record('channel-1', 'workflow-1', [{ ...running, tokens: 9_999 }], 5_000)

  assert.deepEqual(store.snapshot('channel-1'), [])
})

test('two gpt instances sharing a directory cannot read or clear each other', async () => {
  const dir = tempDir()
  const first = new GptAgentCommandStore(dir, 'gpt-one')
  const second = new GptAgentCommandStore(dir, 'gpt-two')

  await Promise.all([
    Promise.resolve().then(() => first.record('same-channel', 'same-workflow', [running], 4_000)),
    Promise.resolve().then(() => second.record('same-channel', 'same-workflow', [{
      ...running,
      label: 'other-instance-agent',
    }], 4_000)),
  ])

  assert.equal(first.snapshot('same-channel')[0].label, 'luna')
  assert.equal(second.snapshot('same-channel')[0].label, 'other-instance-agent')
  first.clear('same-channel', 'all')

  const reloadedFirst = new GptAgentCommandStore(dir, 'gpt-one')
  const reloadedSecond = new GptAgentCommandStore(dir, 'gpt-two')
  assert.deepEqual(reloadedFirst.snapshot('same-channel'), [])
  assert.equal(reloadedSecond.snapshot('same-channel')[0].label, 'other-instance-agent')
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.json')).length, 2)
})

test('channels are isolated inside one gpt instance', () => {
  const store = new GptAgentCommandStore(tempDir(), 'gpt-one')
  store.record('channel-1', 'workflow-1', [running], 4_000)
  store.record('channel-2', 'workflow-2', [{ ...running, label: 'private-job' }], 4_000)

  assert.equal(store.snapshot('channel-1')[0].label, 'luna')
  assert.equal(store.snapshot('channel-2')[0].label, 'private-job')
})
