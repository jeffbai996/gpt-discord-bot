import OpenAI from 'openai'
import type { Provider, RespondInput, RespondResult, LifecycleEvent, ParsedResponse } from './core/provider.ts'
import { embed } from './memory.ts'

// Re-export the shared types so existing callers that import from './openai.ts'
// continue to work without changes.
export type { LifecycleEvent, RespondInput, RespondResult, ParsedResponse }

export class OpenAIRequestRejected extends Error {
  constructor(public reason: string, public details?: unknown) {
    super(reason)
    this.name = 'OpenAIRequestRejected'
  }
}

const STRUCTURED_OUTPUT_INSTRUCTION = `
Respond in JSON only, with this exact shape:
{
  "react": "<single Unicode emoji or null>",
  "reply": "<your reply text — may be empty string if react-only>"
}

The "react" field is optional — set to null if no reaction is appropriate.
Use only standard Unicode emojis, never custom Discord emoji codes like :name:.
The "reply" field is the message body posted to the channel; it may use Markdown.
If you have nothing to say (no reply and no react), return {"react": null, "reply": ""}.
`.trim()

// o-series models accept `reasoning_effort` and reject `temperature`.
function isReasoningModel(model: string): boolean {
  return model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')
}

// gpt-5.x rejects custom `temperature` (only default 1.0 is supported) and
// rejects `max_tokens` in favor of `max_completion_tokens`. The o-series has
// the same `max_completion_tokens` requirement. Only legacy gpt-4.x models
// still accept the old `max_tokens` + custom temperature shape — and we don't
// expose those in the channel flag, so just key off model prefix.
function isGpt5Family(model: string): boolean {
  return model.startsWith('gpt-5')
}

export class OpenAIClient implements Provider {
  private client: OpenAI
  public readonly defaultModel: string
  public readonly id = 'openai' as const
  public readonly capabilities = { voice: false, managedCache: false, nativeWebSearch: false } as const

  constructor(apiKey: string, defaultModel: string) {
    this.client = new OpenAI({ apiKey })
    this.defaultModel = defaultModel
  }

  async embed(text: string): Promise<number[]> {
    // Wrap the free embed helper from memory.ts; Provider contract requires
    // non-null, so fall back to empty array on failure (memory.ts returns null
    // only for empty strings or transient API errors).
    return (await embed(this.client, text)) ?? []
  }

  async respond(input: RespondInput): Promise<RespondResult> {
    const { systemPrompt, history, userMessage, userName, model, reasoningEffort, imageParts, extraText, toolRegistry, channelId, userId, onEvent } = input
    const start = Date.now()

    const userText = extraText
      ? `${userName}: ${userMessage}\n\n${extraText}`
      : `${userName}: ${userMessage}`

    const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] =
      (imageParts && imageParts.length > 0)
        ? [{ type: 'text', text: userText }, ...imageParts]
        : userText

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${systemPrompt}\n\n---\n\n${STRUCTURED_OUTPUT_INSTRUCTION}` },
      ...history,
      { role: 'user', content: userContent }
    ]

    const reasoning = isReasoningModel(model)
    const gpt5 = isGpt5Family(model)
    const sdkEffort: 'low' | 'medium' | 'high' =
      reasoningEffort === 'minimal' ? 'low'
        : reasoningEffort === 'high' ? 'high'
        : reasoningEffort === 'low' ? 'low'
        : 'medium'
    const familyParams = reasoning
      ? { reasoning_effort: sdkEffort, max_completion_tokens: 4096 }
      : gpt5
        ? { max_completion_tokens: 4096 }
        : { temperature: 0.7, max_tokens: 4096 }

    const tools = toolRegistry && toolRegistry.size() > 0 ? toolRegistry.toOpenAITools() : undefined

    onEvent?.({ type: 'thinking_start' })

    let totalUsage: RespondResult['usage'] = null
    let modelUsed = model
    let lastFinish: string | null = null
    // Tool-loop cap. 3 rounds covers realistic tool chains (e.g. fetch then
    // summarize) without giving a misbehaving model room to spin 5 expensive
    // round-trips before giving up. Override with GPT_MAX_TOOL_LOOPS=<n>.
    // Was 5 — sister bot gem-discord-bot caps at 3, matching that here.
    const MAX_LOOPS = parseInt(process.env.GPT_MAX_TOOL_LOOPS ?? '3', 10)

    try {
      for (let iter = 0; iter < MAX_LOOPS; iter++) {
        // Stream one round-trip. JSON-mode is incompatible with tool-calls in
        // many models; only enforce it on the FINAL turn (when the assistant
        // emits content rather than tool_calls). We approximate this by only
        // requesting `response_format` when no tools are bound — the loop
        // unbinds tools on the final turn after dispatching whatever the
        // model asked for.
        //
        // But that's fragile. Simpler: when tools are bound, we ask for
        // tool-call OR free text (no json_object), and only impose JSON
        // output via the system-prompt instruction. The parser handles
        // free-text → "all reply" fallback already.
        const reqBody: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...familyParams,
          ...(tools ? { tools, tool_choice: 'auto' } : { response_format: { type: 'json_object' } })
        }

        const stream = await this.client.chat.completions.create(reqBody)

        let contentAcc = ''
        let toolCallAcc: Map<number, { id: string; name: string; args: string }> = new Map()
        let firstTokenSeen = false
        let lastPartialEmit = ''
        let finishReason: string | null = null

        let reasoningStartEmitted = false
        for await (const chunk of stream) {
          if (chunk.model) modelUsed = chunk.model
          const choice = chunk.choices?.[0]
          if (choice) {
            const delta = choice.delta as {
              content?: string | null
              // o-series and gpt-5 reasoning models surface chain-of-thought
              // summary deltas as `reasoning_content` (legacy o1 SDK shape)
              // or via `reasoning.summary[*].delta` (newer responses). Cover
              // both shapes; first nonempty token of either triggers the 🧠
              // lifecycle reaction once per turn.
              reasoning_content?: string | null
              reasoning?: {
                summary?: Array<{ delta?: string; text?: string }>
              }
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            if (!reasoningStartEmitted) {
              const hasReasoning =
                (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
                (delta?.reasoning?.summary?.some(s => (s.delta?.length ?? s.text?.length ?? 0) > 0) ?? false)
              if (hasReasoning) {
                reasoningStartEmitted = true
                onEvent?.({ type: 'reasoning_start' })
              }
            }
            if (delta?.content) {
              contentAcc += delta.content
              if (!firstTokenSeen) {
                firstTokenSeen = true
                onEvent?.({ type: 'first_token' })
              }
              const partial = extractPartialReply(contentAcc)
              if (partial && partial !== lastPartialEmit) {
                lastPartialEmit = partial
                onEvent?.({ type: 'partial', reply: partial })
              }
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index
                const existing = toolCallAcc.get(idx) ?? { id: '', name: '', args: '' }
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.name = tc.function.name
                if (tc.function?.arguments) existing.args += tc.function.arguments
                toolCallAcc.set(idx, existing)
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason
          }
          if (chunk.usage) {
            // OpenAI's usage block has optional nested details:
            //   prompt_tokens_details.cached_tokens — auto prompt caching hits
            //   completion_tokens_details.reasoning_tokens — o-series CoT cost
            // Both default to 0 when unset (older models / non-reasoning paths).
            const usage = chunk.usage as typeof chunk.usage & {
              prompt_tokens_details?: { cached_tokens?: number }
              completion_tokens_details?: { reasoning_tokens?: number }
            }
            const u = {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens ?? 0,
              cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
              reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
            }
            // Accumulate across iterations; later turns add to earlier ones.
            totalUsage = totalUsage
              ? {
                  inputTokens: totalUsage.inputTokens + u.inputTokens,
                  outputTokens: totalUsage.outputTokens + u.outputTokens,
                  totalTokens: totalUsage.totalTokens + u.totalTokens,
                  cachedInputTokens: totalUsage.cachedInputTokens + u.cachedInputTokens,
                  reasoningTokens: totalUsage.reasoningTokens + u.reasoningTokens,
                }
              : u
          }
        }

        lastFinish = finishReason

        // No tool calls → final answer.
        if (toolCallAcc.size === 0 || finishReason !== 'tool_calls') {
          onEvent?.({ type: 'done' })
          const parsed = parseStructuredReply(contentAcc)
          return {
            react: parsed.react,
            reply: parsed.reply,
            usage: totalUsage,
            finishReason: lastFinish,
            durationMs: Date.now() - start,
            modelUsed
          }
        }

        // Tool calls present. Append the assistant's tool-call message to
        // history, dispatch each tool, append results, then loop.
        const toolCalls = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]).map(([_, v]) => v)
        messages.push({
          role: 'assistant',
          content: contentAcc || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.args || '{}' }
          }))
        })

        for (const tc of toolCalls) {
          if (!toolRegistry) break
          const isSearch = tc.name === 'web_search'
          let parsedArgs: Record<string, unknown> = {}
          try { parsedArgs = JSON.parse(tc.args || '{}') } catch { /* empty args */ }
          // Compact one-line arg preview for the tool-trace card.
          const argPreview = Object.entries(parsedArgs)
            .map(([k, v]) => {
              const sv = typeof v === 'string' ? v : JSON.stringify(v)
              const short = sv.length > 40 ? sv.slice(0, 40) + '…' : sv
              return `${k}: ${short}`
            })
            .join(', ')
          onEvent?.({ type: isSearch ? 'searching' : 'tool_start', name: tc.name, args: argPreview } as LifecycleEvent)
          const result = await toolRegistry.dispatch(tc.name, parsedArgs, { channelId, userId })
          onEvent?.({ type: 'tool_end', name: tc.name })
          messages.push({
            role: 'tool',
            tool_call_id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            content: result
          })
        }
      }

      // Hit MAX_LOOPS without a final answer.
      onEvent?.({ type: 'done' })
      return {
        react: null,
        reply: `⚠️ tool loop exceeded ${MAX_LOOPS} iterations without a final answer`,
        usage: totalUsage,
        finishReason: lastFinish ?? 'tool_loop_exhausted',
        durationMs: Date.now() - start,
        modelUsed
      }
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status
      const code = e?.code ?? e?.error?.code
      if (status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
        throw new OpenAIRequestRejected(`rate_limited (${code ?? status})`, e)
      }
      if (status === 400 && /content.*polic|safety/i.test(e?.message ?? '')) {
        throw new OpenAIRequestRejected('content_policy', e)
      }
      throw e
    }
  }
}

// Provider-named alias — the harness refers to providers by their role, not SDK.
export { OpenAIClient as OpenAIProvider }

// During streaming, find the value of the `"reply"` key in a partial JSON
// object. Doesn't fully parse JSON (the doc is incomplete mid-stream); just
// scans for `"reply"` and walks forward, unescaping common sequences. Returns
// null if the key hasn't appeared yet, or the in-flight string value.
//
// Limitations: doesn't validate matching braces, doesn't handle every JSON
// escape sequence, doesn't notice if `"reply"` appears as part of another
// string. Good enough for Discord progress-edit display.
export function extractPartialReply(raw: string): string | null {
  const keyIdx = raw.indexOf('"reply"')
  if (keyIdx === -1) return null

  // Skip past `"reply"`, optional whitespace, the colon, more whitespace.
  let i = keyIdx + '"reply"'.length
  while (i < raw.length && /\s/.test(raw[i])) i++
  if (raw[i] !== ':') return null
  i++
  while (i < raw.length && /\s/.test(raw[i])) i++

  // Handle a null or non-string value gracefully.
  if (raw[i] !== '"') return null
  i++

  let out = ''
  while (i < raw.length) {
    const c = raw[i]
    if (c === '\\') {
      const next = raw[i + 1]
      if (next === undefined) break
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === '"') out += '"'
      else if (next === '\\') out += '\\'
      else if (next === '/') out += '/'
      else if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          continue
        }
        // incomplete \u escape — bail without appending
        break
      } else {
        out += next
      }
      i += 2
      continue
    }
    if (c === '"') break  // string terminated cleanly
    out += c
    i++
  }

  return out
}

// Best-effort parser for the structured `{react, reply}` shape. Handles the
// happy path (well-formed JSON) plus three failure modes:
//   1. Model wraps JSON in a markdown code fence — strip the fence.
//   2. Model emits trailing prose after the closing brace — slice to brace.
//   3. Model ignores the format and emits plain prose — treat all as reply.
export function parseStructuredReply(raw: string): ParsedResponse {
  if (!raw) return { react: null, reply: '' }

  let text = raw.trim()

  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) text = fence[1].trim()

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1)
    try {
      const obj = JSON.parse(candidate) as Partial<ParsedResponse>
      const react = typeof obj.react === 'string' && obj.react.trim() ? obj.react.trim() : null
      const reply = typeof obj.reply === 'string' ? obj.reply : ''
      return { react, reply }
    } catch {
      // fall through to plain-prose handling
    }
  }

  return { react: null, reply: text }
}
