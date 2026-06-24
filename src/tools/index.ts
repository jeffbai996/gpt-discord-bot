import OpenAI from 'openai'
import { ToolRegistry } from './registry.ts'
import { fetchUrlTool } from './fetch-url.ts'
import { makeWebSearchTool } from './web-search.ts'
import { makeSearchMemoryTool } from './search-memory.ts'
import { makeSquadMemoryTool } from './squad-memory.ts'
import { makeSquadFilesTool } from './squad-files.ts'
import { makeCodexTool } from './codex.ts'
import { connectMcpClient } from './mcp-client.ts'
import { loadMcpTools } from './mcp-tools.ts'
import { makeUnreachableStub } from './mcp-unreachable-stub.ts'
import type { MemoryStore } from '../memory.ts'

export { ToolRegistry } from './registry.ts'
export type { Tool, ToolContext } from './registry.ts'

// Async because MCP autoload makes a streamable-HTTP connection at boot.
export async function buildDefaultRegistry(client: OpenAI, memory: MemoryStore | null = null): Promise<ToolRegistry> {
  const registry = new ToolRegistry()
  registry.register(fetchUrlTool)
  registry.register(makeWebSearchTool(client))
  // Registered unconditionally: squad-memory search talks to shared-memory over
  // HTTP, so it needs no local SQLite store (unlike search_memory below).
  registry.register(makeSquadMemoryTool())
  // Same posture: the squad files read-tool is HTTP-only, no local store.
  registry.register(makeSquadFilesTool())
  registry.register(makeCodexTool())
  if (memory) {
    registry.register(makeSearchMemoryTool(client, memory))
  }

  // MCP autoload — opt-in via GPT_MCP_URL. Failures are logged + an
  // unreachable stub is registered so the model has a valid tool surface to
  // call when asked about the missing service. Future: support multiple
  // servers via comma-separated GPT_MCP_URL or a JSON config.
  const mcpUrl = process.env.GPT_MCP_URL
  if (mcpUrl) {
    const label = process.env.GPT_MCP_LABEL || mcpUrl
    try {
      const mcpClient = await connectMcpClient(mcpUrl)
      const tools = await loadMcpTools(mcpClient)
      for (const t of tools) registry.register(t)
      console.error(`[mcp] connected to ${label}; registered ${tools.length} tools`)
    } catch (e) {
      console.error(`[mcp] connect to ${label} failed:`, e instanceof Error ? e.message : e)
      registry.register(makeUnreachableStub(label))
    }
  }

  return registry
}
