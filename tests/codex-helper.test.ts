import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCodexHelperTool } from '../src/tools/codex.ts'
import type { DeferredToolJob } from '../src/tools/registry.ts'

test('codex_helper acknowledges immediately and defers the running job', async () => {
  let release!: (value: string) => void
  const running = new Promise<string>(resolve => { release = resolve })
  const seen: Array<{ task: string; repo: string; writable: boolean }> = []
  let deferred: DeferredToolJob | undefined
  const tool = makeCodexHelperTool({
    run: async input => {
      seen.push(input)
      return await running
    },
    makeJobId: () => 'job_test123',
  })

  const ack = await tool.execute(
    { task: 'fix the flaky test and verify it', repo: 'gpt-bot' },
    { defer: job => { deferred = job } },
  )

  assert.match(ack, /job_test123/)
  assert.match(ack, /running in the background/i)
  assert.deepEqual(seen, [{
    task: 'fix the flaky test and verify it',
    repo: 'gpt-bot',
    writable: true,
  }])
  assert.equal(deferred?.id, 'job_test123')
  assert.equal(tool.name, 'codex_helper')
  assert.equal(deferred?.tool, 'codex_helper')

  release('patched and tests pass')
  assert.equal(await deferred?.result, 'patched and tests pass')
})

test('codex_helper refuses to fake background work without a defer sink', async () => {
  let ran = false
  const tool = makeCodexHelperTool({
    run: async () => { ran = true; return 'done' },
  })

  const out = await tool.execute({ task: 'do work', repo: 'gpt-bot' }, {})

  assert.match(out, /only available during a live voice session/i)
  assert.equal(ran, false)
})

test('codex_helper validates task and sanitizes repo names', async () => {
  const calls: string[] = []
  const tool = makeCodexHelperTool({
    run: async input => { calls.push(input.repo); return 'done' },
    makeJobId: () => 'job_safe',
  })
  const jobs: DeferredToolJob[] = []

  assert.match(await tool.execute({ task: '  ' }, { defer: j => jobs.push(j) }), /non-empty/)
  const ack = await tool.execute(
    { task: 'inspect it', repo: '../../gpt-bot' },
    { defer: j => jobs.push(j) },
  )

  assert.match(ack, /invalid repo/i)
  assert.match(await tool.execute(
    { task: 'inspect it', repo: '..' },
    { defer: j => jobs.push(j) },
  ), /invalid repo/i)
  assert.deepEqual(calls, [])
  assert.deepEqual(jobs, [])
})
