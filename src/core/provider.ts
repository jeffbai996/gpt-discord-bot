import type OpenAI from 'openai'
import type { ToolRegistry } from '../tools/registry.ts'

export interface ParsedResponse {
  react: string | null
  reply: string
}

export type LifecycleEvent =
  | { type: 'thinking_start' }
  | { type: 'reasoning_start' }
  | { type: 'first_token' }
  | { type: 'partial', reply: string }
  | { type: 'tool_start', name: string, args?: string }
  | { type: 'tool_end', name: string }
  | { type: 'searching' }
  | { type: 'done' }

export interface RespondInput {
  systemPrompt: string
  // NOTE (Phase 0): history is still the OpenAI message-param shape. Phase 1
  // introduces a neutral CoreMessage type when GeminiProvider needs it.
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  model: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  imageParts?: OpenAI.Chat.Completions.ChatCompletionContentPartImage[]
  extraText?: string
  toolRegistry?: ToolRegistry
  channelId?: string
  userId?: string
  onEvent?: (event: LifecycleEvent) => void
}

export interface RespondResult extends ParsedResponse {
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cachedInputTokens: number
    reasoningTokens: number
  } | null
  finishReason: string | null
  durationMs: number
  modelUsed: string
}

// The contract core depends on. A model backend is anything that can stream a
// reply (respond) and produce embeddings (embed). Tool-schema formatting stays
// internal to each provider's respond(); capabilities let core branch on
// provider-specific features (voice, native web search) without importing SDKs.
export interface Provider {
  readonly id: string
  readonly defaultModel: string
  readonly capabilities: {
    voice: boolean
    managedCache: boolean
    nativeWebSearch: boolean
  }
  respond(input: RespondInput): Promise<RespondResult>
  embed(text: string): Promise<number[]>
}
