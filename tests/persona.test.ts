import assert from 'node:assert/strict'
import test from 'node:test'

import { PersonaLoader } from '../src/persona.ts'

test('system prompt describes automatic API routing as postmortem-only', () => {
  const prompt = new PersonaLoader().buildSystemPrompt('channel-1')

  assert.match(prompt, /Never claim that shell, filesystem, browser, or write access was lost/)
  assert.match(prompt, /Image attachments are accepted by the normal Codex engine/)
  assert.match(prompt, /postmortem-only/)
  assert.match(prompt, /must never continue or claim completion/)
  assert.match(prompt, /Do not invent a permanent capability limitation/)
})
