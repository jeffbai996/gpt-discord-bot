import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool, ToolContext } from './registry.ts'
import { mcpSchemaToOpenAI } from './mcp-schema.ts'

// Where image content blocks from MCP tools (e.g. Playwright screenshots) get
// written before being attached to the Discord reply. A scratch dir, pruned by
// the same systemd timer that prunes the Playwright MCP output (see shared-context
// modules/browse). Overridable via GPT_MCP_IMAGE_DIR.
const IMAGE_DIR = process.env.GPT_MCP_IMAGE_DIR
  || join(homedir(), '.cache', 'gpt-mcp-images')

let _imgSeq = 0

// An MCP image content block → a file on disk; return its path. We DON'T feed the
// base64 back to the model (it floods context + costs tokens for no benefit) —
// the path is recorded via ctx.onFile so gpt.ts attaches the actual image, and
// the model just sees a short "[screenshot attached]" marker.
function _saveImageBlock(p: any): string | null {
  const data: string | undefined = p?.data
  if (typeof data !== 'string' || !data) return null
  const mime: string = p?.mimeType || 'image/png'
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
    : mime.includes('webp') ? 'webp' : 'png'
  try {
    mkdirSync(IMAGE_DIR, { recursive: true })
    const path = join(IMAGE_DIR, `shot-${Date.now()}-${_imgSeq++}.${ext}`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  } catch {
    return null
  }
}

// Discover MCP tools from a connected client and wrap each as a bot Tool.
// Each tool's execute() forwards to client.callTool. Text blocks join into the
// returned string (what the model sees); IMAGE blocks are written to disk and
// handed to ctx.onFile (so gpt.ts can attach them to Discord) — the model sees a
// compact marker instead of base64.
export async function loadMcpTools(client: Client): Promise<Tool[]> {
  const { tools: mcpTools } = await client.listTools()
  const out: Tool[] = []
  for (const t of mcpTools) {
    const params = mcpSchemaToOpenAI(t.inputSchema) ?? { type: 'object' as const, properties: {}, required: [] }
    out.push({
      name: t.name,
      description: t.description ?? `MCP tool ${t.name}`,
      parameters: params,
      async execute(args, ctx: ToolContext) {
        const res = await client.callTool({ name: t.name, arguments: args })
        const parts = (res.content as any[]) ?? []
        const textOut: string[] = []
        for (const p of parts) {
          if (p?.type === 'text') {
            textOut.push(p.text)
          } else if (p?.type === 'image') {
            const path = _saveImageBlock(p)
            if (path && ctx?.onFile) {
              ctx.onFile(path)
              textOut.push('[screenshot captured and attached to the reply]')
            } else {
              textOut.push('[image result — could not attach]')
            }
          } else {
            textOut.push(JSON.stringify(p))
          }
        }
        return textOut.join('\n') || '[empty response]'
      }
    })
  }
  return out
}
