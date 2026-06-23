/**
 * Voice session — wires Discord voice <-> OpenAI Realtime through the bridge.
 *
 *   mic in:   VoiceReceiver opus -> prism OpusDecoder (48k stereo PCM) ->
 *             discordToOpenAI (24k mono) -> RealtimeSession.appendAudio
 *   bot out:  RealtimeSession 'audio' (24k mono) -> openAIToDiscord (48k stereo)
 *             -> playback PassThrough -> AudioPlayer (StreamType.Raw)
 *   barge-in: RealtimeSession 'speechStarted' -> stop playback immediately
 *
 * This layer is almost all live I/O (Discord UDP + the OpenAI socket), so it is
 * thin and obvious — the testable logic (audio math, protocol framing) lives in
 * audio-bridge.ts and realtime.ts, which are unit-tested. A real voice-channel
 * smoke test is the verification step for THIS file.
 */

import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType,
  EndBehaviorType, VoiceConnectionStatus, entersState, NoSubscriberBehavior,
  type VoiceConnection, type AudioPlayer,
} from '@discordjs/voice'
import prism from 'prism-media'
import { PassThrough, Readable } from 'node:stream'
import OpenAI from 'openai'
import type { VoiceBasedChannel } from 'discord.js'

import { RealtimeSession, type RealtimeTool, type ToolCall } from './realtime.ts'
import { discordToOpenAI, openAIToDiscord } from './audio-bridge.ts'

const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'
// TTS voice is independent of the realtime voice (the classic TTS voice set
// differs from the realtime set), so it has its own knob with a safe default.
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy'

// Thinking cue (parity with gem-voice's _synth_thinking_blip): a soft
// Hann-windowed sine played on a cadence while the model is composing its reply,
// so the gap between the user finishing and the model speaking isn't dead air.
const THINK_HZ = Number(process.env.VOICE_THINK_HZ || '420')
const THINK_GAIN = Number(process.env.VOICE_THINK_GAIN || '0.06')
const THINK_MS = Number(process.env.VOICE_THINK_MS || '170')
const THINK_EVERY_MS = Number(process.env.VOICE_THINK_EVERY_MS || '1100')

/** One soft thinking blip as 48k stereo PCM16LE (the AudioPlayer Raw format). */
function synthThinkingBlip(): Buffer {
  const rate = 48000, n = Math.floor((rate * THINK_MS) / 1000)
  const buf = Buffer.allocUnsafe(n * 4)   // stereo, 2 bytes/sample
  for (let i = 0; i < n; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))  // fade in/out
    const s = Math.sin((2 * Math.PI * THINK_HZ * i) / rate) * hann * THINK_GAIN
    const v = (Math.max(-1, Math.min(1, s)) * 32767) | 0
    buf.writeInt16LE(v, i * 4)
    buf.writeInt16LE(v, i * 4 + 2)
  }
  return buf
}

export interface VoiceSessionOptions {
  apiKey: string
  instructions?: string
  voice?: string
  tools?: RealtimeTool[]
  /** Called when the model invokes a tool; return the result to feed back. */
  onToolCall?: (call: ToolCall) => Promise<unknown>
  log?: (msg: string) => void
}

export class VoiceSession {
  private connection?: VoiceConnection
  private player?: AudioPlayer
  private realtime?: RealtimeSession
  private playback?: PassThrough
  private readonly subscribed = new Set<string>()
  private readonly log: (msg: string) => void
  private thinking = false
  private thinkingTimer?: ReturnType<typeof setInterval>
  private readonly blip = synthThinkingBlip()

  constructor(private readonly opts: VoiceSessionOptions) {
    this.log = opts.log ?? (() => {})
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,   // must hear users
      selfMute: false,
    })
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000)

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    })
    // Diagnostics: surface playback failures (a bad resource / missing opus
    // encoder fails silently otherwise) and state flips, so a "no audio" report
    // is debuggable from the log instead of a guess.
    this.player.on('error', (e) => this.log(`player error: ${e.message}`))
    this.player.on('stateChange', (o, n) => {
      if (o.status !== n.status) this.log(`player ${o.status} -> ${n.status}`)
    })
    this.connection.subscribe(this.player)

    // Connect the realtime brain.
    this.realtime = new RealtimeSession({
      apiKey: this.opts.apiKey,
      instructions: this.opts.instructions,
      voice: this.opts.voice,
      tools: this.opts.tools,
    })
    this.realtime.on('audio', (pcm24: Buffer) => this.playOut(pcm24))
    this.realtime.on('speechStarted', () => this.onBargeIn())
    this.realtime.on('speechStopped', () => this.startThinking())  // model composing
    this.realtime.on('responseDone', () => this.stopThinking())
    this.realtime.on('error', (e: Error) => this.log(`realtime error: ${e.message}`))
    this.realtime.on('close', () => this.log('realtime socket closed'))
    // ALWAYS handle tool calls — even with no handler wired. An unanswered tool
    // call hangs the turn forever (the model waits for a result it never gets:
    // "went to search and never came back"). handleToolCall replies either way.
    this.realtime.on('toolCall', (c: ToolCall) => this.handleToolCall(c))
    await this.realtime.connect()
    this.log('voice session ready')

    // Subscribe to each user as they start speaking (per-user opus streams).
    const receiver = this.connection.receiver
    receiver.speaking.on('start', (userId: string) => this.listenTo(userId))
  }

  private listenTo(userId: string): void {
    if (!this.connection || this.subscribed.has(userId)) return
    this.subscribed.add(userId)
    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    })
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
    opus.pipe(decoder)
    decoder.on('data', (pcm48Stereo: Buffer) => {
      try {
        this.realtime?.appendAudio(discordToOpenAI(pcm48Stereo))
      } catch (e) {
        this.log(`mic->realtime convert failed: ${(e as Error).message}`)
      }
    })
    const cleanup = () => { this.subscribed.delete(userId); decoder.destroy() }
    opus.on('end', cleanup)
    opus.on('error', cleanup)
  }

  /** Feed a model audio delta (24k mono) to the player as 48k stereo Raw. */
  private playOut(pcm24Mono: Buffer): void {
    if (!this.player) return
    this.stopThinking()            // real audio arrived — drop the thinking cue
    if (!this.playback) {
      this.playback = new PassThrough()
      const resource = createAudioResource(this.playback, { inputType: StreamType.Raw })
      this.player.play(resource)
    }
    this.playback.write(openAIToDiscord(pcm24Mono))
  }

  /** Start the soft "thinking" cue. Also resets the prior turn's playback so the
   *  next response's audio starts on a fresh stream (fixes turn-2-silent). */
  private startThinking(): void {
    if (!this.player) return
    if (this.playback) { this.playback.end(); this.playback = undefined }
    if (this.thinking) return
    this.thinking = true
    this.playBlip()
    this.thinkingTimer = setInterval(() => { if (this.thinking) this.playBlip() }, THINK_EVERY_MS)
  }

  private stopThinking(): void {
    this.thinking = false
    if (this.thinkingTimer) { clearInterval(this.thinkingTimer); this.thinkingTimer = undefined }
  }

  private playBlip(): void {
    if (!this.player) return
    this.player.play(createAudioResource(Readable.from(this.blip), { inputType: StreamType.Raw }))
  }

  /** User interrupted while the bot was talking — stop playback now. */
  private onBargeIn(): void {
    this.stopThinking()
    this.realtime?.cancelResponse()
    if (this.playback) {
      this.playback.end()
      this.playback = undefined
    }
    this.player?.stop(true)
  }

  private async handleToolCall(call: ToolCall): Promise<void> {
    if (!this.opts.onToolCall) {
      // No tool wired — answer the call anyway so the turn doesn't hang waiting
      // for a result. The model then continues from its own knowledge.
      this.log(`tool call '${call.name}' but no handler — replying unavailable`)
      this.realtime?.sendToolResponse(call.callId,
        { error: 'no live tools available; answer from your own knowledge' })
      return
    }
    try {
      const result = await this.opts.onToolCall(call)
      this.realtime?.sendToolResponse(call.callId, result)
    } catch (e) {
      this.realtime?.sendToolResponse(call.callId, { error: (e as Error).message })
    }
  }

  /**
   * Speak a SPECIFIC text verbatim (text -> voice-back), via OpenAI TTS rather
   * than the realtime model (which would paraphrase). Requires an active
   * session — it plays through the same AudioPlayer. `response_format: 'pcm'`
   * gives 24k mono PCM16, which the bridge already knows how to play.
   */
  async speakText(text: string): Promise<void> {
    if (!this.player) throw new Error('not in a voice channel — join first')
    const client = new OpenAI({ apiKey: this.opts.apiKey })
    const resp = await client.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE as any,
      input: text,
      response_format: 'pcm',   // 24k mono PCM16
    })
    const pcm48Stereo = openAIToDiscord(Buffer.from(await resp.arrayBuffer()))
    // One-shot: a finite Readable (not the streaming PassThrough) so the player
    // plays the clip start-to-finish then goes idle. Decoupled from realtime
    // playback state so /gpt voice speak works whether or not a turn is live.
    if (this.playback) { this.playback.end(); this.playback = undefined }
    const resource = createAudioResource(Readable.from(pcm48Stereo), { inputType: StreamType.Raw })
    this.player.play(resource)
  }

  leave(): void {
    this.stopThinking()
    try { this.playback?.end() } catch { /* */ }
    try { this.player?.stop(true) } catch { /* */ }
    try { this.realtime?.close() } catch { /* */ }
    try { this.connection?.destroy() } catch { /* */ }
    this.subscribed.clear()
    this.connection = undefined
    this.player = undefined
    this.realtime = undefined
    this.playback = undefined
    this.log('voice session left')
  }
}
