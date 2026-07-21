export const BUILTIN_DEFAULT_REALTIME_VOICE = 'ballad'

export const REALTIME_VOICE_CHOICES = [
  { name: 'Ballad — British (default)', value: 'ballad' },
  { name: 'Marin — natural', value: 'marin' },
  { name: 'Cedar — clear', value: 'cedar' },
  { name: 'Coral — warm', value: 'coral' },
] as const

export function resolveRealtimeVoice(selected?: string | null, configured?: string): string {
  return selected || configured || BUILTIN_DEFAULT_REALTIME_VOICE
}
