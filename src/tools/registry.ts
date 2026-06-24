import type OpenAI from 'openai'

export interface ToolContext {
  channelId?: string
  userId?: string
}

// JSONSchema fragment describing the tool's args. Using a loose `unknown`
// instead of importing OpenAI's full schema type keeps the surface portable
// (e.g. for re-emitting via the MCP bridge in v0.10).
export type ToolParameters = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface Tool {
  name: string
  description: string
  parameters: ToolParameters
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()
  private order: string[] = []

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`)
    }
    this.tools.set(tool.name, tool)
    this.order.push(tool.name)
  }

  // OpenAI Chat Completions wants tools shaped as
  // { type: 'function', function: { name, description, parameters } }.
  // We hand back exactly that array; the caller passes it as the `tools`
  // request param.
  toOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return this.order.map(n => {
      const t = this.tools.get(n)!
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>
        }
      }
    })
  }

  // Responses API flattens the function-tool shape: name/description/parameters
  // sit at the top level (no nested `function` wrapper) alongside
  // `type: 'function'`. `strict: false` keeps the existing loose-schema tools
  // working — strict mode would require every property be `required` plus
  // `additionalProperties: false`, which our tool schemas don't all satisfy.
  // The caller passes this as the `tools` request param.
  toResponsesTools(): OpenAI.Responses.FunctionTool[] {
    return this.order.map(n => {
      const t = this.tools.get(n)!
      return {
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
        strict: false,
      }
    })
  }

  size(): number {
    return this.tools.size
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return `Unknown tool: ${name}`
    try {
      return await tool.execute(args, ctx)
    } catch (e: any) {
      return `Error in ${name}: ${e?.message ?? String(e)}`
    }
  }
}
