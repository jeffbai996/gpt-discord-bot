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
import { BUILTIN_DEFAULT_REALTIME_VOICE } from './voices.ts'
import { BUILTIN_DEFAULT_REALTIME_MODEL } from './models.ts'

const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || BUILTIN_DEFAULT_REALTIME_MODEL
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || BUILTIN_DEFAULT_REALTIME_VOICE
const SESSION_UPDATE_TIMEOUT_MS = 10_000

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

export interface AudioChunkMeta {
  itemId?: string
  contentIndex: number
}

function realtimeErrorMessage(msg: any): string {
  const message = msg?.error?.message ?? 'realtime error'
  const code = msg?.error?.code
  const param = msg?.error?.param
  const details = [code, param].filter(Boolean).join(' · ')
  return details ? `${message} (${details})` : message
}

/**
 * Send session.update only after the acknowledgement listener is installed,
 * then wait until the server accepts it. A WebSocket "open" means transport is
 * up; it does not mean the requested model/audio configuration is valid.
 */
export function waitForSessionUpdated(
  socket: EventEmitter,
  sendUpdate: () => void,
  timeoutMs = SESSION_UPDATE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const finish = (error?: Error) => {
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onMessage = (raw: unknown) => {
      let msg: any
      try {
        const text = typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Buffer.from(raw as ArrayBuffer).toString('utf8')
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.type === 'session.updated') finish()
      else if (msg.type === 'error') finish(new Error(realtimeErrorMessage(msg)))
    }
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('realtime socket closed before session setup completed'))

    socket.on('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
    timer = setTimeout(
      () => finish(new Error('realtime session setup timed out')),
      timeoutMs,
    )
    try {
      sendUpdate()
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
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
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            // Server VAD owns cancellation. The local Discord player only has
            // to discard buffered audio when speech_started arrives.
            interrupt_response: true,
          },
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

export function buildAudioTruncate(
  itemId: string,
  contentIndex: number,
  audioEndMs: number,
): Record<string, unknown> {
  return {
    type: 'conversation.item.truncate',
    item_id: itemId,
    content_index: contentIndex,
    audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
  }
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

export function buildBackgroundResult(jobId: string, result: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: `[Background Codex job ${jobId} completed]\n${result}\n\nTell the caller the outcome naturally and concisely. Mention failures or blockers plainly.`,
      }],
    },
  }
}

/**
 * Parse one server event into a (kind, payload) the session can act on.
 * Pure — no emit — so it tests directly. Returns null for events we ignore.
 */
export function parseServerEvent(raw: string | Buffer):
  | { kind: 'audio'; audio: Buffer; itemId?: string; contentIndex: number }
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
      return {
        kind: 'audio',
        audio: Buffer.from(msg.delta ?? '', 'base64'),
        itemId: typeof msg.item_id === 'string' ? msg.item_id : undefined,
        contentIndex: Number.isInteger(msg.content_index) ? msg.content_index : 0,
      }
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
      return { kind: 'error', error: new Error(realtimeErrorMessage(msg)) }
    default:
      return null
  }
}

export class RealtimeSession extends EventEmitter {
  private ws?: WebSocket
  private userSpeaking = false
  private responseActive = false
  private pendingToolCalls = 0
  private toolContinuationNeeded = false
  private readonly backgroundQueue: Array<{ jobId: string; result: string }> = []
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
    ws.on('message', (data) => this.dispatch(data as Buffer))
    ws.on('close', () => this.emit('close'))
    ws.on('error', (e) => this.emit('error', e))
    await waitForSessionUpdated(ws, () => this.send(buildSessionUpdate({
      voice: this.opts.voice,
      instructions: this.opts.instructions,
      tools: this.opts.tools,
    })))
    this.emit('open')
  }

  /** Route a raw server frame to the matching emitted event. Public for tests. */
  dispatch(raw: string | Buffer): void {
    const ev = parseServerEvent(raw)
    if (!ev) return
    switch (ev.kind) {
      case 'audio':
        this.emit('audio', ev.audio, {
          itemId: ev.itemId,
          contentIndex: ev.contentIndex,
        } satisfies AudioChunkMeta)
        break
      case 'speechStarted':
        this.userSpeaking = true
        this.emit('speechStarted')
        break
      case 'speechStopped':
        this.userSpeaking = false
        this.responseActive = true // server VAD creates the response automatically
        this.emit('speechStopped')
        break
      case 'transcript': this.emit('transcript', ev.text); break
      case 'toolCall':
        this.pendingToolCalls += 1
        this.emit('toolCall', ev.call)
        break
      case 'responseDone':
        this.responseActive = false
        this.emit('responseDone')
        if (!this.continueAfterTools() && this.pendingToolCalls === 0) {
          this.flushBackgroundQueue()
        }
        break
      case 'error': this.emit('error', ev.error); break
    }
  }

  appendAudio(pcm24Mono: Buffer): void {
    this.send(buildAudioAppend(pcm24Mono))
  }

  truncateResponse(itemId: string, contentIndex: number, audioEndMs: number): void {
    this.send(buildAudioTruncate(itemId, contentIndex, audioEndMs))
  }

  sendToolResponse(callId: string, output: unknown): void {
    this.send(buildToolOutput(callId, output))
    if (this.pendingToolCalls > 0) this.pendingToolCalls -= 1
    this.toolContinuationNeeded = true
    this.continueAfterTools()
  }

  deliverBackgroundResult(jobId: string, result: string): void {
    this.backgroundQueue.push({ jobId, result })
    this.flushBackgroundQueue()
  }

  private flushBackgroundQueue(): void {
    if (this.userSpeaking || this.responseActive) return
    const next = this.backgroundQueue.shift()
    if (!next) return
    this.send(buildBackgroundResult(next.jobId, next.result))
    this.responseActive = true
    this.send({ type: 'response.create' })
  }

  /** Function arguments may finish before their containing response does. Wait
   * for both that response and every parallel tool result before asking for one
   * continuation response. */
  private continueAfterTools(): boolean {
    if (this.responseActive || this.pendingToolCalls > 0 || !this.toolContinuationNeeded) {
      return false
    }
    this.toolContinuationNeeded = false
    this.responseActive = true
    this.send({ type: 'response.create' })
    return true
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
