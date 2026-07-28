import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSteeredMessage, steeredMarker } from '../src/steering.ts'

test('replaces the live header with a white steering status', () => {
  assert.equal(steeredMarker(125_000), '↪ **Steered after 2m 5s**')
  assert.equal(
    renderSteeredMessage('💭 ✻ **thinking with low effort…**\nInspecting files.', 10_000),
    '↪ **Steered after 10s**\nInspecting files.',
  )
})
