import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexAgentRegistry,
  appendAgentsPanel,
  renderAgentsPanel,
} from '../src/codex-agents.ts'

test('tracks a spawned agent through child metadata, tokens, and completion', () => {
  const registry = new CodexAgentRegistry('root-thread', 1_000)

  registry.consumeRoot({
    timestamp: '2026-08-02T21:51:12.589Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      namespace: 'collaboration',
      name: 'spawn_agent',
      call_id: 'spawn-1',
      arguments: JSON.stringify({
        task_name: 'probe',
        model: 'gpt-5.6-terra',
        reasoning_effort: 'low',
      }),
    },
  })
  registry.consumeRoot({
    timestamp: '2026-08-02T21:51:12.699Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'spawn-1',
      output: JSON.stringify({ task_name: '/root/probe' }),
    },
  })
  registry.consumeChild('child-thread', {
    timestamp: '2026-08-02T21:51:12.700Z',
    type: 'session_meta',
    payload: {
      id: 'child-thread',
      parent_thread_id: 'root-thread',
      agent_path: '/root/probe',
      agent_nickname: 'James',
    },
  })
  registry.consumeChild('child-thread', {
    type: 'turn_context',
    payload: { model: 'gpt-5.6-terra' },
  })
  registry.consumeChild('child-thread', {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 23_162 } },
    },
  })
  registry.consumeChild('child-thread', {
    timestamp: '2026-08-02T21:51:15.675Z',
    type: 'event_msg',
    payload: { type: 'task_complete' },
  })

  assert.deepEqual(registry.snapshot(), [{
    id: 'child-thread',
    path: '/root/probe',
    label: 'probe',
    nickname: 'James',
    model: 'gpt-5.6-terra',
    status: 'done',
    startedAt: Date.parse('2026-08-02T21:51:12.589Z'),
    endedAt: Date.parse('2026-08-02T21:51:15.675Z'),
    tokens: 23_162,
  }])
})

test('keeps nested agents whose parent belongs to the same root workflow', () => {
  const registry = new CodexAgentRegistry('root-thread', 1_000)

  registry.consumeChild('child-1', {
    timestamp: '2026-08-02T21:51:12.700Z',
    type: 'session_meta',
    payload: {
      id: 'child-1',
      parent_thread_id: 'root-thread',
      agent_path: '/root/reviewer',
    },
  })
  registry.consumeChild('child-2', {
    timestamp: '2026-08-02T21:51:13.700Z',
    type: 'session_meta',
    payload: {
      id: 'child-2',
      parent_thread_id: 'child-1',
      agent_path: '/root/reviewer/tests',
    },
  })

  assert.deepEqual(registry.threadIds(), ['root-thread', 'child-1', 'child-2'])
  assert.deepEqual(registry.snapshot().map(agent => agent.label), ['reviewer', 'tests'])
})

test('turn completion records both final usage and terminal state', () => {
  const registry = new CodexAgentRegistry('root-thread', 1_000)
  registry.consumeChild('child-1', {
    timestamp: '2026-08-02T21:51:12.700Z',
    type: 'session_meta',
    payload: {
      id: 'child-1',
      parent_thread_id: 'root-thread',
      agent_path: '/root/reviewer',
    },
  })

  registry.consumeChild('child-1', {
    timestamp: '2026-08-02T21:51:15.700Z',
    type: 'turn.completed',
    usage: { input_tokens: 1_200, output_tokens: 34 },
  })

  assert.match(JSON.stringify(registry.snapshot()), /"status":"done"/)
  assert.equal(registry.snapshot()[0].tokens, 1_234)
})

test('reconciles child-first registration with delayed and replayed spawn events', () => {
  const registry = new CodexAgentRegistry('root-thread', 1_000)
  registry.consumeChild('child-1', {
    timestamp: '2026-08-02T21:51:12.700Z',
    type: 'session_meta',
    payload: {
      id: 'child-1',
      parent_thread_id: 'root-thread',
      agent_path: '/root/todo_audit',
    },
  })

  const spawn = {
    timestamp: '2026-08-02T21:51:12.589Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      namespace: 'collaboration',
      name: 'spawn_agent',
      call_id: 'spawn-1',
      arguments: JSON.stringify({ task_name: 'todo_audit', model: 'gpt-5.6-terra' }),
    },
  }
  registry.consumeRoot(spawn)
  registry.consumeRoot(spawn)
  registry.consumeRoot({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'spawn-1',
      output: JSON.stringify({ task_name: '/root/todo_audit' }),
    },
  })

  assert.equal(registry.snapshot().length, 1)
  assert.deepEqual(registry.snapshot()[0], {
    id: 'child-1',
    path: '/root/todo_audit',
    label: 'todo_audit',
    nickname: '',
    model: 'gpt-5.6-terra',
    status: 'running',
    startedAt: Date.parse('2026-08-02T21:51:12.700Z'),
    endedAt: undefined,
    tokens: 0,
  })
})

test('subtracts inherited fork history from child token usage', () => {
  const registry = new CodexAgentRegistry('root-thread', 1_000)
  registry.consumeChild('child-1', {
    type: 'session_meta',
    payload: {
      id: 'child-1',
      parent_thread_id: 'root-thread',
      agent_path: '/root/todo_audit',
    },
  })

  // Forked rollouts replay prior turns before starting the child's real task.
  registry.consumeChild('child-1', { type: 'event_msg', payload: { type: 'task_started' } })
  registry.consumeChild('child-1', {
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 37_225 } } },
  })
  registry.consumeChild('child-1', { type: 'event_msg', payload: { type: 'task_complete' } })
  registry.consumeChild('child-1', { type: 'event_msg', payload: { type: 'task_started' } })
  registry.consumeChild('child-1', {
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 78_831 } } },
  })

  // The final task_started is the child's own turn, so 78,831 is its baseline.
  registry.consumeChild('child-1', { type: 'event_msg', payload: { type: 'task_started' } })
  registry.consumeChild('child-1', { type: 'inter_agent_communication_metadata' })
  registry.consumeChild('child-1', {
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 630_951 } } },
  })

  assert.equal(registry.snapshot()[0].status, 'running')
  assert.equal(registry.snapshot()[0].tokens, 552_120)

  // A later follow-up remains part of this child's lifetime usage.
  registry.consumeChild('child-1', { type: 'event_msg', payload: { type: 'task_complete' } })
  registry.consumeChild('child-1', { type: 'event_msg', payload: { type: 'task_started' } })
  registry.consumeChild('child-1', {
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1_500_000 } } },
  })
  assert.equal(registry.snapshot()[0].tokens, 1_421_169)
})

test('renders a compact blinking Discord code-block panel', () => {
  const panel = renderAgentsPanel([
    {
      id: 'one', path: '/root/inspect', label: 'inspect event stream', nickname: '',
      model: 'gpt-5.6-terra', status: 'running', startedAt: 1_000, tokens: 8_200,
    },
    {
      id: 'two', path: '/root/tests', label: 'review tests', nickname: '',
      model: 'gpt-5.6-sol', status: 'done', startedAt: 1_000, endedAt: 25_000,
      tokens: 17_100,
    },
  ], 31_000, 1)

  assert.match(panel, /^```\n◓ agents · gpt · 1 running · 1 done · 25\.3k tok/)
  assert.match(panel, /◉  inspect event stream  terra  30s\s+8\.2k/)
  assert.match(panel, /●  review tests\s+sol\s+24s\s+17\.1k/)
  assert.match(panel, /\n```$/)
})

test('appends the agents panel below the final tool-trace card', () => {
  const agents = [{
    id: 'one', path: '/root/probe', label: 'probe', nickname: '',
    model: 'gpt-5.6-terra', status: 'running' as const, startedAt: 1_000, tokens: 0,
  }]
  const cards = appendAgentsPanel(['trace one', 'trace two'], agents, 2_000, 0)

  assert.deepEqual(cards.slice(0, -1), ['trace one'])
  assert.match(cards.at(-1) ?? '', /^trace two\n```\n◐ agents/)
})

test('uses a standalone card when a combined Discord message would overflow', () => {
  const agents = [{
    id: 'one', path: '/root/probe', label: 'probe', nickname: '',
    model: 'gpt-5.6-terra', status: 'running' as const, startedAt: 1_000, tokens: 0,
  }]
  const longCard = 'x'.repeat(1_980)
  const cards = appendAgentsPanel([longCard], agents, 2_000, 0)

  assert.equal(cards.length, 2)
  assert.equal(cards[0], longCard)
  assert.match(cards[1], /^```\n◐ agents/)
  assert.ok(cards.every(card => card.length <= 2_000))
})
