# Voice — realtime voice-to-voice (`/gpt voice`)

Pure-OpenAI, in-process, no crossover with gem-voice. gpt-bot joins a Discord
voice channel itself (`@discordjs/voice`) and runs a full-duplex OpenAI Realtime
session.

## Architecture
```
mic in:  Discord opus  → prism OpusDecoder (48k stereo PCM)
                       → audio-bridge.discordToOpenAI (24k mono)
                       → RealtimeSession.appendAudio
bot out: RealtimeSession 'audio' (24k mono)
                       → audio-bridge.openAIToDiscord (48k stereo)
                       → AudioPlayer (StreamType.Raw)
barge-in: RealtimeSession 'speechStarted' → cancel response + stop playback
```
Files: `src/voice/audio-bridge.ts` (format math, unit-tested), `realtime.ts`
(OpenAI Realtime WS, protocol unit-tested), `session.ts` (the live wiring),
`command.ts` (`/gpt voice` + per-guild manager).

## Config (env)
| var | default | notes |
|-----|---------|-------|
| `OPENAI_API_KEY` | (required) | already used by the bot |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | the realtime model |
| `OPENAI_REALTIME_VOICE` | `ballad` | default when `/gpt voice join` omits `voice`; any supported OpenAI Realtime voice is valid |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | model for `/gpt voice speak` (verbatim TTS) |
| `OPENAI_TTS_VOICE` | `alloy` | TTS voice (separate set from the realtime voices) |
| `DISCORD_ADMIN_USER_ID` | — | only this user may run `/gpt voice` (billed per minute) |
| `VOICE_THINK_FILE` | — | path to an audio clip (any ffmpeg-readable format) played as the "thinking" cue while the model composes. The only way to exactly match ChatGPT's sound — synthesis can't. Unset = soft synth fallback. |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary used to decode `VOICE_THINK_FILE`. Pin to an absolute path under systemd (minimal PATH). |
| `VOICE_THINK_HZ` / `_GAIN` / `_MS` / `_EVERY_MS` | `330` / `0.05` / `220` / `1100` | synth-fallback tone tuning (freq, amplitude, blip length, cadence). Ignored when `VOICE_THINK_FILE` is set. |

## Commands (`/gpt voice …`)
- `/gpt voice join [voice]` — join your VC, start realtime voice-to-voice; picker offers British `ballad` (default), `marin`, `cedar`, and `coral`
- `/gpt voice leave` — leave + tear down
- `/gpt voice speak <text>` — say a specific line verbatim (text → voice-back, via TTS)

## Live smoke test (the verification step)
The audio math + protocol are unit-tested (170 tests green); the live loop needs
a real VC + a billed Realtime session, so it's a manual test:

1. Ensure the bot role has **Connect** + **Speak** in the target voice channel.
2. Restart gpt with this branch so `/gpt voice` registers and the `GuildVoiceStates`
   intent is on. (No Discord dev-portal change needed — voice states is not a
   privileged intent.)
3. Join a voice channel yourself, then run **`/gpt voice join`**.
   Optionally pick a voice for this call; omitting it uses British `ballad`.
4. Bot replies "In **<channel>** — talk to me." Speak; you should hear it reply
   in the OpenAI voice. Talk over it → it stops (barge-in).
5. While joined, **`/gpt voice speak text:<line>`** makes it say that exact line.
6. **`/gpt voice leave`** to end the session (stops billing).

## Known limitations
- Playback uses a single PassThrough; on barge-in it resets cleanly, but rapid
  back-to-back interruptions may clip the first frames of the next reply.
- Per-audio-minute billing — `/gpt voice` is owner-gated for that reason.
- On join, the latest 20 messages from the command's text channel are appended
  to the voice instructions in chronological order. History fetch is best-effort:
  a Discord API failure is logged but does not block the call.
