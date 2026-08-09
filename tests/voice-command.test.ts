import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SlashCommandBuilder } from 'discord.js'

import {
  addVoiceGroup,
  buildVoiceInstructions,
  executeVoiceCommand,
  formatRecentConversation,
} from '../src/voice/command.ts'
import {
  BUILTIN_DEFAULT_REALTIME_VOICE,
  getVoicePref,
  REALTIME_VOICE_CHOICES,
  resolveRealtimeVoice,
  setVoicePref,
} from '../src/voice/voices.ts'
import {
  BUILTIN_DEFAULT_REALTIME_MODEL,
  getRealtimeModelPref,
  REALTIME_MODEL_CHOICES,
  resolveRealtimeModel,
  setRealtimeModelPref,
} from '../src/voice/models.ts'

test('voice defaults to British Ballad unless config or persisted preference overrides it', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-voice-pref-'))
  assert.equal(BUILTIN_DEFAULT_REALTIME_VOICE, 'ballad')
  assert.equal(getVoicePref(stateDir), 'ballad')
  assert.equal(getVoicePref(stateDir, 'cedar'), 'cedar')

  setVoicePref('coral', stateDir)
  assert.equal(getVoicePref(stateDir, 'cedar'), 'coral')
  assert.equal(resolveRealtimeVoice(null, 'cedar', stateDir), 'coral')
  assert.equal(resolveRealtimeVoice('marin', 'cedar', stateDir), 'marin')
  assert.throws(() => setVoicePref('fake-voice', stateDir), /unknown voice/)
})

test('voice model defaults to Realtime 2.1 mini unless config or persisted preference overrides it', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-voice-model-pref-'))
  assert.equal(BUILTIN_DEFAULT_REALTIME_MODEL, 'gpt-realtime-2.1-mini')
  assert.equal(getRealtimeModelPref(stateDir), 'gpt-realtime-2.1-mini')
  assert.equal(getRealtimeModelPref(stateDir, 'gpt-realtime-2.1'), 'gpt-realtime-2.1')

  setRealtimeModelPref('gpt-realtime-2.1', stateDir)
  assert.equal(getRealtimeModelPref(stateDir, 'gpt-realtime-2.1-mini'), 'gpt-realtime-2.1')
  assert.equal(resolveRealtimeModel(null, 'gpt-realtime-2.1-mini', stateDir), 'gpt-realtime-2.1')
  assert.equal(resolveRealtimeModel('gpt-realtime-2.1-mini', 'gpt-realtime-2.1', stateDir), 'gpt-realtime-2.1-mini')
  assert.throws(() => setRealtimeModelPref('gpt-realtime-potato', stateDir), /unknown realtime model/)
})

test('/gpt voice type exposes the same dedicated picker shape as /gemini voice type', () => {
  const command = new SlashCommandBuilder().setName('gpt').setDescription('test')
  addVoiceGroup(command as any)

  const voiceGroup = (command.toJSON().options as any[]).find(option => option.name === 'voice')
  const join = voiceGroup.options.find((option: any) => option.name === 'join')
  const type = voiceGroup.options.find((option: any) => option.name === 'type')
  const model = voiceGroup.options.find((option: any) => option.name === 'model')
  const picker = type.options.find((option: any) => option.name === 'voice')
  const modelPicker = model.options.find((option: any) => option.name === 'model')

  assert.deepEqual(join.options, [])
  assert.equal(picker.required, true)
  assert.deepEqual(
    picker.choices.map((choice: any) => ({ name: choice.name, value: choice.value })),
    REALTIME_VOICE_CHOICES.map(choice => ({ name: choice.label, value: choice.value })),
  )
  assert.equal(modelPicker.required, true)
  assert.deepEqual(
    modelPicker.choices.map((choice: any) => ({ name: choice.name, value: choice.value })),
    REALTIME_MODEL_CHOICES.map(choice => ({ name: choice.label, value: choice.value })),
  )
})

test('recent voice context is chronological, bounded per message, and labeled', () => {
  const tail = formatRecentConversation([
    { author: 'alice', content: 'first' },
    { author: 'bob', content: 'x'.repeat(400) },
  ])
  const instructions = buildVoiceInstructions('persona rules', tail)

  assert.match(instructions, /^persona rules/)
  assert.match(instructions, /Recent conversation in this channel \(newest last\)/)
  assert.ok(instructions.indexOf('alice: first') < instructions.indexOf('bob:'))
  assert.equal(tail.split('\n')[1].length, 300)
})

test('voice instructions omit the recent-context section when history is unavailable', () => {
  assert.equal(buildVoiceInstructions('persona rules', ''), 'persona rules')
})

test('voice type persists the selected voice for subsequent calls', async () => {
  const replies: any[] = []
  const interaction = {
    user: { id: 'owner' },
    guildId: 'guild-1',
    options: {
      getSubcommand: () => 'type',
      getString: () => 'coral',
    },
    reply: async (message: unknown) => { replies.push(message) },
  }

  await executeVoiceCommand(
    interaction as any,
    {} as any,
    'owner',
    {} as any,
    {} as any,
    { getVoice: () => 'marin', setVoice: voice => assert.equal(voice, 'coral') },
  )

  assert.match(replies[0].content, /voice → \*\*coral\*\*/)
  assert.match(replies[0].content, /was \*\*marin\*\*/)
  assert.match(replies[0].content, /next call/)
})

test('voice model persists the selected model for subsequent calls', async () => {
  const replies: any[] = []
  const interaction = {
    user: { id: 'owner' },
    guildId: 'guild-1',
    options: {
      getSubcommand: () => 'model',
      getString: () => 'gpt-realtime-2.1',
    },
    reply: async (message: unknown) => { replies.push(message) },
  }

  await executeVoiceCommand(
    interaction as any,
    {} as any,
    'owner',
    {} as any,
    {} as any,
    {
      getModel: () => 'gpt-realtime-2.1-mini',
      setModel: model => assert.equal(model, 'gpt-realtime-2.1'),
    },
  )

  assert.match(replies[0].content, /model → \*\*gpt-realtime-2\.1\*\*/)
  assert.match(replies[0].content, /was \*\*gpt-realtime-2\.1-mini\*\*/)
  assert.match(replies[0].content, /next call/)
})

test('voice join passes the persisted voice, model, and chronological Discord tail into the session', async () => {
  let joinOverrides: any
  const manager = {
    join: async (_guildId: string, _channel: unknown, overrides: unknown) => {
      joinOverrides = overrides
    },
    leave: () => false,
  }
  const interaction = {
    user: { id: 'owner' },
    guildId: 'guild-1',
    channelId: 'text-1',
    member: { voice: { channel: { name: 'Lounge' } } },
    channel: {
      messages: {
        fetch: async () => new Map([
          ['new', { author: { username: 'bob' }, cleanContent: 'newest' }],
          ['old', { author: { username: 'alice' }, cleanContent: 'older' }],
        ]),
      },
    },
    options: {
      getSubcommand: () => 'join',
      getString: () => null,
    },
    reply: async () => {},
    editReply: async () => {},
  }
  const persona = { buildSystemPrompt: () => 'persona rules' }
  const tools = { toRealtimeTools: () => [], dispatch: async () => null }

  await executeVoiceCommand(
    interaction as any,
    manager as any,
    'owner',
    persona as any,
    tools as any,
    { getVoice: () => 'coral', getModel: () => 'gpt-realtime-2.1' },
  )

  assert.equal(joinOverrides.voice, 'coral')
  assert.equal(joinOverrides.model, 'gpt-realtime-2.1')
  assert.match(joinOverrides.instructions, /^persona rules/)
  assert.ok(joinOverrides.instructions.indexOf('alice: older') < joinOverrides.instructions.indexOf('bob: newest'))
})
