import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCodexArgs, codexTimeoutMs, codexWatchdogPolicy, commentaryProgress, isInFlightStatusPing, isMeaningfulCodexActivity, liveEvent, mapEffort, reasoningProgress, toolCallsFromCompletedItem } from '../src/codex-chat.ts'

test('codex effort: max passes through to the CLI', () => {
  assert.equal(mapEffort('max'), 'max')
})

test('codex commentary: surfaces in-flight progress text', () => {
  assert.equal(commentaryProgress({
    type: 'event_msg',
    payload: { type: 'agent_message', phase: 'commentary', message: 'tests are still running' },
  }), 'tests are still running')
  assert.equal(commentaryProgress({
    type: 'event_msg',
    payload: { type: 'agent_message', phase: 'final_answer', message: 'done' },
  }), null)

  // codex-cli 0.144.0 flattens both commentary and the final answer to this
  // item.completed shape on --json stdout. Every agent message is useful live
  // progress; the -o file remains authoritative for the final answer.
  assert.equal(commentaryProgress({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'checking the service logs now' },
  }), 'checking the service logs now')
})

test('codex reasoning: surfaces explicit reasoning summaries, never encrypted thought data', () => {
  assert.equal(reasoningProgress({
    type: 'item.completed',
    item: { type: 'reasoning', text: 'The child is alive but its stdout is silent.' },
  }), 'The child is alive but its stdout is silent.')
  assert.equal(reasoningProgress({
    type: 'response_item',
    payload: { type: 'reasoning', encrypted_content: 'opaque-private-state' },
  }), null)
})

test('codex liveness: only meaningful state transitions refresh the idle watchdog', () => {
  for (const event of [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'progress' } },
    { type: 'turn.completed', usage: {} },
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'progress' } },
  ]) assert.equal(isMeaningfulCodexActivity(event), true, JSON.stringify(event))

  for (const event of [
    null,
    {},
    { type: 'token_count', info: {} },
    { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { type: 'unknown.keepalive.noise' },
  ]) assert.equal(isMeaningfulCodexActivity(event), false, JSON.stringify(event))
})

test('in-flight status ping: status checks do not become barge-ins', () => {
  assert.equal(isInFlightStatusPing('wait did this just get stuck'), true)
  assert.equal(isInFlightStatusPing('are you still working?'), true)
  assert.equal(isInFlightStatusPing('where\'d ya go'), true)
  assert.equal(isInFlightStatusPing('diagnose why this got stuck and fix it'), false)
  assert.equal(isInFlightStatusPing('stop this'), false)
})

test('liveEvent: surfaces MCP begin events from codex rollout-style JSON', () => {
  const ev = liveEvent({
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_begin',
      invocation: {
        server: 'playwright',
        tool: 'browser_click',
        arguments: { element: 'Mint fare button' },
      },
    },
  })

  assert.deepEqual(ev, {
    status: '🔌 plugin',
    tool: {
      name: 'playwright.browser_click',
      args: '{"element":"Mint fare button"}',
    },
  })
})

test('liveEvent: surfaces MCP item.started events', () => {
  const ev = liveEvent({
    type: 'item.started',
    item: {
      type: 'mcp_tool_call',
      server: 'vecgrep',
      tool: 'search',
      arguments: { query: 'operator demo' },
    },
  })

  assert.deepEqual(ev, {
    status: '🔌 plugin',
    tool: {
      name: 'vecgrep.search',
      args: '{"query":"operator demo"}',
    },
  })
})

test('liveEvent: surfaces Codex response_item function calls as live tools', () => {
  const ev = liveEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: '/bin/bash -lc \'rg -n "needle" src\'' }),
    },
  })

  assert.deepEqual(ev, {
    status: '🛠️ running',
    tool: {
      name: 'shell',
      args: 'rg -n "needle" src',
    },
  })
})

test('liveEvent: surfaces generic Codex response_item function calls', () => {
  const ev = liveEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'view_image',
      arguments: { path: '/tmp/shot.jpg' },
    },
  })

  assert.deepEqual(ev, {
    status: '🔧 tooling',
    tool: {
      name: 'view_image',
      args: '{"path":"/tmp/shot.jpg"}',
    },
  })
})

test('toolCallsFromCompletedItem: maps shell completions with output preview', () => {
  const calls = toolCallsFromCompletedItem({
    type: 'command_execution',
    command: "/bin/bash -lc 'rg -n needle src'",
    aggregated_output: 'src/a.ts:1:needle\nsrc/b.ts:2:needle\n',
    exit_code: 0,
  })

  assert.deepEqual(calls, [{
    name: 'shell',
    args: { command: 'rg -n needle src' },
    durationMs: 0,
    resultPreview: 'src/a.ts:1:needle src/b.ts:2:needle',
    resultLines: 2,
    failed: false,
  }])
})

test('toolCallsFromCompletedItem: marks failed shell completions', () => {
  const calls = toolCallsFromCompletedItem({
    type: 'command_execution',
    command: "bash -lc 'npm test'",
    aggregated_output: 'boom',
    exit_code: 1,
  })

  assert.equal(calls[0].failed, true)
  assert.equal(calls[0].resultPreview, 'boom')
})

test('toolCallsFromCompletedItem: maps file changes per path', () => {
  const calls = toolCallsFromCompletedItem({
    type: 'file_change',
    changes: [
      { path: '/tmp/a.ts', kind: 'update' },
      { path: '/tmp/b.ts', kind: 'add' },
    ],
  })

  assert.deepEqual(calls, [
    {
      name: 'edit',
      args: { file_path: '/tmp/a.ts' },
      durationMs: 0,
      resultPreview: 'update',
      failed: false,
    },
    {
      name: 'edit',
      args: { file_path: '/tmp/b.ts' },
      durationMs: 0,
      resultPreview: 'add',
      failed: false,
    },
  ])
})

test('codexTimeoutMs: uses quick timeout for recovery/meta pings', () => {
  assert.equal(
    codexTimeoutMs({ userMessage: "Where'd ya go, did token limits choke you", extraText: '' }),
    120_000,
  )
  assert.deepEqual(
    codexWatchdogPolicy({ userMessage: "Where'd ya go, did token limits choke you", extraText: '' }),
    { idleTimeoutMs: 120_000, hardTimeoutMs: 120_000, quick: true },
  )
})

test('codexTimeoutMs: keeps long timeout for actionable hang repairs', () => {
  assert.equal(
    codexTimeoutMs({ userMessage: 'gpt keeps pooping out mid-turn for some reason, squash that bug', extraText: '' }),
    2_700_000,
  )
  assert.equal(
    codexTimeoutMs({ userMessage: 'you got hung again, solve the mid-flight death first', extraText: '' }),
    2_700_000,
  )
  assert.deepEqual(
    codexWatchdogPolicy({ userMessage: 'gpt keeps pooping out mid-turn for some reason, squash that bug', extraText: '' }),
    { idleTimeoutMs: 600_000, hardTimeoutMs: 2_700_000, quick: false },
  )
})

test('codexTimeoutMs: keeps long timeout for ordinary task turns', () => {
  assert.equal(
    codexTimeoutMs({ userMessage: 'implement live tool trace output and run the tests', extraText: '' }),
    2_700_000,
  )
})

test('codexTimeoutMs: a genuine QUESTION about a hang is not a throwaway ping', () => {
  // These mention hang/stuck words but are real diagnostic requests — they need
  // the full window, else debugging the hang self-sabotages at 120s. (Jeff 2026-07-05)
  assert.equal(
    codexTimeoutMs({ userMessage: 'gpt is hung, can you tell me why?', extraText: '' }),
    2_700_000,
    'question form with "?" should get the full window',
  )
  assert.equal(
    codexTimeoutMs({ userMessage: 'why do you keep getting stuck mid-turn', extraText: '' }),
    2_700_000,
    '"why …" is a real question, not a status poke',
  )
  assert.equal(
    codexTimeoutMs({ userMessage: 'what made you time out on that last one', extraText: '' }),
    2_700_000,
    '"what …" question needs the real window',
  )
})

test('codex process args use direct spawn with the prompt as one inert argv', () => {
  const prompt = 'literal shell text: $(touch /tmp/nope); `also-nope`'
  assert.deepEqual(buildCodexArgs({
    prompt,
    model: 'gpt-test',
    effort: 'high',
    outfile: '/tmp/final.txt',
  }), [
    'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    '-c', 'model="gpt-test"', '-c', 'model_reasoning_effort=high',
    '--json', '-o', '/tmp/final.txt', prompt,
  ])
})

test('codex fresh image args end before the positional prompt', () => {
  const args = buildCodexArgs({
    prompt: 'describe the attached images',
    model: 'gpt-test',
    effort: 'medium',
    outfile: '/tmp/final.txt',
    imagePaths: ['/tmp/one.png', '/tmp/two.jpg'],
  })

  assert.deepEqual(args.slice(-8), [
    '--image', '/tmp/one.png', '--image', '/tmp/two.jpg',
    '--json', '-o', '/tmp/final.txt', 'describe the attached images',
  ])
})

test('codex resume args preserve the session id without a shell wrapper', () => {
  const args = buildCodexArgs({
    prompt: 'continue',
    model: 'gpt-test',
    effort: 'medium',
    outfile: '/tmp/final.txt',
    resumeSessionId: 'session-123',
    imagePaths: ['/tmp/one.png', '/tmp/two.jpg'],
  })
  assert.deepEqual(args.slice(0, 5), [
    'exec', 'resume', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', '-c',
  ])
  assert.deepEqual(args.slice(-9), [
    '--image', '/tmp/one.png', '--image', '/tmp/two.jpg',
    '--json', '-o', '/tmp/final.txt', 'session-123', 'continue',
  ])
})

test('codexTimeoutMs: bare status pokes still fail fast', () => {
  // No question, no work verb — just "are you alive" noise. Keep these quick.
  for (const m of ['you alive?', 'ping', 'where did you go', 'you pooping out again lol']) {
    assert.equal(codexTimeoutMs({ userMessage: m, extraText: '' }), 120_000, `bare poke: ${m}`)
  }
})
