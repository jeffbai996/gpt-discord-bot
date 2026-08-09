import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BUILTIN_DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1-mini'

export const REALTIME_MODEL_CHOICES = [
  {
    value: 'gpt-realtime-2.1-mini',
    label: 'Realtime 2.1 Mini — fast + cheap (default)',
    blurb: 'fast, lower-cost voice reasoning',
  },
  {
    value: 'gpt-realtime-2.1',
    label: 'Realtime 2.1 — full quality',
    blurb: 'better noise, silence, and interruption handling',
  },
] as const

const VALID_MODELS = new Set<string>(REALTIME_MODEL_CHOICES.map(model => model.value))

function stateDir(override?: string): string {
  return override ?? process.env.GPT_STATE_DIR ?? path.join(os.homedir(), '.gpt', 'channels', 'discord')
}

function preferenceFile(override?: string): string {
  return path.join(stateDir(override), 'voice-model-pref.json')
}

export function getRealtimeModelPref(
  directory?: string,
  configured = process.env.OPENAI_REALTIME_MODEL,
): string {
  try {
    const model = JSON.parse(fs.readFileSync(preferenceFile(directory), 'utf8'))?.model
    if (typeof model === 'string' && VALID_MODELS.has(model)) return model
  } catch {
    // Missing or malformed preference falls back to config, then 2.1 mini.
  }
  return configured || BUILTIN_DEFAULT_REALTIME_MODEL
}

export function setRealtimeModelPref(model: string, directory?: string): void {
  if (!VALID_MODELS.has(model)) throw new Error(`unknown realtime model: ${model}`)
  const file = preferenceFile(directory)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ model }, null, 2) + '\n')
}

export function resolveRealtimeModel(
  selected?: string | null,
  configured?: string,
  directory?: string,
): string {
  return selected || getRealtimeModelPref(directory, configured)
}
