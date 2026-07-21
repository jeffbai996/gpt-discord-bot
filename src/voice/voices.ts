import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BUILTIN_DEFAULT_REALTIME_VOICE = 'ballad'

export const REALTIME_VOICE_CHOICES = [
  { value: 'ballad', label: 'Ballad — British (default)', blurb: 'British, composed' },
  { value: 'marin', label: 'Marin — natural', blurb: 'natural, conversational' },
  { value: 'cedar', label: 'Cedar — clear', blurb: 'clear, direct' },
  { value: 'coral', label: 'Coral — warm', blurb: 'warm, lively' },
] as const

const VALID_VOICES = new Set<string>(REALTIME_VOICE_CHOICES.map(voice => voice.value))

function stateDir(override?: string): string {
  return override ?? process.env.GPT_STATE_DIR ?? path.join(os.homedir(), '.gpt', 'channels', 'discord')
}

function preferenceFile(override?: string): string {
  return path.join(stateDir(override), 'voice-pref.json')
}

export function getVoicePref(directory?: string, configured = process.env.OPENAI_REALTIME_VOICE): string {
  try {
    const voice = JSON.parse(fs.readFileSync(preferenceFile(directory), 'utf8'))?.voice
    if (typeof voice === 'string' && VALID_VOICES.has(voice)) return voice
  } catch {
    // Missing or malformed preference falls back to config, then Ballad.
  }
  return configured || BUILTIN_DEFAULT_REALTIME_VOICE
}

export function setVoicePref(voice: string, directory?: string): void {
  if (!VALID_VOICES.has(voice)) throw new Error(`unknown voice: ${voice}`)
  const file = preferenceFile(directory)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ voice }, null, 2) + '\n')
}

export function resolveRealtimeVoice(
  selected?: string | null,
  configured?: string,
  directory?: string,
): string {
  return selected || getVoicePref(directory, configured)
}
