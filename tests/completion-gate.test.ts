import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  completionContinuationPrompt,
  isNonTerminalActionReply,
  MAX_COMPLETION_CONTINUATIONS,
} from '../src/completion-gate.ts'

test('completion gate rejects the todo-pass progress final from the incident', () => {
  assert.equal(isNonTerminalActionReply(
    'Yep. I\'m treating it as a workflow pass. I\'m auditing the current task flow against it now.',
  ), true)
})

test('completion gate rejects common promises and ongoing execution claims', () => {
  for (const reply of [
    'On it.',
    'I\'ll fix that next.',
    'I am working through the deployment now.',
    'We\'re running the full test suite.',
    'Next I\'m going to inspect the live bundle.',
  ]) assert.equal(isNonTerminalActionReply(reply), true, reply)
})

test('completion gate accepts completed work, answers, and concrete blockers', () => {
  for (const reply of [
    'Done. The completion gate now resumes progress-only finals; 472 tests passed.',
    'The service is active and the deployed SHA matches origin.',
    'The auditing pass is complete and the todo spec is saved.',
    'The two channels have separate context windows.',
    'Blocked: the migration needs Jeff to choose which real database is authoritative.',
  ]) assert.equal(isNonTerminalActionReply(reply), false, reply)
})

test('completion continuation preserves one bounded harness policy', () => {
  assert.equal(MAX_COMPLETION_CONTINUATIONS, 2)
  const prompt = completionContinuationPrompt(1)
  assert.match(prompt, /same requested task/i)
  assert.match(prompt, /do not repeat/i)
  assert.match(prompt, /completed result|concrete blocker/i)
})
