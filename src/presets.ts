import type { ChannelFlags } from './access.ts'

export type ChannelPreset = 'quiet' | 'normal' | 'dev' | 'deep'

export function presetPatch(preset: ChannelPreset): Partial<ChannelFlags> {
  if (preset === 'quiet') return { thinking: 'off', trace: 'off', counter: 'off' }
  if (preset === 'normal') return { thinking: 'live', trace: 'collapse', counter: 'both', reasoning: 'high' }
  if (preset === 'dev') return { thinking: 'live', trace: 'on', counter: 'both', reasoning: 'high' }
  return { thinking: 'collapse', trace: 'on', counter: 'both', reasoning: 'max', engine: 'codex' }
}
