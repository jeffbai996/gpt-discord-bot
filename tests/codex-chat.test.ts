import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveEvent } from '../src/codex-chat.ts'

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
