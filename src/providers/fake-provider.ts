import type { Provider, RespondInput, RespondResult } from '../core/provider.ts'

// Deterministic in-memory Provider for testing core without a network or SDK.
// `respond` returns a scripted reply; `embed` hashes the input to a fixed-length
// vector so equal inputs give equal embeddings (lets RAG tests assert recall).
export class FakeProvider implements Provider {
  readonly id = 'fake'
  readonly defaultModel = 'fake'
  readonly capabilities = { voice: false, managedCache: false, nativeWebSearch: false }
  constructor(private script: { reply?: string, react?: string | null } = {}) {}

  async respond(input: RespondInput): Promise<RespondResult> {
    return {
      react: this.script.react ?? null,
      reply: this.script.reply ?? '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      finishReason: 'stop',
      durationMs: 0,
      modelUsed: input.model || this.defaultModel
    }
  }

  async embed(text: string): Promise<number[]> {
    const dim = 1536
    const v = new Array(dim).fill(0)
    for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i)
    return v
  }
}
