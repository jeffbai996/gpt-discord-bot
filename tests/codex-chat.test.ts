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
