import OpenAI from 'openai'
import type { ToolRegistry } from './tools/registry.ts'

export interface ParsedResponse {
  react: string | null   // optional emoji to add to the user's message
  reply: string          // text to post (may be empty if react-only)
}

// A single dispatched tool call, captured for the post-hoc trace card.
export interface ToolCall {
  name: string
  args: Record<string, unknown>
  durationMs: number
  resultPreview: string
  resultLines?: number   // line count of the raw (pre-clip) output, for the [N lines] tag
  failed: boolean
  diff?: string   // unified diff for file edits (from codex rollout), shown in the trace
}

export type LifecycleEvent =
  | { type: 'thinking_start' }
  | { type: 'reasoning_start' }   // first reasoning_summary token (o-series / gpt-5 reasoning)
  | { type: 'first_token' }       // first reply content token observed
  | { type: 'partial', reply: string }  // incremental reply (best-effort)
  | { type: 'status', label: string }  // live activity status (codex tool events)
  | { type: 'tool_start', name: string, args?: string }
  | {
      type: 'tool_end'
      name: string
      args?: Record<string, unknown>
      resultPreview?: string
      resultLines?: number
      failed?: boolean
      durationMs?: number
      diff?: string
    }
  | { type: 'searching' }         // web_search in flight (special-cased)
  | { type: 'done' }

export interface RespondInput {
  systemPrompt: string
  // Kept as the Chat Completions message shape for backward compatibility with
  // history.ts / gpt.ts — converted to Responses API input items internally.
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  model: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  // Multimodal content parts. `imageParts` get spliced into the user message
  // alongside the text; `extraText` is appended below userMessage (e.g. audio
  // transcripts, file extracts, "skipped" notices). Kept as the Chat
  // Completions image-part shape (`{ type: 'image_url', image_url: { url } }`)
  // for backward compat with attachments.ts; converted to Responses
  // `input_image` parts internally.
  imageParts?: OpenAI.Chat.Completions.ChatCompletionContentPartImage[]
  extraText?: string
  // When set, the model is offered the registry's tools and the loop runs
  // multi-turn until it emits a final assistant message. Each tool dispatch
  // emits tool_start/tool_end lifecycle events.
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
    // OpenAI's automatic prompt-prefix caching credits hits as
    // usage.input_tokens_details.cached_tokens in the Responses usage block.
    // gpt-4o, gpt-5, and the o-series all support it; cached input tokens
    // bill at ~50% of the normal rate. Surface here so callers can log
    // cache health without re-parsing the upstream payload.
    cachedInputTokens: number
    // reasoning_tokens are billed separately on o-series + gpt-5 (internal
    // chain-of-thought), reported via output_tokens_details.reasoning_tokens.
    // Already counted toward outputTokens but worth surfacing for telemetry
    // (lets you see how much the model spent reasoning vs replying).
    reasoningTokens: number
  } | null
  // Per-turn MARGINAL token usage (this turn only), for the ↑/↓ counter display.
  // On a resumed codex session usage above is the running session CUMULATIVE, so
  // the counter must show the delta vs last turn instead (Jeff 2026-06-25). Same
  // shape as `usage`; set by gpt.ts after deriving it per channel. Falls back to
  // `usage` when absent (the API path, where usage is already per-turn).
  usageDelta?: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    reasoningTokens: number
  } | null
  finishReason: string | null
  durationMs: number
  modelUsed: string
  // codex session id (rollout thread.started) for per-channel resume; set only on
  // the codex path, undefined on the API path. (Jeff 2026-06-25)
  threadId?: string
  // The captured reasoning-summary text ('' when the model produced none /
  // isn't a reasoning model). Rendered by gpt.ts when the `thinking` flag is on.
  reasoning: string
  // Per-call tool dispatches, for the post-hoc trace card in gpt.ts.
  toolCalls: ToolCall[]
  // Absolute paths of files a tool produced this turn (Playwright screenshots)
  // for gpt.ts to ATTACH to the Discord reply. Optional/empty when no tool emitted
  // a file (so other RespondResult producers needn't set it).
  files?: string[]
}

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

// Native json_schema enforcement for the final-answer turn (Responses
// `text.format`). Applied only on no-tools turns — keeping schema enforcement
// off the tool-bound turns avoids any tool/structured-output interaction we
// can't verify against the model, and the loop unbinds tools on the final turn
// anyway (when the model stops emitting function_call items). The
// system-prompt instruction + parseStructuredReply fallback cover tool turns.
const REPLY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    react: { type: ['string', 'null'], description: 'single Unicode emoji or null' },
    reply: { type: 'string', description: 'message body, may be empty' },
  },
  required: ['react', 'reply'],
  additionalProperties: false,
} as const

// o-series models accept `reasoning` and reject `temperature`.
function isReasoningModel(model: string): boolean {
  return model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')
}

// gpt-5.x rejects custom `temperature` (only the default is supported). On the
// Responses API the o-series and gpt-5 reasoning families take the `reasoning`
// block; legacy gpt-4.x still accepts `temperature`. We don't expose 4.x in the
// channel flag, so keying off the model prefix is sufficient.
function isGpt5Family(model: string): boolean {
  return model.startsWith('gpt-5')
}

// gpt-5.x are reasoning models too — they accept the Responses `reasoning`
// block (effort + summary). The o-series obviously do. gpt-4.x do not.
function supportsReasoning(model: string): boolean {
  return isReasoningModel(model) || isGpt5Family(model)
}

// Compact, capped preview of a tool result string for the trace card. Mirrors
// gem-bot's previewToolResult: collapse whitespace, cap at ~120 chars. The
// registry's dispatch() already returns a string, so the typeof branch is
// belt-and-suspenders for any future non-string result.
export function previewToolResult(result: unknown): string {
  let s: string
  if (typeof result === 'string') {
    s = result
  } else {
    try { s = JSON.stringify(result) } catch { s = String(result) }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 120 ? s.slice(0, 117) + '...' : s
}

// Compact one-line arg preview for the `tool_start` lifecycle event (the live
// reaction path). The richer trace card in gpt.ts uses its own argDigest over
// the captured ToolCall.args; this is just the inline "name(preview)" string.
function argPreview(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const sv = typeof v === 'string' ? v : JSON.stringify(v)
      const short = sv.length > 40 ? sv.slice(0, 40) + '…' : sv
      return `${k}: ${short}`
    })
    .join(', ')
}

// Convert a Chat Completions image-part (`{ type:'image_url', image_url:{url} }`)
// into a Responses `input_image` content part. attachments.ts builds the former
// shape; the Responses API wants `{ type:'input_image', image_url: <url> }`.
function toResponsesImagePart(
  p: OpenAI.Chat.Completions.ChatCompletionContentPartImage
): OpenAI.Responses.ResponseInputImage {
  const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url
  const detail = (typeof p.image_url === 'object' && p.image_url.detail) || 'auto'
  return { type: 'input_image', image_url: url, detail }
}

// Convert the Chat-shaped history into Responses API input message items.
// History entries are simple `{ role, content: string }` (see
// history.ts/formatHistoryForOpenAI), so a 1:1 map to EasyInputMessage works.
// Roles other than user/assistant are coerced to user (none are produced
// today, but keeps the conversion total).
function historyToInputItems(
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = []
  for (const m of history) {
    if (typeof m.content !== 'string') continue  // history is string-content only
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    items.push({ role, content: m.content })
  }
  return items
}

export class OpenAIClient {
  private client: OpenAI
  public readonly defaultModel: string

  constructor(apiKey: string, defaultModel: string) {
    this.client = new OpenAI({ apiKey })
    this.defaultModel = defaultModel
  }

  async respond(input: RespondInput): Promise<RespondResult> {
    const { systemPrompt, history, userMessage, userName, model, reasoningEffort, imageParts, extraText, toolRegistry, channelId, userId, onEvent } = input
    const start = Date.now()

    const userText = extraText
      ? `${userName}: ${userMessage}\n\n${extraText}`
      : `${userName}: ${userMessage}`

    // Build the user turn. Text-only → a plain string content; with images →
    // a content-part list (input_text + input_image parts).
    const userItem: OpenAI.Responses.ResponseInputItem =
      (imageParts && imageParts.length > 0)
        ? {
            role: 'user',
            content: [
              { type: 'input_text', text: userText },
              ...imageParts.map(toResponsesImagePart),
            ],
          }
        : { role: 'user', content: userText }

    // The running input list. Each tool round-trip appends the model's
    // function_call items + our function_call_output items, then re-sends.
    const inputItems: OpenAI.Responses.ResponseInputItem[] = [
      ...historyToInputItems(history),
      userItem,
    ]

    const reasoningCapable = supportsReasoning(model)
    // Map the channel-flag effort onto the Responses `reasoning.effort` enum
    // (low | medium | high — 'minimal' folds to 'low').
    const sdkEffort: 'low' | 'medium' | 'high' =
      reasoningEffort === 'minimal' ? 'low'
        : reasoningEffort === 'high' ? 'high'
        : reasoningEffort === 'low' ? 'low'
        : 'medium'

    // System prompt rides the `instructions` param. We still append the
    // structured-output instruction because tool-bound turns don't carry the
    // native json_schema (see REPLY_JSON_SCHEMA note) and the parser leans on it.
    const instructions = `${systemPrompt}\n\n---\n\n${STRUCTURED_OUTPUT_INSTRUCTION}`

    const tools = toolRegistry && toolRegistry.size() > 0
      ? toolRegistry.toResponsesTools()
      : undefined

    onEvent?.({ type: 'thinking_start' })

    let totalUsage: RespondResult['usage'] = null
    let modelUsed = model
    let lastFinish: string | null = null
    // Files (screenshots) a tool produced this turn, collected via ToolContext.onFile
    // and surfaced on the result so gpt.ts attaches them to the Discord reply.
    const collectedFiles: string[] = []
    let reasoningAcc = ''
    // OpenAI emits the reasoning summary as distinct PARTS (each often a bold
    // section title + body), keyed by summary_index. Track the last index so we
    // can insert a blank line between parts — otherwise the next part's title
    // runs onto the end of the prior line ("…web search!**Discussing details**").
    let lastSummaryIndex = -1
    const toolCalls: ToolCall[] = []
    // Tool-loop cap. 8 rounds covers coding-agent fallback chains (inspect,
    // patch, test, inspect failure, patch again, final) without giving a
    // misbehaving model room to spin expensive round-trips. Override with
    // GPT_MAX_TOOL_LOOPS=<n>.
    const MAX_LOOPS = parseInt(process.env.GPT_MAX_TOOL_LOOPS ?? '8', 10)

    try {
      for (let iter = 0; iter < MAX_LOOPS; iter++) {
        // Stream one round-trip. Native json_schema enforcement only when NO
        // tools are bound this turn (see REPLY_JSON_SCHEMA). When tools are
        // bound we rely on the system-prompt instruction + parseStructuredReply.
        const reqBody: OpenAI.Responses.ResponseCreateParamsStreaming = {
          model,
          instructions,
          input: inputItems,
          stream: true,
          max_output_tokens: 4096,
          ...(reasoningCapable
            ? { reasoning: { effort: sdkEffort, summary: 'auto' } }
            : { temperature: 0.7 }),
          ...(tools
            ? { tools, tool_choice: 'auto' }
            : {
                text: {
                  format: {
                    type: 'json_schema',
                    name: 'discord_reply',
                    schema: REPLY_JSON_SCHEMA as unknown as Record<string, unknown>,
                    strict: true,
                  },
                },
              }),
        }

        const stream = await this.client.responses.create(reqBody)

        let contentAcc = ''
        // call_id -> accumulating function_call (args stream in deltas).
        const fnCallAcc = new Map<string, { call_id: string; name: string; args: string }>()
        // item_id -> call_id, so argument-delta events (keyed by item_id) route
        // to the right accumulator.
        const itemIdToCallId = new Map<string, string>()
        let firstTokenSeen = false
        let lastPartialEmit = ''
        let reasoningStartEmitted = false
        let searchEmitted = false

        for await (const event of stream) {
          switch (event.type) {
            case 'response.output_text.delta': {
              contentAcc += event.delta
              if (!firstTokenSeen) {
                firstTokenSeen = true
                onEvent?.({ type: 'first_token' })
              }
              const partial = extractPartialReply(contentAcc)
              if (partial && partial !== lastPartialEmit) {
                lastPartialEmit = partial
                onEvent?.({ type: 'partial', reply: partial })
              }
              break
            }
            case 'response.reasoning_summary_text.delta': {
              if (event.delta) {
                // New summary part → separate it from the previous with a blank
                // line so a part-leading bold title lands on its own line.
                const idx = (event as { summary_index?: number }).summary_index ?? 0
                if (reasoningAcc && idx !== lastSummaryIndex) reasoningAcc += '\n\n'
                lastSummaryIndex = idx
                reasoningAcc += event.delta
                if (!reasoningStartEmitted) {
                  reasoningStartEmitted = true
                  onEvent?.({ type: 'reasoning_start' })
                }
              }
              break
            }
            case 'response.output_item.added': {
              // A new output item begins. For function_call items, register the
              // call_id<->item_id mapping and seed the accumulator with the name
              // (the name arrives here; the arguments stream as deltas).
              const item = event.item
              if (item.type === 'function_call') {
                itemIdToCallId.set(item.id ?? item.call_id, item.call_id)
                const existing = fnCallAcc.get(item.call_id) ?? { call_id: item.call_id, name: '', args: '' }
                if (item.name) existing.name = item.name
                if (item.arguments) existing.args = item.arguments
                fnCallAcc.set(item.call_id, existing)
              }
              break
            }
            case 'response.function_call_arguments.delta': {
              const callId = itemIdToCallId.get(event.item_id)
              if (callId) {
                const existing = fnCallAcc.get(callId)
                if (existing) existing.args += event.delta
              }
              break
            }
            case 'response.function_call_arguments.done': {
              const callId = itemIdToCallId.get(event.item_id)
              if (callId) {
                const existing = fnCallAcc.get(callId)
                // Prefer the finalized arguments string when present.
                if (existing && event.arguments) existing.args = event.arguments
              }
              break
            }
            case 'response.output_item.done': {
              // Final view of an item — captures the function_call's name/args/
              // call_id authoritatively (covers cases where the added/delta
              // events were missed or the item was emitted whole).
              const item = event.item
              if (item.type === 'function_call') {
                const existing = fnCallAcc.get(item.call_id) ?? { call_id: item.call_id, name: '', args: '' }
                if (item.name) existing.name = item.name
                if (item.arguments) existing.args = item.arguments
                fnCallAcc.set(item.call_id, existing)
              }
              break
            }
            case 'response.web_search_call.searching':
            case 'response.web_search_call.in_progress': {
              if (!searchEmitted) {
                searchEmitted = true
                onEvent?.({ type: 'searching' })
              }
              break
            }
            case 'response.completed': {
              const resp = event.response
              lastFinish = resp.status ?? lastFinish
              if (resp.model) modelUsed = resp.model
              const u = resp.usage
              if (u) {
                const mapped = {
                  inputTokens: u.input_tokens ?? 0,
                  outputTokens: u.output_tokens ?? 0,
                  totalTokens: u.total_tokens ?? 0,
                  cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
                  reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
                }
                totalUsage = totalUsage
                  ? {
                      inputTokens: totalUsage.inputTokens + mapped.inputTokens,
                      outputTokens: totalUsage.outputTokens + mapped.outputTokens,
                      totalTokens: totalUsage.totalTokens + mapped.totalTokens,
                      cachedInputTokens: totalUsage.cachedInputTokens + mapped.cachedInputTokens,
                      reasoningTokens: totalUsage.reasoningTokens + mapped.reasoningTokens,
                    }
                  : mapped
              }
              break
            }
            case 'response.failed':
            case 'response.incomplete': {
              const resp = event.response
              lastFinish = resp.status ?? lastFinish
              // An incomplete response (e.g. max_output_tokens) still carries
              // whatever text streamed; surface 'length' so gpt.ts marks it.
              if (resp.incomplete_details?.reason === 'max_output_tokens') {
                lastFinish = 'length'
              }
              const u = resp.usage
              if (u) {
                const mapped = {
                  inputTokens: u.input_tokens ?? 0,
                  outputTokens: u.output_tokens ?? 0,
                  totalTokens: u.total_tokens ?? 0,
                  cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
                  reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
                }
                totalUsage = totalUsage
                  ? {
                      inputTokens: totalUsage.inputTokens + mapped.inputTokens,
                      outputTokens: totalUsage.outputTokens + mapped.outputTokens,
                      totalTokens: totalUsage.totalTokens + mapped.totalTokens,
                      cachedInputTokens: totalUsage.cachedInputTokens + mapped.cachedInputTokens,
                      reasoningTokens: totalUsage.reasoningTokens + mapped.reasoningTokens,
                    }
                  : mapped
              }
              break
            }
            case 'error': {
              // Stream-level error event (type: 'error'). Throw so the catch
              // block maps it to the right OpenAIRequestRejected reason where
              // applicable. code/message sit directly on the event.
              throw Object.assign(new Error(event.message ?? 'response error'), { code: event.code ?? undefined })
            }
            default:
              break
          }
        }

        const fnCalls = [...fnCallAcc.values()].filter(c => c.name)

        // No tool calls → final answer.
        if (fnCalls.length === 0) {
          onEvent?.({ type: 'done' })
          const parsed = parseStructuredReply(contentAcc)
          return {
            react: parsed.react,
            reply: parsed.reply,
            usage: totalUsage,
            finishReason: lastFinish,
            durationMs: Date.now() - start,
            modelUsed,
            reasoning: reasoningAcc.trim(),
            toolCalls,
            files: collectedFiles,
          }
        }

        // Tool calls present. Append the model's function_call items to the
        // input, then dispatch each and append a matching function_call_output
        // (correlated by call_id), then loop. Per the Responses function-calling
        // contract: both the function_call item and the function_call_output
        // item must be present in the next request's input.
        for (const c of fnCalls) {
          inputItems.push({
            type: 'function_call',
            call_id: c.call_id,
            name: c.name,
            arguments: c.args || '{}',
          })
        }

        for (const c of fnCalls) {
          if (!toolRegistry) break
          const isSearch = c.name === 'web_search'
          let parsedArgs: Record<string, unknown> = {}
          try { parsedArgs = JSON.parse(c.args || '{}') } catch { /* empty / malformed args */ }
          onEvent?.(
            isSearch
              ? { type: 'searching' }
              : { type: 'tool_start', name: c.name, args: argPreview(parsedArgs) }
          )
          const t0 = Date.now()
          let resultStr = ''
          let failed = false
          try {
            resultStr = await toolRegistry.dispatch(c.name, parsedArgs, {
              channelId, userId, onFile: (p) => collectedFiles.push(p),
            })
          } catch (e: any) {
            failed = true
            resultStr = `Error in ${c.name}: ${e?.message ?? String(e)}`
          }
          const durationMs = Date.now() - t0
          const call = {
            name: c.name,
            args: parsedArgs,
            durationMs,
            resultPreview: previewToolResult(resultStr),
            failed,
          }
          onEvent?.({ type: 'tool_end', ...call })
          toolCalls.push(call)
          inputItems.push({
            type: 'function_call_output',
            call_id: c.call_id,
            output: resultStr,
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
        modelUsed,
        reasoning: reasoningAcc.trim(),
        toolCalls,
        files: collectedFiles,
      }
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status
      const code = e?.code ?? e?.error?.code
      if (status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
        throw new OpenAIRequestRejected(`rate_limited (${code ?? status})`, e)
      }
      if ((status === 400 && /content.*polic|safety/i.test(e?.message ?? '')) || code === 'content_policy_violation') {
        throw new OpenAIRequestRejected('content_policy', e)
      }
      throw e
    }
  }
}

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
