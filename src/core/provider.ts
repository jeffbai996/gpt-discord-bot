import type { HistoryMessage } from '../history.ts'
import type { ToolRegistry } from '../tools/registry.ts'

// The neutral, provider-agnostic message shape. It is exactly what fetchHistory
// produces; each provider maps CoreMessage[] to its own wire format inside
// respond(). (Phase 1a — replaces the OpenAI-typed history.)
export type CoreMessage = HistoryMessage

// A provider-neutral inline image. Each provider maps it to its own wire form
// (OpenAI image_url part / Gemini inlineData or fileData part).
export interface CoreImagePart {
  mimeType: string
  dataBase64?: string   // inline base64 (small images)
  url?: string          // remote/file URL (large images / fileData path)
}

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
  // Provider-neutral message history. Each provider maps CoreMessage[] to its
  // own wire format inside respond() (e.g. OpenAIProvider calls
  // formatHistoryForOpenAI internally). (Phase 1a — was OpenAI-typed in Phase 0.)
  history: CoreMessage[]
  userMessage: string
  userName: string
  model: string
  // The bot's own Discord user id — lets the provider tag its own past
  // messages as assistant/model when formatting history.
  selfId?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  imageParts?: CoreImagePart[]
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
