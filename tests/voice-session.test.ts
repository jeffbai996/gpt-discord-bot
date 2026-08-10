import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VoiceSession } from '../src/voice/session.ts'

class FakeRealtime extends EventEmitter {
  constructor(private readonly events: string[]) { super() }

  async connect(): Promise<void> {
    this.events.push('realtime connected')
  }

  appendAudio(): void {}
  close(): void {}
}

class FakePlayer extends EventEmitter {
  play(): void {}
  stop(): void {}
}

test('voice session connects Realtime before opening the Discord receive path', async () => {
  const events: string[] = []
  const speaking = new EventEmitter()
  const connection = {
    receiver: { speaking, subscribe: () => new PassThrough() },
    subscribe: () => undefined,
    destroy: () => undefined,
  }

  const session = new VoiceSession(
    { apiKey: 'test' },
    {
      createRealtime: () => new FakeRealtime(events) as any,
      joinVoice: () => {
        events.push('discord joined')
        return connection as any
      },
      waitForVoiceReady: async () => { events.push('discord ready') },
      createPlayer: () => new FakePlayer() as any,
      createDecoder: () => new PassThrough() as any,
    },
  )

  await session.join({
    id: 'voice-1',
    guild: { id: 'guild-1', voiceAdapterCreator: {} },
  } as any)

  assert.deepEqual(events, ['realtime connected', 'discord joined', 'discord ready'])
  session.leave()
})

test('voice session subscribes as soon as Discord reports a speaker', async () => {
  const speaking = new EventEmitter()
  const subscribed: string[] = []
  const connection = {
    receiver: {
      speaking,
      subscribe: (userId: string) => {
        subscribed.push(userId)
        return new PassThrough()
      },
    },
    subscribe: () => undefined,
    destroy: () => undefined,
  }

  const session = new VoiceSession(
    { apiKey: 'test' },
    {
      createRealtime: () => new FakeRealtime([]) as any,
      joinVoice: () => connection as any,
      waitForVoiceReady: async () => undefined,
      createPlayer: () => new FakePlayer() as any,
      createDecoder: () => new PassThrough() as any,
    },
  )

  await session.join({
    id: 'voice-1',
    guild: { id: 'guild-1', voiceAdapterCreator: {} },
  } as any)
  speaking.emit('start', 'user-1')

  assert.deepEqual(subscribed, ['user-1'])
  session.leave()
})
