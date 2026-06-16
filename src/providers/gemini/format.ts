// Gemini history + tool-schema formatting. Ported from:
//   - gem-bot/src/history.ts (formatHistory → coreMessagesToContents)
//   - gem-bot/src/tools/mcp-schema.ts (mcpSchemaToGemini)
//   - gem-bot/src/gemini.ts (buildTools → registryToGeminiTools)
//
// Adaptation notes:
//   - Input is gpt-bot's CoreMessage (not gem-bot's HistoryMessage, which has
//     the same shape — they're the same type, just different repo copies).
//   - Role is derived from authorId === selfId (model vs user).
//   - For non-self messages, the author name is prefixed into the text part
//     so the model can distinguish speakers in multi-user channels.
//   - Attachments in CoreMessage carry URLs/mimeTypes in the `attachments`
//     field; the gpt-bot Provider contract doesn't upload files to Files API,
//     so history attachments degrade to text breadcrumbs (same as gem-bot for
//     older messages). The current user's imageParts come in via RespondInput.
//
// Tool-schema: mcpSchemaToGemini converts the JSON-Schema `parameters` object
// on each Tool to the Gemini FunctionDeclaration shape. Properties that can't
// be represented (anyOf, unknown types) are skipped with a console.error.

import { Type } from '@google/genai'
import type { Schema } from '@google/genai'
import type { CoreMessage, CoreImagePart } from '../../core/provider.ts'
import type { ToolRegistry } from '../../tools/registry.ts'
import { stripBotMetadata } from '../../history.ts'

// ---- Types ----

// Gemini SDK Content shape (inline to avoid importing the SDK type in tests).
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }

// ---- History formatting ----

// Describe an attachment as text when we don't have a cached File API URI for it.
function describeAttachment(att: { name: string; mimeType: string | null }): string {
  const mime = att.mimeType ?? ''
  const kind = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : 'file'
  return `[previous ${kind}: ${att.name}]`
}

// Convert CoreImagePart[] to Gemini Part[]. Prefers inlineData for base64
// images; falls back to fileData for URI-based images. Used for the current
// user's imageParts in respond() (not history — history uses text breadcrumbs).
export function coreImagePartsToGeminiParts(parts: CoreImagePart[]): Part[] {
  return parts.map(p => {
    if (p.dataBase64) {
      return { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } }
    }
    if (p.url) {
      // Gemini SDK accepts fileData.fileUri for public URLs as well as File API URIs.
      return { fileData: { mimeType: p.mimeType, fileUri: p.url } }
    }
    // Neither base64 nor URL — degrade to a text placeholder.
    return { text: `[image: ${p.mimeType}]` }
  })
}

// Convert gpt-bot's CoreMessage[] to Gemini Content[].
// Ported from gem-bot/src/history.ts:formatHistory, adapted to CoreMessage shape.
//
// selfId: the bot's Discord user ID. Messages with authorId === selfId get
//   role='model'; all others get role='user'.
//
// History attachments degrade to text breadcrumbs (no re-upload of file bytes
// for older messages — same approach as gem-bot's ATTACHMENT_FRESH_TAIL=1 but
// simplified: gpt-bot doesn't maintain a File API URI cache in history.ts).
export function coreMessagesToContents(messages: CoreMessage[], selfId: string): Content[] {
  return messages.map(m => {
    const isSelf = m.authorId === selfId
    const parts: Part[] = []

    // History attachments → text breadcrumbs (no File API in gpt-bot history)
    const attachmentText = m.attachments.map(describeAttachment).join(' ')

    let text: string
    if (isSelf) {
      // Strip footer/metadata lines from our own past replies so the model
      // doesn't pattern-match and re-emit them (same as OpenAIProvider).
      const cleanedContent = stripBotMetadata(m.content)
      text = [cleanedContent, attachmentText].filter(Boolean).join(' ')
    } else {
      // Prefix non-self author name so the model distinguishes speakers.
      const body = [m.content, attachmentText].filter(Boolean).join(' ')
      text = `${m.authorName}: ${body}`
    }

    parts.unshift({ text })

    return { role: isSelf ? 'model' : 'user', parts }
  })
}

// ---- Tool schema conversion ----

type JSONSchema = Record<string, any>

// Convert an MCP tool's JSON Schema to Gemini's Schema.
// Returns null when the schema can't be represented (e.g. anyOf/oneOf).
// Ported verbatim from gem-bot/src/tools/mcp-schema.ts.
function mcpSchemaToGemini(schema: unknown): Schema | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as JSONSchema

  if (s.anyOf || s.oneOf) return null

  // Normalize `{type: ["string", "null"]}` to the non-null primitive.
  let type = s.type
  if (Array.isArray(type)) {
    const nonNull = type.filter((t: string) => t !== 'null')
    if (nonNull.length !== 1) return null
    type = nonNull[0]
  }

  if (typeof type !== 'string') return null

  const out: Schema = {} as Schema

  switch (type) {
    case 'string':
      out.type = Type.STRING
      break
    case 'number':
    case 'integer':
      out.type = Type.NUMBER
      break
    case 'boolean':
      out.type = Type.BOOLEAN
      break
    case 'array': {
      out.type = Type.ARRAY
      const itemSchema = s.items ? mcpSchemaToGemini(s.items) : null
      if (itemSchema) (out as any).items = itemSchema
      break
    }
    case 'object': {
      out.type = Type.OBJECT
      const props: Record<string, Schema> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const converted = mcpSchemaToGemini(v)
        if (converted) {
          props[k] = converted
        } else {
          console.error(`[mcp-schema] skipping unrepresentable property "${k}"`)
        }
      }
      ;(out as any).properties = props
      const required: string[] = Array.isArray(s.required) ? s.required.filter((r: string) => r in props) : []
      ;(out as any).required = required
      break
    }
    default:
      return null
  }

  if (typeof s.description === 'string') (out as any).description = s.description
  if (Array.isArray(s.enum)) (out as any).enum = s.enum
  return out
}

// Options for registryToGeminiTools.
export interface GeminiToolOptions {
  // Include the googleSearch grounding tool (requires the model to support it).
  // Default: false. The GeminiProvider passes true when grounding is needed.
  googleSearch?: boolean
}

// Convert a ToolRegistry into Gemini tool declarations.
// Ported from gem-bot/src/gemini.ts:buildTools + mcpSchemaToGemini.
//
// Excluded (TODO(1b-followup)):
//   - codeExecution: deferred, requires mime-aware drop logic
//
// googleSearch grounding flag is included here because it's a core capability,
// not an enhancement — the provider exposes nativeWebSearch: true and needs to
// be able to enable it.
export function registryToGeminiTools(
  registry: ToolRegistry,
  options: GeminiToolOptions = {}
): any[] {
  const tools: any[] = []

  // Google Search grounding (opt-in per call via options)
  if (options.googleSearch) {
    tools.push({ googleSearch: {} })
  }

  // TODO(1b-followup): codeExecution — requires mime-aware drop logic (omit when
  // request contains audio/video) matching gem-bot's contentsHaveAudioVideo check.

  // User-defined function declarations — convert each Tool's JSON-Schema parameters
  // to Gemini's FunctionDeclaration shape via mcpSchemaToGemini.
  if (registry.size() > 0) {
    // Use the OpenAI-shaped list as our source of truth for tool names/descriptions/params.
    // We convert the parameters to Gemini schema. This avoids adding Gemini-specific
    // methods to the provider-neutral ToolRegistry.
    const oaiTools = registry.toOpenAITools()
    const declarations: any[] = []
    for (const oaiTool of oaiTools) {
      const fn = oaiTool.function
      const paramsSchema = mcpSchemaToGemini(fn.parameters)
      const decl: any = {
        name: fn.name,
        description: fn.description,
      }
      if (paramsSchema) {
        decl.parameters = paramsSchema
      }
      declarations.push(decl)
    }
    if (declarations.length > 0) {
      tools.push({ functionDeclarations: declarations })
    }
  }

  return tools
}
