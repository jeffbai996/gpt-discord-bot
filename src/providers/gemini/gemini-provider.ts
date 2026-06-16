// GeminiProvider — implements the Provider contract using @google/genai.
// Ported from gem-bot/src/gemini.ts (GeminiClient), adapted to the Provider
// interface established in Phase 0/1a.
//
// Key differences from gem-bot's GeminiClient:
//   - Registry is per-call (passed via RespondInput.toolRegistry), not constructor.
//   - Constructor is (apiKey, defaultModel) — same shape as OpenAIProvider.
//   - Returns RespondResult ({react, reply, usage, finishReason, durationMs, modelUsed}).
//   - Emits gpt-bot LifecycleEvent[] via input.onEvent (different event names
//     from gem-bot's own LifecycleEvent — see mapping in respond()).
//   - managedCache capability is exposed as true (the infrastructure exists in
//     gem-bot), but GeminiCacheManager is NOT ported (1b-followup deferred).

import { GoogleGenAI } from '@google/genai'
import type { Provider, RespondInput, RespondResult, LifecycleEvent } from '../../core/provider.ts'
import { parseResponse, extractModelText, normalizeJsonWhitespace } from './parse.ts'
import { coreMessagesToContents, coreImagePartsToGeminiParts, registryToGeminiTools } from './format.ts'
import { selectFunctionCallPart } from './function-call.ts'

// Re-export for convenience (used in tests)
export { selectFunctionCallPart }

// Thrown when Gemini rejects the request with HTTP 400.
export class GeminiRequestRejected extends Error {
  readonly reason: string
  readonly status: number
  constructor(reason: string, status: number = 400) {
    super(`Gemini rejected request: ${reason}`)
    this.name = 'GeminiRequestRejected'
    this.reason = reason
    this.status = status
  }
}

// Tool-call loop cap. Mirrors gem-bot's MAX_TOOL_ITERATIONS.
const MAX_TOOL_ITERATIONS = parseInt(process.env.GEMINI_MAX_TOOL_LOOPS ?? '5', 10)

export class GeminiProvider implements Provider {
  public readonly id = 'gemini' as const
  public readonly defaultModel: string
  public readonly capabilities = {
    voice: true,
    managedCache: true,   // infrastructure exists; managed cache is a 1b-followup
    nativeWebSearch: true,
  } as const

  private client: GoogleGenAI
  private apiKey: string

  constructor(apiKey: string, defaultModel: string) {
    this.apiKey = apiKey
    this.defaultModel = defaultModel
    this.client = new GoogleGenAI({ apiKey })
  }

  // Embed text using gemini-embedding-001 via raw HTTP.
  // Ported from gem-bot/src/gemini.ts:GeminiClient.embed.
  // The JS SDK's embedContent doesn't expose outputDimensionality directly,
  // so we hit the REST endpoint manually to get 768-dim output matching
  // the sqlite-vss schema.
  async embed(text: string): Promise<number[]> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: 768
        })
      }
    )
    if (!res.ok) {
      throw new Error(`embedContent HTTP ${res.status}: ${await res.text()}`)
    }
    const data = await res.json() as { embedding?: { values?: number[] } }
    const values = data.embedding?.values
    if (!Array.isArray(values) || values.length !== 768) {
      throw new Error(`embedContent returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`)
    }
    return values
  }

  async respond(input: RespondInput): Promise<RespondResult> {
    const {
      systemPrompt, history, selfId, userMessage, userName, model,
      imageParts, extraText, toolRegistry, channelId, userId, onEvent
    } = input
    const start = Date.now()
    const modelName = model || this.defaultModel

    // Build the initial contents array from history + current user turn.
    const historyContents = coreMessagesToContents(history, selfId ?? '')

    // Build the current user turn parts: text + any image parts.
    const userText = extraText
      ? `${userName}: ${userMessage}\n\n${extraText}`
      : `${userName}: ${userMessage}`

    const userParts: any[] = [{ text: userText }]
    if (imageParts && imageParts.length > 0) {
      userParts.push(...coreImagePartsToGeminiParts(imageParts))
    }

    const activeContents: any[] = [
      ...historyContents,
      { role: 'user', parts: userParts }
    ]

    // Build the system instruction.
    const systemInstruction = {
      role: 'system',
      parts: [{ text: buildSystemPrompt(systemPrompt) }]
    }

    // Build tools from per-call registry.
    const tools = toolRegistry ? registryToGeminiTools(toolRegistry, { googleSearch: false }) : []
    // TODO(1b-followup): expose googleSearch grounding via channel flags

    const toolConfig = tools.length > 0
      ? { includeServerSideToolInvocations: true }
      : undefined

    let totalUsage: RespondResult['usage'] = null
    let finalParsed = { react: null as string | null, reply: '' }
    let lastFinishReason: string | null = null
    let modelUsed = modelName

    // Tool-call loop. Mirrors gem-bot's GeminiClient.respond structure.
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const turn = await this.runOneTurn(
        systemInstruction,
        activeContents,
        modelName,
        tools,
        toolConfig,
        onEvent
      )

      // Accumulate usage across turns.
      const usage = extractUsage(turn.response)
      if (usage) {
        totalUsage = totalUsage
          ? {
              inputTokens: totalUsage.inputTokens + usage.inputTokens,
              outputTokens: totalUsage.outputTokens + usage.outputTokens,
              totalTokens: totalUsage.totalTokens + usage.totalTokens,
              cachedInputTokens: totalUsage.cachedInputTokens + usage.cachedInputTokens,
              reasoningTokens: 0,
            }
          : usage
      }
      lastFinishReason = turn.finishReason

      if (!turn.functionCall) {
        // No function call → this is the final text answer.
        finalParsed = parseResponse(turn.text)
        onEvent?.({ type: 'done' })
        break
      }

      // Function call present — dispatch to the registry and loop.
      //
      // CRITICAL: push the ORIGINAL part from the model's response, not a
      // reconstructed {functionCall: ...}. Gemini-3 thinking models (incl.
      // gemini-3.5-flash) emit a `thoughtSignature` field alongside the
      // functionCall — when we feed the function response back in the next
      // iteration, the API requires that signature to verify the model's CoT
      // lineage. selectFunctionCallPart() encodes this priority.
      const turnParts = (turn.candidate?.content?.parts as any[] | undefined) ?? []
      const fnCallPart = selectFunctionCallPart(
        turn.functionCallPart,
        turnParts,
        turn.functionCall
      )
      activeContents.push({ role: 'model', parts: [fnCallPart] })

      const fnName = turn.functionCall.name as string
      const fnArgs = (turn.functionCall.args ?? {}) as Record<string, unknown>

      // Emit tool lifecycle events (mapped from gem-bot's tool_call_start/end
      // to gpt-bot's tool_start/tool_end LifecycleEvent).
      onEvent?.({ type: 'tool_start', name: fnName })

      let result: unknown
      try {
        if (toolRegistry) {
          result = await toolRegistry.dispatch(fnName, fnArgs, { channelId, userId })
        } else {
          result = `Unknown tool: ${fnName}`
        }
      } catch (e: any) {
        result = { error: e?.message ?? String(e) }
      }

      onEvent?.({ type: 'tool_end', name: fnName })

      activeContents.push({
        role: 'user',
        parts: [{ functionResponse: { name: fnName, response: { result } } }]
      })
    }

    // If we exhausted the loop without a final answer, give a graceful message.
    if (!finalParsed.reply && !finalParsed.react) {
      onEvent?.({ type: 'done' })
      finalParsed = {
        react: null,
        reply: `⚠️ tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations without a final answer`
      }
      lastFinishReason = 'TOOL_LOOP_EXHAUSTED'
    }

    return {
      react: finalParsed.react,
      reply: finalParsed.reply,
      usage: totalUsage,
      finishReason: lastFinishReason,
      durationMs: Date.now() - start,
      modelUsed,
    }
  }

  // One streaming round-trip to the model.
  // Ported from gem-bot/src/gemini.ts:GeminiClient.runOneTurn (streaming path).
  private async runOneTurn(
    systemInstruction: any,
    activeContents: any[],
    modelName: string,
    tools: any[],
    toolConfig: any,
    onEvent?: (e: LifecycleEvent) => void
  ): Promise<{
    functionCall: any | null
    functionCallPart: any | null
    candidate: any
    response: any
    text: string
    finishReason: string | null
  }> {
    const config: any = {
      systemInstruction,
      maxOutputTokens: 4096,
    }
    if (tools.length > 0) {
      config.tools = tools
      if (toolConfig) config.toolConfig = toolConfig
    }

    const params = { model: modelName, contents: activeContents, config }

    try {
      let accumulatedText = ''
      let functionCallReceived: any = null
      // Capture the FULL part (not just .functionCall) the moment we first
      // see it, so `thoughtSignature` survives even when it streams in an
      // earlier chunk than the final aggregated candidate.
      let functionCallPartReceived: any = null
      let lastChunk: any = null
      let firstTokenSeen = false

      const stream = await this.client.models.generateContentStream(params)
      for await (const chunk of stream) {
        lastChunk = chunk
        const candidate = chunk.candidates?.[0]
        const parts = candidate?.content?.parts as any[] | undefined

        // Check for grounding search in this chunk.
        if (extractSearchQueries(candidate).length > 0) {
          onEvent?.({ type: 'searching' })
        }

        // Capture functionCall parts — the FIRST emission carries the
        // thoughtSignature needed for thinking-model tool loops.
        const fnCallPart = parts?.find((p: any) => p.functionCall)
        if (fnCallPart) {
          functionCallReceived = fnCallPart.functionCall
          if (!functionCallPartReceived) functionCallPartReceived = fnCallPart
        }

        // Accumulate text parts and emit first_token + partial events.
        const textChunk = extractModelText(parts)
        if (textChunk && !functionCallReceived) {
          accumulatedText += textChunk
          if (!firstTokenSeen) {
            firstTokenSeen = true
            onEvent?.({ type: 'first_token' })
          }
          // Emit partial reply using parseResponse's partial mode
          const partial = parseResponse(accumulatedText, true)
          if (partial.reply) {
            onEvent?.({ type: 'partial', reply: partial.reply })
          }
        }
      }

      const candidate = lastChunk?.candidates?.[0]
      const parts = candidate?.content?.parts as any[] | undefined
      const text = accumulatedText || extractModelText(parts)
      const fnCall = functionCallReceived || parts?.find((p: any) => p.functionCall)?.functionCall || null
      const fnCallPart = functionCallPartReceived || parts?.find((p: any) => p.functionCall) || null
      const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : null

      return { functionCall: fnCall, functionCallPart: fnCallPart, candidate, response: lastChunk, text, finishReason }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (e?.status === 400 || /\b400\b/.test(msg) || e?.name === 'ApiError') {
        let reason: string
        try {
          const jsonStart = msg.indexOf('{')
          const jsonEnd = msg.lastIndexOf('}')
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const parsed = JSON.parse(msg.slice(jsonStart, jsonEnd + 1))
            reason = parsed?.error?.message ?? parsed?.message ?? msg.slice(0, 1024)
          } else {
            const reasonMatch = msg.match(/\[400[^\]]*\]\s*(.+?)(?:\n|$)/) || msg.match(/"message":\s*"([^"]+)"/)
            reason = reasonMatch ? reasonMatch[1].trim() : msg.slice(0, 1024)
          }
        } catch {
          reason = msg.slice(0, 1024)
        }
        throw new GeminiRequestRejected(reason, 400)
      }
      throw e
    }
  }
}

// Inject the current date/time into the system prompt so the model knows "now".
// Simplified version — doesn't add thinking-mode addenda (gem-bot-specific).
function buildSystemPrompt(base: string): string {
  const RESPONSE_FORMAT = `
## Response format (mandatory)

Your entire response must be a single JSON object with exactly these two string-or-null fields, and nothing else — no markdown fences, no preamble, no commentary outside the JSON:

{"react": <single emoji or null>, "reply": <your message text or "">}

- \`react\`: a single emoji to react with, or null. Most messages should be null.
- \`reply\`: your actual message. Markdown formatting inside the string is fine. Must be a string (never null).

Do NOT wrap this JSON in \`\`\`json ... \`\`\`. Emit the raw JSON object.`.trim()

  const now = new Date().toLocaleString('en-CA', {
    timeZone: 'America/Springfield', weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  })
  return `${base}\n\nThe current date and time is ${now}. Treat this as "now" — do not guess the date.\n\n${RESPONSE_FORMAT}`
}

// Extract usageMetadata from a response chunk, mapping to RespondResult's usage shape.
function extractUsage(response: any): RespondResult['usage'] {
  const u = response?.usageMetadata
  if (!u) return null
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    totalTokens: u.totalTokenCount ?? 0,
    cachedInputTokens: u.cachedContentTokenCount ?? 0,
    reasoningTokens: 0,
  }
}

// Pull search queries from grounding metadata (used to fire the 'searching' event).
function extractSearchQueries(candidate: any): string[] {
  const queries = candidate?.groundingMetadata?.webSearchQueries
  if (!Array.isArray(queries)) return []
  return queries.filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0)
}
