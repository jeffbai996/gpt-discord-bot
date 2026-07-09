export const DEFAULT_OPENAI_MODEL = 'gpt-5.6'
export const DEFAULT_SUMMARIZATION_MODEL = 'gpt-5.6-luna'

export const OPENAI_MODELS = [
  'gpt-5.6',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const

export type OpenAIModel = typeof OPENAI_MODELS[number]

