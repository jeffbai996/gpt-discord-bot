import assert from 'node:assert/strict'
import test from 'node:test'
import { presetPatch } from '../src/presets.ts'

test('quiet only changes presentation flags', () => {
  assert.deepEqual(presetPatch('quiet'), { thinking: 'off', trace: 'off', counter: 'off' })
})

test('deep selects the full codex surface', () => {
  assert.deepEqual(presetPatch('deep'), {
    thinking: 'collapse', trace: 'on', counter: 'both', reasoning: 'max', engine: 'codex',
  })
})
