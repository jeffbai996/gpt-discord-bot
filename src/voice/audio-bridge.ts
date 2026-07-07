/**
 * Audio format bridge — the load-bearing seam between Discord and OpenAI.
 *
 * Discord voice is PCM16LE @ 48000 Hz, 2 channels (stereo), interleaved.
 * OpenAI Realtime wants/sends PCM16LE @ 24000 Hz, 1 channel (mono).
 *
 * So every frame crosses a sample-rate + channel-count boundary, twice:
 *   discordToOpenAI:  48k stereo  -> 24k mono   (downmix, then 2:1 resample)
 *   openAIToDiscord:  24k mono    -> 48k stereo (1:2 resample, then mono->stereo)
 *
 * Resampling is linear interpolation (same approach gem-voice took). These are
 * pure Buffer transforms with no I/O, so they unit-test deterministically — the
 * part most likely to be subtly wrong, made the part that's easiest to prove.
 */

const DISCORD_RATE = 48000;
const DISCORD_CHANNELS = 2;
const OPENAI_RATE = 24000;
const OPENAI_CHANNELS = 1;

const BYTES_PER_SAMPLE = 2; // PCM16

function clampInt16(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v | 0;
}

/** Read a PCM16LE buffer into a plain number[] of samples (endian-safe). */
function readSamples(pcm: Buffer): number[] {
  const n = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
  return out;
}

/** Write a number[] of samples to a PCM16LE buffer. */
function writeSamples(samples: number[]): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(clampInt16(samples[i]), i * BYTES_PER_SAMPLE);
  }
  return buf;
}

/** Interleaved stereo [L,R,L,R,...] -> mono via L/R average. */
function downmixStereoToMono(stereo: number[]): number[] {
  const frames = Math.floor(stereo.length / 2);
  const mono = new Array<number>(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = ((stereo[2 * i] + stereo[2 * i + 1]) / 2) | 0;
  }
  return mono;
}

/** Mono -> interleaved stereo by duplicating each sample to L and R. */
function upmixMonoToStereo(mono: number[]): number[] {
  const stereo = new Array<number>(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[2 * i] = mono[i];
    stereo[2 * i + 1] = mono[i];
  }
  return stereo;
}

/**
 * Linear-interpolation resample of a mono sample stream.
 * Output length = round(input.length * outRate / inRate). Edge sample held.
 */
export function resampleLinear(samples: number[], inRate: number, outRate: number): number[] {
  if (inRate === outRate || samples.length === 0) return samples.slice();
  const ratio = inRate / outRate;
  const outLen = Math.round(samples.length / ratio);
  const out = new Array<number>(outLen);
  for (let j = 0; j < outLen; j++) {
    const srcPos = j * ratio;
    const i = Math.floor(srcPos);
    const frac = srcPos - i;
    const a = samples[i] ?? samples[samples.length - 1] ?? 0;
    const b = samples[i + 1] ?? a;
    out[j] = (a + (b - a) * frac) | 0;
  }
  return out;
}

/**
 * Discord (48k stereo PCM16LE) -> OpenAI (24k mono PCM16LE).
 * Downmix to mono first (cheaper to resample one channel), then 48k->24k.
 */
export function discordToOpenAI(pcm48Stereo: Buffer): Buffer {
  const stereo = readSamples(pcm48Stereo);
  const mono48 = downmixStereoToMono(stereo);
  const mono24 = resampleLinear(mono48, DISCORD_RATE, OPENAI_RATE);
  return writeSamples(mono24);
}

/**
 * OpenAI (24k mono PCM16LE) -> Discord (48k stereo PCM16LE).
 * Resample mono 24k->48k, then duplicate to stereo for the AudioPlayer (Raw).
 */
export function openAIToDiscord(pcm24Mono: Buffer): Buffer {
  const mono24 = readSamples(pcm24Mono);
  const mono48 = resampleLinear(mono24, OPENAI_RATE, DISCORD_RATE);
  const stereo48 = upmixMonoToStereo(mono48);
  return writeSamples(stereo48);
}

// Exposed for unit tests.
export const _internals = {
  readSamples, writeSamples, downmixStereoToMono, upmixMonoToStereo, clampInt16,
};
