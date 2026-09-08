import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildDefaultRegistry } from '../src/tools/index.ts'

test('default tool registry does not expose the uncontained logged-in browser', async () => {
  const oldUrl = process.env.GPT_MCP_URL
  delete process.env.GPT_MCP_URL
  try {
    const registry = await buildDefaultRegistry({} as any)
    assert.equal(registry.has('browse'), false)
    assert.equal(registry.has('codex'), false)
    assert.equal(registry.has('fetch_url'), true)
  } finally {
    if (oldUrl === undefined) delete process.env.GPT_MCP_URL
    else process.env.GPT_MCP_URL = oldUrl
  }
})

test('Discord reply prose cannot nominate host files for attachment', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /resolveShot|SHOT_DIRS/)
  assert.match(source, /result\.files/)
})

test('retry buttons and reaction reruns enter through the bounded channel runner', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /await handleUserMessage\(source, interaction\.message/)
  assert.doesNotMatch(source, /rerunHandler:\s*handleUserMessage/)
  assert.match(source, /await runChannelTurn\(\s*source,/)
  assert.match(source, /rerunHandler:\s*\(original, target, expansion\) => runChannelTurn/)
})

test('startup invalidates resumable sessions from before history authorization', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  assert.match(source, /channelSessions\.invalidateAllOnce\(SESSION_SECURITY_EPOCH\)/)
})

test('daily principal admission happens before steering or mixed-user queue batching', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function runChannelTurn(')
  const end = source.indexOf('\nasync function handleInboundMessage(', start)
  const runner = source.slice(start, end)
  const reserve = runner.indexOf('turnAdmission.reserve(admissionUserId)')
  assert.ok(reserve >= 0)
  assert.ok(reserve < runner.indexOf('activeTurns.steer('))
  assert.ok(reserve < runner.indexOf('channelTurns.submit('))
})
