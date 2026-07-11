import assert from 'node:assert/strict'
import test from 'node:test'

import { PersonaLoader } from '../src/persona.ts'

test('system prompt forbids invented capability loss on API-routed turns', () => {
  const prompt = new PersonaLoader().buildSystemPrompt('channel-1')

  assert.match(prompt, /Never claim that shell, filesystem, browser, or write access was lost/)
  assert.match(prompt, /Image attachments are accepted by the normal Codex engine/)
  assert.match(prompt, /specific to that fallback turn/)
  assert.match(prompt, /Do not invent a permanent capability limitation/)
})
