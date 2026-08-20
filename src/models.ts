// Automatic API routing only writes a postmortem after confirmed Codex failure.
// Keep that report on a generally available API model; subscription-only Codex
// slugs fail there. Explicit API-engine channels also use this model normally.
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5'
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'
export const DEFAULT_SUMMARIZATION_MODEL = 'gpt-5.5'

export const OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-daybreak-blue-latest',
] as const

export type OpenAIModel = typeof OPENAI_MODELS[number]
