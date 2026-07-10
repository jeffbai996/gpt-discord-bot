// The API fallback handles images and emergency Codex failures. Keep it on a
// generally available API model; subscription-only Codex slugs fail there.
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5'
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'
export const DEFAULT_SUMMARIZATION_MODEL = 'gpt-5.5'

export const OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const

export type OpenAIModel = typeof OPENAI_MODELS[number]
