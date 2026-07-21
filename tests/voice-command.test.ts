import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SlashCommandBuilder } from 'discord.js'

import {
  addVoiceGroup,
  buildVoiceInstructions,
  executeVoiceCommand,
  formatRecentConversation,
} from '../src/voice/command.ts'
import {
  BUILTIN_DEFAULT_REALTIME_VOICE,
  REALTIME_VOICE_CHOICES,
  resolveRealtimeVoice,
} from '../src/voice/voices.ts'

test('voice defaults to British Ballad unless config or join overrides it', () => {
  assert.equal(BUILTIN_DEFAULT_REALTIME_VOICE, 'ballad')
  assert.equal(resolveRealtimeVoice(), 'ballad')
  assert.equal(resolveRealtimeVoice(null, 'cedar'), 'cedar')
  assert.equal(resolveRealtimeVoice('coral', 'cedar'), 'coral')
})

test('/gpt voice join exposes a curated optional voice picker', () => {
  const command = new SlashCommandBuilder().setName('gpt').setDescription('test')
  addVoiceGroup(command as any)

  const voiceGroup = (command.toJSON().options as any[]).find(option => option.name === 'voice')
  const join = voiceGroup.options.find((option: any) => option.name === 'join')
  const picker = join.options.find((option: any) => option.name === 'voice')

  assert.equal(picker.required, false)
  assert.deepEqual(
    picker.choices.map((choice: any) => ({ name: choice.name, value: choice.value })),
    REALTIME_VOICE_CHOICES.map(choice => ({ name: choice.name, value: choice.value })),
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

test('voice join passes the selected voice and chronological Discord tail into the session', async () => {
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
      getString: (name: string) => name === 'voice' ? 'coral' : null,
    },
    reply: async () => {},
    editReply: async () => {},
  }
  const persona = { buildSystemPrompt: () => 'persona rules' }
  const tools = { toRealtimeTools: () => [], dispatch: async () => null }

  await executeVoiceCommand(interaction as any, manager as any, 'owner', persona as any, tools as any)

  assert.equal(joinOverrides.voice, 'coral')
  assert.match(joinOverrides.instructions, /^persona rules/)
  assert.ok(joinOverrides.instructions.indexOf('alice: older') < joinOverrides.instructions.indexOf('bob: newest'))
})
