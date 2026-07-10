# Changelog

Versioning is `0.MAJOR` (no patch level). Each version reflects a shippable feature epoch; intermediate fixes fold into the surrounding range. Pre-1.0 — breaking changes possible between minors until the public API stabilizes.

Tags are annotated; check them out with `git checkout v0.N` to inspect that point.

This repo is the OpenAI sibling of [gem-bot](https://github.com/jeffbai996/gem-bot). Same architecture (standalone daemon, structured-output reply, tool registry, reaction-driven actions, persistent summarization, MCP autoload). Versions track in parallel where the feature surface overlaps; they diverge where the underlying API does (e.g., Gemini's manual context caching has no OpenAI analog beyond automatic prefix caching).

---

## v0.12 — 2026-05-21 — second parity sync (post-gem-voice)

Catches up with gem-bot changes that landed during gem's voice work (May 19-20). Voice itself is deferred — gem-voice is gem-specific (Gemini Live API + custom IPC daemon) and OpenAI's Realtime equivalent would need its own daemon; not in scope for this pass.

- **Per-guild persona override** — `PersonaLoader.load()` now also scans the state dir for `persona.<guildId>.md` siblings (where guildId is a 17-20 digit Discord snowflake). `buildSystemPrompt` takes an optional guildId and prefers the per-guild override when present. Falls through to the default for DMs (no guildId) and guilds without an override. Lookup is O(1) on an in-memory Map populated at load. (Gem parity: ports `dc10e5a9`.)
- **`/gpt model` — codex model picker** — current choices are GPT-5.6 Sol/Terra/Luna; retired choices are no longer accepted.
- **Parser-fix verified no-op** — gem's `42063eb3` fix (unescape literal `\n` in `parseResponse` JSON-fail fallback) doesn't apply. gpt's `parseStructuredReply` + `extractPartialReply` already handle `\n`/`\r`/`\t` character-by-character and the fallback path doesn't return raw escaped strings.
- **Voice deferred** — gem shipped `7c7fe01e` (VoiceManager), `9939a05f` (/voice slash commands), `dddd4cf9` (intent + wiring), and follow-up debug commits. The architecture requires a separate `gem-voice` IPC daemon (Unix socket at `/tmp/gem-voice.sock`) that opens the voice WebSocket itself. Porting cleanly to gpt would require building an OpenAI Realtime equivalent daemon — out of scope here. Gpt's discord.js client doesn't yet request the `GuildVoiceStates` intent and has no `/gpt voice` subcommand.
- 6 new tests for `rewriteEnvVar` (replace-in-place, comments+ordering preserved, append-if-missing with newline, file-creates-if-missing, atomic-no-tmp-left, prefix-key rejection). Total test count: 81 (up from 75).

## v0.11 — 2026-05-19 — sister-repo parity sync

Bring gpt-bot up to gem v0.12 equivalent for production-ready parallel use in the same server.

- **Reasoning lifecycle state wired** — `🧠 reasoning` reaction now fires when a gpt-5 reasoning model emits its first reasoning-summary delta. De-duped per turn. The OpenAI analog of Gem's `native_thinking` from gemini-3 thinking parts.
- **Outbound react validator wired** — `isValidOutboundReactEmoji` existed in `reactions/vocabulary.ts` with full test coverage but was never imported. The model's structured-output `react` field is now gated; custom Discord emoji names (`:pack_sticker_14:` etc) get silently dropped + logged instead of bothering Discord with calls that return 10014 'Unknown Emoji'.
- **Cache + reasoning token telemetry** — `RespondResult.usage` adds `cachedInputTokens` (from `prompt_tokens_details.cached_tokens`, OpenAI's automatic prefix caching) and `reasoningTokens` (from `completion_tokens_details.reasoning_tokens`, gpt-5 internal reasoning cost). Accumulated across tool-loop iterations. Verbose footer renders both inline only when nonzero, e.g. `↑ 4,231 (cached 3,840) ↓ 512 (reasoning 192) » 2.3s gpt-5`.
- **`/gpt cache info` slash subcommand** — rolling per-channel telemetry. `src/cache-stats.ts` ring-buffers the last 50 turns; `snapshot(channelId)` aggregates hit rate, totals, distinct models seen, window age. Card surfaces all that ephemerally. OpenAI's caching is automatic with no TTL/flush controls, so the card explains as much. (Gem's `/gemini cache ttl|flush` don't port — they're Gemini-specific.)
- 8 new tests for `cache-stats` (empty channel, single turn, accumulation, ring-buffer cap, channel isolation, model tracking, null-usage skip, zero-input edge case). Total test count: 75 (up from 67).

## v0.10 — MCP autoload

Auto-discovers and registers tools exposed by an external MCP server, transparently bridging MCP → OpenAI function-calls. The bot can now talk to a broker integration (or any MCP service) without per-tool wiring.

- `src/tools/mcp-client.ts` — connects to a streamable-HTTP MCP endpoint via `@modelcontextprotocol/sdk`.
- `src/tools/mcp-schema.ts` — `mcpSchemaToOpenAI()` converts MCP JSON Schema to the shape OpenAI's function-calling expects. Handles nullable type unions (`["string", "null"]` → `"string"`), drops unrepresentable properties (anyOf/oneOf), preserves description/enum/required.
- `src/tools/mcp-tools.ts` — `loadMcpTools(client)` enumerates server tools and wraps each as a bot Tool whose `execute()` forwards to `client.callTool` and joins text content blocks into a single string.
- `src/tools/mcp-unreachable-stub.ts` — `makeUnreachableStub(label)` returns a stub Tool registered when MCP connect fails at boot. Gives the model a valid surface to call when asked, instead of hallucinating MCP tool names.
- `buildDefaultRegistry()` becomes async; opt-in via `GPT_MCP_URL` env. Friendly label override via `GPT_MCP_LABEL`.
- Bot is generic — works with any MCP server, not just IBKR. Boot log surfaces the registered count.
- 6 new tests cover the schema converter (simple object, nullable collapse, anyOf rejection, array items, root-must-be-object, description/enum preservation).

## v0.9 — summarization scheduler

Persistent rolling per-channel summaries, injected into the system prompt for older context. Lets the bot remember channels with thousands of messages without overflowing the prompt window.

- `src/summarization/store.ts` — `SummaryStore` wraps the `conversation_summaries` SQLite table (added to `MemoryStore` schema). DI surface (`getSummary` / `upsertSummary`) lets tests swap in a fake.
- `src/summarization/summarizer.ts` — `runSummarization()` builds the prompt (previous summary + new messages since last cutoff) and runs a one-shot completion. Param shape branches on model family (gpt-5.x takes `max_completion_tokens` only; legacy models keep `temperature` + `max_tokens`).
- `src/summarization/scheduler.ts` — `SummarizationScheduler` is single-flight per channel and fire-and-forget from the caller. `scheduleIfNeeded(channelId)` runs only when the un-summarized message count crosses the threshold (default 50, configurable via `GPT_SUMMARIZATION_THRESHOLD`). `runForChannel(channelId)` forces an immediate rollup regardless of threshold (used by `/gpt compact`).
- `gpt.ts` schedules summarization after every passive ingest. Dependency-graceful: when the native sqlite-vss / better-sqlite3 modules fail to load, the scheduler is null and ingestion / summarization both skip.
- `PersonaLoader.buildSystemPrompt()` injects the channel's summary above the pinned-facts block when a summary exists.
- `/gpt compact` slash command — forces a rollup now and reports the message count back to the user (or "nothing new to summarize").
- `GPT_SUMMARIZATION_MODEL` defaults to `gpt-5.6-luna` because summarization is a low-bar synthesis task and the latency/cost wins are real.
- 7 new tests cover the summarizer (empty input throws, summary trimmed, last-id correct), store DI, and scheduler flow (skips below threshold, runs when met, forced rollup with 0/N messages).

## v0.8 — reaction-driven actions

User reactions on the bot's own messages now drive bot actions.

- **🔁 regenerate** — re-runs the same prompt and edits the existing reply in place rather than spawning a new message
- **🔍 expand** — re-runs with a "go deeper / add detail" preamble; posts a fresh follow-up
- **📌 pin** — appends the reply to a per-channel pinned-facts file at `~/.gpt/channels/discord/pinned-facts.md`. Pinned content is injected into the system prompt for that channel on every subsequent turn.
- **❌ delete** — bot deletes its own message
- **🔇 mute** / **🔊 unmute** — toggle `requireMention` on the channel without losing other flag state
- **✏️ markForEdit** — marks the bot message as edit-target; the user's next message in that channel edits it in place rather than producing a new reply

New modules:
- `src/reactions/vocabulary.ts` — emoji → action map + outbound react-emoji validator (ZWJ-aware Unicode-only matcher to skip the model's `:custom_name:` Discord-emoji hallucinations).
- `src/reactions/pending-edits.ts` — in-memory map with TTL for the ✏️ flow.
- `src/reactions/handler.ts` — dispatches incoming `messageReactionAdd` events to action handlers, gated on `access.canReact`.
- `src/reactions/actions.ts` — the actions themselves. `regenerate`/`expand` call back into the bot's main message-handling pipeline via a `rerunHandler` callback.
- `src/pinned-facts.ts` — sectioned per-channel append-only markdown file. Sync read for system-prompt assembly; async append on pin.
- `gpt.ts` is restructured: extracts `handleUserMessage(message, targetMessage, expansion)` from the messageCreate body so reactions and pending-edit consumers can re-invoke the same pipeline.
- `PersonaLoader` gains `setPinnedFactsStore(store)`; `buildSystemPrompt(channelId)` now appends the channel's pinned facts to the system prompt.

12 new tests cover vocabulary mapping, ZWJ sequence validation, pending-edits TTL, and the pinned-facts read/append round-trip with truncation.

## v0.7 — semantic memory + RAG

Adds long-term recall over channel history. Every allowed user message gets embedded and stored; the model can call `search_memory(query)` during the tool loop to fetch semantically-relevant past context.

- `src/memory.ts` — `MemoryStore` class wraps `better-sqlite3` + `sqlite-vss`. Schema: `messages` table (id, channel_id, author_id, author_name, content, timestamp) + `vss_messages` virtual table for 1536-dim embeddings (`text-embedding-3-small`). Both native modules dynamic-imported with graceful fallback when the runtime ABI doesn't match.
- `MemoryStore.open()` returns null when natives fail to load; bot logs a warning and continues without RAG.
- `embed()` helper handles empty input, API failures, and missing data without throwing — callers null-check.
- `src/tools/search-memory.ts` — `search_memory(query, limit)` registered into the default registry only when memory is available. Uses VSS cosine search scoped to the current channel.
- `gpt.ts` — passive ingestion: every allowed user message in an enabled channel gets embedded + stored in the background. Independent of the reply gate, so the bot learns from non-mention conversation. Errors logged, never thrown.
- 4 tests for the embedding helper (empty, success, throws, no-data). Native-module integration verified live.

Verified live: text-embedding-3-small returns the expected 1536-dim vector via our `embed()` wrapper.

## v0.6 — ToolRegistry + web_search + fetch_url

Pluggable function-calling tools. The model can now decide it needs to read a URL or search the web, and the tool loop dispatches the call, feeds results back, and lets the model compose its final reply from the gathered context.

- `src/tools/registry.ts` — `ToolRegistry` with `register()` / `dispatch()` / `toOpenAITools()`. The latter wraps registered tools in OpenAI's `{ type: 'function', function: {…} }` shape ready to splice into a Chat Completions request.
- `src/tools/fetch-url.ts` + `fetch-url-internal.ts` — fetches a URL with: SSRF guard (resolve hostname, refuse private IP ranges incl. IPv4/IPv6/IPv4-mapped), 15s timeout, 5MB body cap, content-type-aware extraction (HTML via Readability+JSDOM, JSON pretty-print, text/markdown passthrough). Output capped at 8000 chars by default, hard cap 50000.
- `src/tools/web-search.ts` — `web_search(query)` runs a side-call to `gpt-4o-mini-search-preview` (configurable via `GPT_SEARCH_MODEL` env) so the main model can ground on Bing-search results without being promoted to a search-preview variant for every turn.
- `OpenAIClient.respond()` gains a tool loop: when `toolRegistry` is supplied and non-empty, the request includes `tools` + `tool_choice: 'auto'`, drops `response_format` for that turn (incompatible with tool_calls), and iterates until a non-tool finish reason. Capped at 5 iterations. Each tool dispatch fires `tool_start`/`tool_end` lifecycle events; `web_search` specifically fires `searching` so the bot reacts 🌐 instead of 🔧.
- `gpt.ts` wires the lifecycle handler to render 🌐 (searching) and 🔧 (tooling) on the user's message.
- jsdom + readability are dynamically imported so the rest of the test suite stays green on Node versions that don't satisfy jsdom's modern-ArrayBuffer requirements (Node 22+ for the actual HTML pipeline).
- 14 new tests cover registry behavior, IPv4/IPv6 SSRF guard, scheme rejection, content extraction, and the public fetch_url tool surface.

Verified end-to-end live: gpt-5.6 successfully called `fetch_url("https://example.com")`, ingested the page, and composed a grounded reply.

## v0.5 — multimodal + DM intent

Adds image understanding, audio transcription, text-file extraction, and DM channel support.

- `src/attachments.ts` — `processAttachments()` handles each Discord attachment by mime type:
  - **Images** (`image/png|jpeg|webp|gif`) become `image_url` content parts pointing at the Discord CDN URL. Vision-capable models (gpt-5.x, gpt-4o) ingest them inline.
  - **Audio** (mpeg/mp4/wav/webm/ogg/flac/m4a) downloads then transcribes via `audio.transcriptions` (default `whisper-1`); transcript splices into the text payload.
  - **Text files** (text/*, json, markdown, csv, html, source code) downloads up to 100KB and inlines as a fenced code block.
  - **Anything else** (PDF, video, archives) is surfaced as a `[attachments not ingested]` text note so the model can ask follow-up questions rather than silently ignoring the file.
  - 20MB cap per attachment; oversized → `too_large` skip.
- `OpenAIClient.respond()` accepts `imageParts` (spliced into the user message as content parts) and `extraText` (appended below the user prose). Single-string content-shape preserved when no multimodal is attached.
- `gpt.ts` — discord client gains `DirectMessages` + `DirectMessageReactions` + `DirectMessageTyping` intents. The 📎 ingesting lifecycle reaction fires only when there's actually an attachment to process; plain-text messages skip it.
- Tests cover empty / image / oversized / unsupported / charset-suffix paths.

Verified end-to-end: gpt-5.6 received a red placeholder image and correctly described it as "Red." through our `respond()` wrapper.

## v0.4 — streaming + lifecycle reactions

Replies stream into Discord as the model generates, and lifecycle reactions surface what's happening inside a turn.

- **Streaming** — `OpenAIClient.respond()` switches to `stream: true` with `stream_options: { include_usage: true }` so we still get usage tokens at end-of-stream. The placeholder `💭 thinking…` reply is edited in place every ~700ms with the in-flight reply text. On stream end, the placeholder becomes the final response (zero-duplicate guarantee on chunk-count changes).
- **Mid-stream JSON parsing** — `extractPartialReply()` walks the in-progress JSON string for the `"reply"` value, unescaping common sequences (`\n`, `\"`, `\uXXXX`). Tolerant of incomplete escapes. Final parse uses the same `parseStructuredReply()` from v0.3 once the full chunk arrives.
- **Lifecycle reactions** — `src/reactions/lifecycle.ts` ports the squad pattern. `👀 received` fires before any work; `🤔 thinking` fires when the model call starts; `✅ replied` / `✂️ truncated` (`finish_reason === 'length'`) / `🛑 blocked` (content-policy) / `⚠️ denied` (rate-limit/quota) / `❌ errored` are terminal. Predecessors get cleared on transition so the row of reactions stays compact. Reasoning + searching + tooling emojis are reserved for v0.5/v0.6.
- **Silent-exit** matches v0.3 behavior — clears all transients, deletes placeholder, leaves no tombstone.

## v0.3 — openai SDK + minimum viable bot

First version that actually talks to OpenAI. Non-streaming, no tools, no multimodal — just system prompt + history + user message → reply.

- `src/openai.ts` — `OpenAIClient.respond()` returns structured `{ react, reply, usage, finishReason, durationMs, modelUsed }`. Uses Chat Completions with `response_format: { type: "json_object" }` for the structured shape. GPT-5 models use `reasoning_effort` instead of `temperature`+`max_tokens`. `'minimal'` reasoning collapses to `'low'` until the SDK catches up.
- `src/history.ts` — `fetchHistory()` pulls the most recent 30 Discord messages before the current one. `formatHistoryForOpenAI()` converts to Chat Completions message shape, mapping bot messages to `assistant` and everyone else to `user` (author name prefixed inside content). `stripBotMetadata()` drops `-#` footer lines from the bot's past replies before feeding back so the model doesn't pattern-match its own footer format.
- `OpenAIRequestRejected` typed exception for rate-limit/quota and content-policy refusals — emitted as `⚠️` instead of `❌` in the user-facing error.
- `gpt.ts` — placeholder `💭 thinking…` reply, edits to the final response on completion. Silent-exit if model returns empty `{react: null, reply: ""}`. Verbose footer (`-# ↑ N · ↓ N · » Ns · model`) when channel flag enables it.
- Tests: `parseStructuredReply` covers happy path, code-fence stripping, trailing prose, malformed input.

## v0.2 — discord layer (echo-only, no LLM)

Builds the discord plumbing end-to-end without yet wiring up an OpenAI client. Lets you verify gateway, intents, allowlist, mention rules, slash-command admin flow, and chunking before any model spend.

- `AccessManager` — JSON-backed allowlist (users + channels), per-channel flags (`model`, `reasoning`, `showCode`, `verbose`). State at `~/.gpt/channels/discord/access.json`.
- `PersonaLoader` — reads `persona.md` from state dir, falls back to a default. Hot-swappable via `/gpt persona <filename>`.
- `chunk()` — splits replies under Discord's 2000-char limit, preserving fenced code blocks across split boundaries.
- Slash command `/gpt` with subcommands: `allow`, `revoke`, `channel`, `persona`, `set` (model | reasoning | show_code | verbose).
- `gpt.ts` entry — discord client with Guilds + GuildMessages + MessageContent intents, slash-command handler, message handler that echoes the request back with the resolved per-channel flags. Bot-vs-bot loop guard via `message.author.bot` check so this can coexist with sibling bots in the same channel.
- SIGHUP reload of `access.json` + `persona.md` (no full restart).
- Tests for `chunk` and `AccessManager` under `node --test`.

## v0.1 — initial scaffold

Repo skeleton — no runtime code yet. Establishes the project shape that subsequent versions extend.

- `package.json` with `discord.js`, `openai`, `dotenv`, `tsx`.
- `tsconfig.json` matching the sibling gem-bot conventions (ESNext, strict, Bundler resolution).
- `.gitignore` covering `node_modules`, `.env*`, runtime state files (`persona.md`, `access.json`), and internal-only doc directories.
- `.env.example` with the required env-var shape.
- MIT license, AGENTS.md context, README skeleton.
