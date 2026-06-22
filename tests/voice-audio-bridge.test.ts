import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  discordToOpenAI, openAIToDiscord, resampleLinear, _internals,
} from '../src/voice/audio-bridge.ts'

const { readSamples, writeSamples, downmixStereoToMono, upmixMonoToStereo, clampInt16 } = _internals

test('clampInt16 clamps to the PCM16 range', () => {
  assert.equal(clampInt16(40000), 32767)
  assert.equal(clampInt16(-40000), -32768)
  assert.equal(clampInt16(100), 100)
})

test('downmix averages L/R; upmix duplicates', () => {
  assert.deepEqual(downmixStereoToMono([100, 200, -50, 50]), [150, 0])
  assert.deepEqual(upmixMonoToStereo([10, 20]), [10, 10, 20, 20])
})

test('writeSamples/readSamples round-trip PCM16LE', () => {
  const s = [0, 1, -1, 32767, -32768, 1234]
  assert.deepEqual(readSamples(writeSamples(s)), s)
})

test('resampleLinear 48k->24k halves; 24k->48k doubles', () => {
  const in48 = Array.from({ length: 480 }, (_, i) => i % 100)
  assert.equal(resampleLinear(in48, 48000, 24000).length, 240)
  const in24 = Array.from({ length: 240 }, (_, i) => i % 100)
  assert.equal(resampleLinear(in24, 24000, 48000).length, 480)
})

test('resampleLinear preserves a constant (DC) signal', () => {
  const dc = new Array(200).fill(777)
  const up = resampleLinear(dc, 24000, 48000)
  assert.ok(up.every(v => v === 777), 'constant must stay constant through resample')
})

test('discordToOpenAI: 48k stereo -> 24k mono shrinks bytes 4x', () => {
  // 240 stereo frames = 480 samples = 960 bytes @48k stereo
  const stereo = writeSamples(Array.from({ length: 480 }, (_, i) => (i % 2 ? 50 : 150)))
  const out = discordToOpenAI(stereo)
  // 240 mono@48k -> 120 mono@24k -> 240 bytes. 960 / 4 = 240.
  assert.equal(out.length, stereo.length / 4)
})

test('openAIToDiscord: 24k mono -> 48k stereo grows bytes 4x', () => {
  const mono = writeSamples(new Array(120).fill(500)) // 240 bytes
  const out = openAIToDiscord(mono)
  // 120 mono@24k -> 240 mono@48k -> 480 stereo -> 960 bytes. 240 * 4 = 960.
  assert.equal(out.length, mono.length * 4)
})

test('round trip openAI->discord->openAI preserves a constant tone', () => {
  // A constant mono signal: up to discord (resample+dup) then back (downmix L==R,
  // resample) must return the same constant — proves both directions compose.
  const mono24 = writeSamples(new Array(240).fill(1000))
  const back = discordToOpenAI(openAIToDiscord(mono24))
  const samples = readSamples(back)
  assert.ok(samples.length > 0)
  assert.ok(samples.every(v => v === 1000), 'constant tone must survive the round trip')
})
