import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSessionUpdate, buildAudioAppend, buildToolOutput, parseServerEvent,
  RealtimeSession,
} from '../src/voice/realtime.ts'

test('buildSessionUpdate uses the GA shape: audio.{input,output} + VAD + voice', () => {
  const s = buildSessionUpdate({ voice: 'marin', instructions: 'be brief' }) as any
  assert.equal(s.type, 'session.update')
  assert.equal(s.session.type, 'realtime')
  assert.deepEqual(s.session.output_modalities, ['audio'])
  assert.equal(s.session.audio.input.format.type, 'audio/pcm')
  assert.equal(s.session.audio.output.format.type, 'audio/pcm')
  assert.equal(s.session.audio.input.turn_detection.type, 'server_vad')
  assert.equal(s.session.audio.output.voice, 'marin')
  assert.equal(s.session.instructions, 'be brief')
  assert.equal(s.session.tools, undefined) // no tools key when none given
})

test('buildSessionUpdate includes tools + auto choice when provided', () => {
  const s = buildSessionUpdate({
    voice: 'marin',
    tools: [{ type: 'function', name: 'get_time' }],
  }) as any
  assert.equal(s.session.tools.length, 1)
  assert.equal(s.session.tool_choice, 'auto')
})

test('buildAudioAppend base64-encodes the PCM', () => {
  const pcm = Buffer.from([1, 2, 3, 4])
  const m = buildAudioAppend(pcm) as any
  assert.equal(m.type, 'input_audio_buffer.append')
  assert.equal(m.audio, pcm.toString('base64'))
})

test('buildToolOutput shapes a function_call_output item', () => {
  const m = buildToolOutput('call_1', { ok: true }) as any
  assert.equal(m.item.type, 'function_call_output')
  assert.equal(m.item.call_id, 'call_1')
  assert.equal(m.item.output, JSON.stringify({ ok: true }))
})

test('parseServerEvent: audio delta decodes base64', () => {
  const pcm = Buffer.from([9, 8, 7, 6])
  const ev = parseServerEvent(JSON.stringify({
    type: 'response.audio.delta', delta: pcm.toString('base64'),
  }))
  assert.equal(ev?.kind, 'audio')
  assert.deepEqual((ev as any).audio, pcm)
})

test('parseServerEvent: speech_stopped -> speechStopped (drives the thinking cue)', () => {
  assert.equal(parseServerEvent('{"type":"input_audio_buffer.speech_stopped"}')?.kind, 'speechStopped')
})

test('parseServerEvent: speech_started, transcript, response.done', () => {
  assert.equal(parseServerEvent('{"type":"input_audio_buffer.speech_started"}')?.kind, 'speechStarted')
  const t = parseServerEvent('{"type":"response.audio_transcript.delta","delta":"hi"}')
  assert.equal(t?.kind, 'transcript')
  assert.equal((t as any).text, 'hi')
  assert.equal(parseServerEvent('{"type":"response.done"}')?.kind, 'responseDone')
})

test('parseServerEvent: function_call_arguments.done -> toolCall', () => {
  const ev = parseServerEvent(JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'c9', name: 'get_time', arguments: '{"tz":"PST"}',
  }))
  assert.equal(ev?.kind, 'toolCall')
  assert.deepEqual((ev as any).call, { callId: 'c9', name: 'get_time', argsJson: '{"tz":"PST"}' })
})

test('parseServerEvent: error + bad json + unknown', () => {
  assert.equal(parseServerEvent('{"type":"error","error":{"message":"boom"}}')?.kind, 'error')
  assert.equal(parseServerEvent('not json')?.kind, 'error')
  assert.equal(parseServerEvent('{"type":"something.else"}'), null)
})

test('dispatch routes a server frame to the matching emitted event', () => {
  const sess = new RealtimeSession({ apiKey: 'x' })
  const pcm = Buffer.from([4, 4, 2, 2])
  let got: Buffer | null = null
  let bargeIn = false
  sess.on('audio', (b: Buffer) => { got = b })
  sess.on('speechStarted', () => { bargeIn = true })
  sess.dispatch(JSON.stringify({ type: 'response.audio.delta', delta: pcm.toString('base64') }))
  sess.dispatch('{"type":"input_audio_buffer.speech_started"}')
  assert.deepEqual(got, pcm)
  assert.equal(bargeIn, true)
})
