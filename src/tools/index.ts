import OpenAI from 'openai'
import { ToolRegistry } from './registry.ts'
import { fetchUrlTool } from './fetch-url.ts'
import { browseTool } from './browse.ts'
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

// Async because MCP autoload makes a streamable-HTTP connection at boot.
// `client` is the real OpenAI client (web-search side-call needs a real model).
// `embedClient` backs search_memory's query embedding — it must be the SAME
// backend that ingestion used to store vectors (local Ollama by default), or
// query and stored vectors live in different spaces and search returns noise.
// Defaults to `client` for backward compatibility / tests.
export async function buildDefaultRegistry(client: OpenAI, memory: MemoryStore | null = null, embedClient: OpenAI = client): Promise<ToolRegistry> {
  const registry = new ToolRegistry()
  registry.register(fetchUrlTool)
  // browse drives Jeff's logged-in Chrome (CDP attach) — reads pages behind a
  // login / heavy JS that fetch_url's plain GET can't. Same host, same `jbai` user.
  registry.register(browseTool)
  registry.register(makeWebSearchTool(client))
  // Registered unconditionally: squad-memory search talks to shared-memory over
  // HTTP, so it needs no local SQLite store (unlike search_memory below).
  registry.register(makeSquadMemoryTool())
  // Same posture: the squad files read-tool is HTTP-only, no local store.
  registry.register(makeSquadFilesTool())
  registry.register(makeCodexTool())
  if (memory) {
    registry.register(makeSearchMemoryTool(embedClient, memory))
  }

  // MCP autoload — opt-in via GPT_MCP_URL. Supports MULTIPLE servers via
  // comma-separated GPT_MCP_URL (+ matching comma-separated GPT_MCP_LABEL),
  // e.g. GPT_MCP_URL=http://…:8001/mcp,http://…:8772/mcp with
  // GPT_MCP_LABEL=ibkr,playwright. A single value is the common case and still
  // works unchanged. Each server is connected independently: one failing just
  // registers an unreachable stub for that label, the others still load.
  const mcpUrls = (process.env.GPT_MCP_URL || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const mcpLabels = (process.env.GPT_MCP_LABEL || '')
    .split(',').map(s => s.trim())
  for (let i = 0; i < mcpUrls.length; i++) {
    const url = mcpUrls[i]
    const label = mcpLabels[i] || url
    try {
      const mcpClient = await connectMcpClient(url)
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
