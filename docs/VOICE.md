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
| `OPENAI_REALTIME_VOICE` | `marin` | any OpenAI Realtime voice |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | model for `/gpt voice speak` (verbatim TTS) |
| `OPENAI_TTS_VOICE` | `alloy` | TTS voice (separate set from the realtime voices) |
| `DISCORD_ADMIN_USER_ID` | — | only this user may run `/gpt voice` (billed per minute) |

## Commands (`/gpt voice …`)
- `/gpt voice join` — join your VC, start realtime voice-to-voice
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
4. Bot replies "In **<channel>** — talk to me." Speak; you should hear it reply
   in the OpenAI voice. Talk over it → it stops (barge-in).
5. While joined, **`/gpt voice speak text:<line>`** makes it say that exact line.
6. **`/gpt voice leave`** to end the session (stops billing).

## Known v0.1 limitations
- Playback uses a single PassThrough; on barge-in it resets cleanly, but rapid
  back-to-back interruptions may clip the first frames of the next reply.
- Tool calls are plumbed (`onToolCall`) but no tools are wired in yet — pass
  `tools` + `onToolCall` into the VoiceManager to enable.
- The voice uses a generic spoken-mode instruction; wiring the full text persona
  into the voice session is a follow-up.
- Per-audio-minute billing — `/gpt voice` is owner-gated for that reason.
