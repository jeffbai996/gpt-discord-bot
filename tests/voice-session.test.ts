import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VoiceSession } from '../src/voice/session.ts'

class FakeRealtime extends EventEmitter {
  readonly appended: Buffer[] = []
  readonly truncations: Array<{ itemId: string; contentIndex: number; audioEndMs: number }> = []

  constructor(private readonly events: string[]) { super() }

  async connect(): Promise<void> {
    this.events.push('realtime connected')
  }

  appendAudio(pcm: Buffer): void { this.appended.push(pcm) }
  truncateResponse(itemId: string, contentIndex: number, audioEndMs: number): void {
    this.truncations.push({ itemId, contentIndex, audioEndMs })
  }
  close(): void {}
}

class FakePlayer extends EventEmitter {
  readonly played: unknown[] = []

  play(resource: unknown): void { this.played.push(resource) }
  stop(): void {}
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
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

test('voice session appends a silence tail after Discord closes an utterance', async () => {
  const speaking = new EventEmitter()
  const opus = new PassThrough()
  const decoder = new PassThrough()
  const realtime = new FakeRealtime([])
  const connection = {
    receiver: { speaking, subscribe: () => opus },
    subscribe: () => undefined,
    destroy: () => undefined,
  }

  const session = new VoiceSession(
    { apiKey: 'test' },
    {
      createRealtime: () => realtime as any,
      joinVoice: () => connection as any,
      waitForVoiceReady: async () => undefined,
      createPlayer: () => new FakePlayer() as any,
      createDecoder: () => decoder as any,
    },
  )

  await session.join({
    id: 'voice-1',
    guild: { id: 'guild-1', voiceAdapterCreator: {} },
  } as any)
  speaking.emit('start', 'user-1')
  opus.end(Buffer.alloc(3840, 1)) // one 20ms Discord PCM frame after fake decode
  await nextTick()

  assert.equal(realtime.appended.length, 2)
  assert.equal(realtime.appended[0].length, 960)
  assert.equal(realtime.appended[1].length, 38_400)
  assert.ok(realtime.appended[1].every(byte => byte === 0))
  session.leave()
})

test('voice session warms the Discord playback path before the first reply', async () => {
  const speaking = new EventEmitter()
  const player = new FakePlayer()
  const resources: Array<{ stream: unknown; inputType: unknown }> = []
  const connection = {
    receiver: { speaking, subscribe: () => new PassThrough() },
    subscribe: () => undefined,
    destroy: () => undefined,
  }

  const session = new VoiceSession(
    { apiKey: 'test' },
    {
      createRealtime: () => new FakeRealtime([]) as any,
      joinVoice: () => connection as any,
      waitForVoiceReady: async () => undefined,
      createPlayer: () => player as any,
      createDecoder: () => new PassThrough() as any,
      createResource: ((stream: unknown, options: { inputType: unknown }) => {
        const resource = { stream, inputType: options.inputType }
        resources.push(resource)
        return resource
      }) as any,
    },
  )

  await session.join({
    id: 'voice-1',
    guild: { id: 'guild-1', voiceAdapterCreator: {} },
  } as any)

  assert.equal(resources.length, 1)
  assert.equal(player.played.length, 1)
  assert.equal(player.played[0], resources[0])
  session.leave()
})

test('barge-in truncates model history to the audio Discord had time to play', async () => {
  const speaking = new EventEmitter()
  const player = new FakePlayer()
  const realtime = new FakeRealtime([])
  let now = 1_000
  const connection = {
    receiver: { speaking, subscribe: () => new PassThrough() },
    subscribe: () => undefined,
    destroy: () => undefined,
  }

  const session = new VoiceSession(
    { apiKey: 'test' },
    {
      createRealtime: () => realtime as any,
      joinVoice: () => connection as any,
      waitForVoiceReady: async () => undefined,
      createPlayer: () => player as any,
      createDecoder: () => new PassThrough() as any,
      createResource: ((stream: unknown) => ({ stream })) as any,
      now: () => now,
    },
  )

  await session.join({
    id: 'voice-1',
    guild: { id: 'guild-1', voiceAdapterCreator: {} },
  } as any)
  realtime.emit(
    'audio',
    Buffer.alloc(48_000), // one second of 24kHz mono PCM16
    { itemId: 'item_audio', contentIndex: 0 },
  )
  now = 1_600
  realtime.emit('speechStarted')

  assert.deepEqual(realtime.truncations, [{
    itemId: 'item_audio', contentIndex: 0, audioEndMs: 600,
  }])
  session.leave()
})
