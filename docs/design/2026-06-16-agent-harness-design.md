# Agent Harness — Design Spec

**Date:** 2026-06-16
**Status:** Draft for review

## Goal

Collapse two drifted Discord-bot forks — this repo (OpenAI-backed) and its
Gemini sibling — into **one model-agnostic harness** where the LLM provider is a
plugin and each bot is a *config*, not a fork. GPT and Gemini both work day one.
The two bots are ~85% duplicated already; the harness is mostly **extraction +
abstraction of what exists**, not new building.

## Non-goals (YAGNI)

- **Not a published library / separate package.** One repo. `core/` is kept
  cleanly isolated so it *could* be extracted into an importable package later,
  but a separate package's versioning + link plumbing isn't worth it for a
  handful of in-house bots.
- **No voice on OpenAI.** Voice stays Gemini-only (it's wired to a Gemini-Live
  IPC daemon; an OpenAI Realtime port is a separate project).
- **No multi-agent / agent-to-agent.** Single-agent harness.
- **No rebuilding working tools for purity.** Registry-native tool model
  (option A), not pure-MCP.

## Architecture — one repo, three layers

```
src/
  core/        provider-agnostic engine (knows nothing about OpenAI/Gemini)
  providers/   the model plugins (openai, gemini)
  bots/        per-bot CONFIG (provider + persona + channels + mcp urls + voice)
```

### core/ — the engine
The Discord orchestration loop and everything provider-neutral:
- ingest → build-context → call provider → stream/parse → dispatch tools → reply
- `ToolRegistry` (uniform `Tool` interface, JSON-Schema params)
- persona, history, RAG memory (sqlite-vss), pinned-facts, token-budget,
  summarization, chunking, reactions, slash-commands, access control

core talks ONLY to a `Provider`. It never imports an SDK.

### providers/ — the model plugins
The one new abstraction. Seeded from the existing `openai.ts`, whose
`LifecycleEvent` / `RespondInput` / `RespondResult` types already model this:

```ts
interface Provider {
  readonly id: string                                  // 'openai' | 'gemini'
  respond(input: RespondInput): Promise<RespondResult> // streaming chat + tool-call loop
  formatTools(registry: ToolRegistry): unknown         // registry → this API's tool schema
  embed(text: string): Promise<number[]>               // RAG embeddings
  readonly capabilities: {
    voice: boolean
    managedCache: boolean        // Gemini explicit context-cache vs OpenAI auto-prefix
    nativeWebSearch: boolean      // Gemini google_search grounding vs an OpenAI tool
  }
}
```

- **OpenAIProvider** — refactor of today's `openai.ts`: chat.completions
  streaming, tool_calls + structured-reply parsing, `embed` via the small
  embedding model, auto-prefix cache telemetry. `capabilities: { voice:false,
  managedCache:false, nativeWebSearch:false }`.
- **GeminiProvider** — port of the sibling's `gemini.ts` + `cache.ts`:
  generateContentStream, functionCalls, embed, managed context-cache, native
  google_search grounding. `capabilities: { voice:true, managedCache:true,
  nativeWebSearch:true }`.
- Caching is **provider-internal** — each handles its own strategy behind
  `respond()`; core never sees it.

### bots/ — configs, not code
A bot stops being a codebase and becomes a config:

```ts
interface BotConfig {
  id: string                 // 'gpt' | 'gemma' | …
  provider: 'openai' | 'gemini'
  model: string
  personaPath: string
  stateDir: string           // ~/.<bot>/channels/discord
  mcpServers: { label: string, url: string }[]   // e.g. a portfolio-data MCP, a shared-memory MCP
  voice: boolean
}
```

Launch: `harness --bot gpt`. The entry point loads the config, instantiates the
provider, builds the registry (built-ins + that bot's MCP servers), runs core.

## Tools — registry-native (option A)

One `ToolRegistry`. Built-in tools (fetch_url, search_memory [channel RAG],
squad-memory, web_search) register as `Tool` objects; MCP servers configured
per-bot are auto-wrapped into the same registry via the existing mcp-tools
loader (generalized). The provider turns the registry into its own tool-call
schema via `provider.formatTools(registry)` — this replaces today's
`toOpenAITools()` vs Gemini-`Type`-enum split (the `mcpSchemaToOpenAI` /
`mcpSchemaToGemini` converters already exist and become provider-owned).

**squad-memory merge.** The two forks diverged here: one has hybrid search +
relevance-%, the other has the recency path. The unified tool keeps **all
three modes** — `query` (hybrid search + %), `recent` (newest-first), `id`
(exact fetch) — with the 10k/entry + 24k-total truncation budget. Both bots get
the full tool. (Both forks were just brought to feature-parity on this; the
harness is where it becomes one implementation.)

**web_search.** A registry tool for the OpenAI provider; for Gemini it's a
provider-native grounding capability (`capabilities.nativeWebSearch`), not a
registry tool — core checks the capability rather than registering a tool.

## Voice — Gemini-gated

`voice.ts` + `voice-commands.ts` move into the harness but register ONLY when
`provider.capabilities.voice && botConfig.voice`. The OpenAI provider reports
`voice:false`, so the slash commands simply aren't present there. The
Gemini-Live IPC daemon is unchanged.

## Data flow

```
message
  → core.ingest         RAG-embed via provider.embed, store in sqlite-vss
  → core.handle         build system prompt (persona + pinned + summary + context),
                        fetch history, format tools via provider.formatTools
  → provider.respond    stream; tool-call loop: emit tool_call → core dispatches
                        via registry → feed result back → continue until final
  → core.reply          chunk + render to Discord
```

## Migration — phased, no live bot ever breaks

- **Phase 0** — In this repo, add `core/` + `providers/`; extract the `Provider`
  interface; refactor `openai.ts` → `OpenAIProvider`. Behavior identical; the
  bot still runs as-is. Ship. (Sibling bot untouched.)
- **Phase 1** — Add `GeminiProvider` (port the sibling's `gemini.ts` + cache).
  The harness can now run as either provider. Add the `bots/` config layer; this
  bot's launch becomes `bots/gpt`. Ship.
- **Phase 2** — Move the Gemini-only modules (voice, the sibling's sqlite-vss
  store reconciled into core's memory module, any Gemini-only tools) into the
  harness as gated/shared modules. Stand up a `bots/gemma` config. Run the
  Gemini bot FROM the harness in parallel (separate state dir / test channel) to
  verify parity against the live sibling.
- **Phase 3** — Cut the Gemini bot's service over to the harness. Retire the
  sibling repo. **Rename this repo to `bot-harness`** (approved 2026-06-16) and
  update the service unit names accordingly. The harness is now the single home
  for all bots.

Each phase is independently shippable and gated on a green test suite. Two live
bots keep serving throughout.

## Testing

- `core/` is tested provider-agnostically against a **FakeProvider**
  (deterministic `respond`/`embed`) — the engine's logic verified without any
  network or SDK.
- Each provider is tested against its API contract (tool-call parse, structured
  reply, streaming) with a stubbed client — the existing per-bot tests carry
  over.
- The merged squad-memory tool keeps its mode tests (query / recent / by-id /
  truncation).
- Every migration phase must leave the full suite green before it ships.

## Risks / things to settle during implementation

- **Memory store reconciliation.** The two forks have slightly different
  sqlite-vss schemas (one `db.ts`, one `memory.ts`). Phase 2 merges them into a
  single core memory module; the schema delta is small but must be settled
  without orphaning either bot's existing embeddings DB.
- **respond() must capture both tool-call loop shapes.** OpenAI (a `tool_calls`
  array, possibly parallel) vs Gemini (`functionCalls`). The existing
  `LifecycleEvent` union already abstracts the streaming events; the loop
  controller in core drives both, with each provider normalizing its raw stream
  into that event shape.
- **Per-bot identity must stay generic in source.** Personas, channel IDs,
  MCP URLs, and any portfolio/account specifics live in per-bot config +
  external persona files, never in `core/`/`providers/` source (per AGENTS.md).
```
