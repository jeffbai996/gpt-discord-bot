/**
 * OpenAI Realtime API client (voice-to-voice brain).
 *
 * A thin WebSocket client to `wss://api.openai.com/v1/realtime`. Plays the role
 * gem-voice's GeminiLiveSession plays, but pure OpenAI: stream PCM16 24k mono in
 * (input_audio_buffer.append), receive PCM16 24k mono audio deltas out, with
 * server-side VAD driving turn-taking + barge-in.
 *
 * Protocol logic (building outgoing events, parsing incoming ones) is factored
 * into pure functions so it unit-tests without a live socket — only connect()
 * touches the network.
 *
 * Emits: 'open', 'audio'(Buffer pcm24mono), 'speechStarted' (barge-in),
 *        'transcript'(string), 'toolCall'(ToolCall), 'responseDone',
 *        'error'(Error), 'close'.
 */

import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime'
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin'

export interface RealtimeTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface RealtimeOptions {
  apiKey: string
  model?: string
  voice?: string
  instructions?: string
  tools?: RealtimeTool[]
}

export interface ToolCall {
  callId: string
  name: string
  argsJson: string
}

/** Build the session.update payload — GA Realtime shape (the beta shape, with
 *  flat input_audio_format / modalities, is no longer supported). Probe-verified
 *  2026-06-22: this returns `session.updated` against /v1/realtime. */
export function buildSessionUpdate(o: {
  voice: string; instructions?: string; tools?: RealtimeTool[]
}): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: o.instructions ?? '',
      audio: {
        // 24k mono PCM both ways — matches the audio-bridge output/input.
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          // Server VAD: OpenAI detects speech start/stop, drives turn-taking +
          // barge-in (speech_started while the model talks = user interrupted).
          turn_detection: { type: 'server_vad', create_response: true },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: o.voice,
        },
      },
      ...(o.tools && o.tools.length
        ? { tools: o.tools, tool_choice: 'auto' }
        : {}),
    },
  }
}

export function buildAudioAppend(pcm24Mono: Buffer): Record<string, unknown> {
  return { type: 'input_audio_buffer.append', audio: pcm24Mono.toString('base64') }
}

export function buildToolOutput(callId: string, output: unknown): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: typeof output === 'string' ? output : JSON.stringify(output),
    },
  }
}

/**
 * Parse one server event into a (kind, payload) the session can act on.
 * Pure — no emit — so it tests directly. Returns null for events we ignore.
 */
export function parseServerEvent(raw: string | Buffer):
  | { kind: 'audio'; audio: Buffer }
  | { kind: 'speechStarted' }
  | { kind: 'transcript'; text: string }
  | { kind: 'toolCall'; call: ToolCall }
  | { kind: 'responseDone' }
  | { kind: 'speechStopped' }
  | { kind: 'error'; error: Error }
  | null {
  let msg: any
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    return { kind: 'error', error: new Error('realtime: unparseable server event') }
  }
  switch (msg.type) {
    case 'response.audio.delta':
    case 'response.output_audio.delta':
      return { kind: 'audio', audio: Buffer.from(msg.delta ?? '', 'base64') }
    case 'input_audio_buffer.speech_started':
      return { kind: 'speechStarted' }
    case 'input_audio_buffer.speech_stopped':
      // User finished — the model is now "thinking" until its first audio chunk.
      return { kind: 'speechStopped' }
    case 'response.audio_transcript.delta':
    case 'response.output_audio_transcript.delta':
      return { kind: 'transcript', text: msg.delta ?? '' }
    case 'response.function_call_arguments.done':
      return {
        kind: 'toolCall',
        call: { callId: msg.call_id, name: msg.name, argsJson: msg.arguments ?? '{}' },
      }
    case 'response.done':
      return { kind: 'responseDone' }
    case 'error':
      return { kind: 'error', error: new Error(msg.error?.message ?? 'realtime error') }
    default:
      return null
  }
}

export class RealtimeSession extends EventEmitter {
  private ws?: WebSocket
  private readonly opts: Required<Omit<RealtimeOptions, 'instructions' | 'tools'>> &
    Pick<RealtimeOptions, 'instructions' | 'tools'>

  constructor(opts: RealtimeOptions) {
    super()
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? DEFAULT_MODEL,
      voice: opts.voice ?? DEFAULT_VOICE,
      instructions: opts.instructions,
      tools: opts.tools,
    }
  }

  async connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.opts.model)}`
    // GA Realtime: just the bearer token. The old `OpenAI-Beta: realtime=v1`
    // header opts into the beta API, which now hard-errors ("Beta API is no
    // longer supported. Please use /v1/realtime for the GA API").
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    })
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    this.send(buildSessionUpdate({
      voice: this.opts.voice,
      instructions: this.opts.instructions,
      tools: this.opts.tools,
    }))
    ws.on('message', (data) => this.dispatch(data as Buffer))
    ws.on('close', () => this.emit('close'))
    ws.on('error', (e) => this.emit('error', e))
    this.emit('open')
  }

  /** Route a raw server frame to the matching emitted event. Public for tests. */
  dispatch(raw: string | Buffer): void {
    const ev = parseServerEvent(raw)
    if (!ev) return
    switch (ev.kind) {
      case 'audio': this.emit('audio', ev.audio); break
      case 'speechStarted': this.emit('speechStarted'); break
      case 'speechStopped': this.emit('speechStopped'); break
      case 'transcript': this.emit('transcript', ev.text); break
      case 'toolCall': this.emit('toolCall', ev.call); break
      case 'responseDone': this.emit('responseDone'); break
      case 'error': this.emit('error', ev.error); break
    }
  }

  appendAudio(pcm24Mono: Buffer): void {
    this.send(buildAudioAppend(pcm24Mono))
  }

  sendToolResponse(callId: string, output: unknown): void {
    this.send(buildToolOutput(callId, output))
    this.send({ type: 'response.create' })
  }

  cancelResponse(): void {
    this.send({ type: 'response.cancel' })
  }

  /** JSON-encode + send. No-op (not error) if the socket isn't open, so a
   * late frame after teardown doesn't crash the session. */
  protected send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  close(): void {
    try { this.ws?.close() } catch { /* already closing */ }
  }
}
