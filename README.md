# gpt-bot

**An OpenAI-backed Discord bot whose chat engine is the `codex` CLI running on a flat ChatGPT subscription — not the metered API.** Standalone TypeScript daemon, sibling to [gem-bot](https://github.com/jeffbai996/gem-bot): same shape, different brain, built to coexist in the same guild without looping.

The headline: most turns run through **codex (gpt-5.6-sol)** on a flat sub, so chat is effectively free. The bot surfaces everything codex does — every command, web search, and file edit — as a live, Claude-Code-style tool trace, and falls back to the metered API only when codex errors or the turn carries images.

> **Status:** codex-as-default-engine + full Claude-style trace surface. See [CHANGELOG.md](./CHANGELOG.md) for the per-epoch breakdown.

---

## What a turn looks like

In a channel with `trace` on, asking gpt to make an edit renders something like:

```
💭 ✻ thinking with high effort…     ← live placeholder, glyph spins each 1.5s
🛠️ ✻ running…                       ← status tracks what codex is doing
```
then settles to, top-to-bottom:
```
🔧 Tool trace
+ ● edit(/workspace/foo/config.ts)
 ⎿ [+2, -1]
 const PORT = 8080
-const DEBUG = true
+const DEBUG = false
+ ● shell(rg -n "DEBUG" src)
 ⎿ src/config.ts:3:const DEBUG = false [1 lines]

💭 ✓ thought for 19s
Done — flipped DEBUG off in config.ts and confirmed it's the only reference.
 ↑ 17,140 · ↓ 211 · ◷ 19s
```

The trace card (real commands, diffs first), the `💭 ✓ thought for Ns` line, and the token footer are each **per-channel toggleable**. With everything off you get just the prose reply — codex still does all the work, you just don't see the receipts.

---

## Two engines

| `/gpt engine` | Runs | Cost | Tools |
|---|---|---|---|
| **`codex`** (default) | the `codex` CLI (gpt-5.6-sol) on a flat ChatGPT sub | ~$0 — flat sub, not metered | agentic shell: web, file read/write under configured workspace roots, local tools, network |
| **`api`** | OpenAI Responses API (gpt-5.6-sol) | metered per-token | the bot's own function registry (`fetch_url`, `web_search`, `search_memory`, MCP) |

Codex runs `workspace-write` with network access, scoped to configured workspace roots. The bot streams codex's `--json` event log line-by-line so it can show work **live**, and reads the session **rollout** afterward to recover file-edit diffs (the `--json` stream omits hunk text). On any codex error — or when the turn has an image codex can't take — it transparently falls back to the API path.

---

## The tool trace

Byte-matched to the Claude Code bots' trace, rendered inside a ` ```diff ` fence (Discord colors `+` green / `-` red, desktop + mobile):

- **Live rows** stream as codex works: `+ ● shell(cmd)`, `+ ● web_search(query)`, `+ ● edit(path)`. Multi-line commands are flattened to one line.
- **File-edit diffs**, pulled from codex's rollout and rendered Claude-style: a ` ⎿ [+N, -M]` summary on its own grey line, then the changed lines (` ` context / `-` red / `+` green). **Edits render first** so a long shell-row list can't starve the diff out of the card's length budget.
- **Command output** on a ` ⎿ ` line, truncated to the command's width with a same-line `[N lines]` tag when it was long.
- **Secret redaction** — credential-looking strings are `<REDACTED>` before anything hits Discord (codex can edit `.env`/`auth.json`).
- **Caps** — per-line mega-cap + an overall char budget so a minified-file edit can't shatter the 2000-char message limit.

---

## Status indicators

- **Animated spinner** in the `✓`/`✗` slot (between the emoji and the word): `✻ ✢ ✱ ✶ ✷ ✸` cycling each 1.5s, dots pulsing alongside — `🛠️ ✻ running…`, `🌐 ✻ searching…`, `✏️ ✻ editing…`, `🧠 ✻ thinking…`. Lifted from the Claude bots.
- **`💭 ✓ thought for Ns`** — Claude-format duration (`40s`, `1m 5s`), settling where the spinner was.
- **`✗ Interrupted`** — when a turn dies to a restart/crash, a persistent placeholder registry sweeps the orphaned bubble to this on the next boot, and stamps a `❌` on the message that triggered it.
- **Lifecycle reactions** on your message: `👀 received → 🤔 thinking → ✅ replied`, with branches for `🌐 searching`, `🔧 tooling`, `⏳ interrupted`, `✂️ truncated`, `🛑 blocked`, `⚠️ denied`, `❌ errored`.

---

## Per-channel flags (slash-command pickers)

Each is its own subcommand with selectable choices (no free-text):

- **`/gpt trace off | on | collapse`** — the tool-trace card. `collapse` = show it live, keep it 120s, then delete for a clean channel.
- **`/gpt thinking off | on | collapse`** — the reasoning-summary card.
- **`/gpt engine codex | api`** — chat engine.
- **`/gpt effort none | low | medium | high | xhigh`** — codex reasoning effort (gpt-5.6-sol).
- **`/gpt counter off | token | both`** — the token/cost footer.
- **`/gpt mention on | off`** — require an @-mention to respond.

---

## Beyond chat

- **Squad memory** — on the codex path, the model can `recall` and **write** to a shared shared-memory (memory / journal) over HTTP; writes post a veto-card back to the channel. Set `SQUAD_STORE_URL` + `SQUAD_STORE_BOT`.
- **MCP tools** — any MCP server's tools auto-register over streamable-HTTP (`GPT_MCP_URL` / `GPT_MCP_LABEL`). Used in practice to wire an IBKR portfolio server (34 tools).
- **vecgrep** — semantic search hook (`GPT_VECGREP_BIN`) on the codex path.
- **Voice** — joins a voice channel and runs an OpenAI Realtime session (`OPENAI_REALTIME_MODEL`/`_VOICE`), with TTS fallback (`OPENAI_TTS_MODEL`/`_VOICE`). `codex_helper` hands substantial repo work to a separately installed privileged helper, acknowledges immediately, then injects the completion back into the call. This public repo does not contain the writable worker. `GPT_VOICE_TOOL_DENY` gates ordinary tools in voice.
- **Semantic memory (RAG)** — allowed messages are embedded (`text-embedding-3-small`) into sqlite-vss; the model can `search_memory`; background summarization rolls older history into a per-channel summary above the live context.
- **Multimodal** — images are passed to the Codex CLI for vision, audio is Whisper-transcribed, and text/code files are inlined; PDFs/video are surfaced as `[attachments not ingested]`.
- **Reaction actions** on the bot's replies — 🔁 regenerate, 🔍 expand, 📌 pin (per-channel pinned-facts injected into the prompt), ❌ delete, 🔇/🔊 mute, ✏️ edit-on-next-message.
- **`/gpt stats`** — token burn since boot + dollar-equivalent at gpt-5.6-sol rates (≈ $0 actual on the flat sub), in a code block.

---

## Getting started

```bash
git clone <this-repo>
cd gpt-bot
npm install
cp .env.example ~/.gpt/channels/discord/.env
# Fill in DISCORD_BOT_TOKEN, DISCORD_APP_ID, OPENAI_API_KEY (for the API fallback + embeddings/voice).
# For the codex engine: have the `codex` CLI installed + authed on the host's ChatGPT sub.
npm run start
```

State (allowlist, persona, embeddings DB, summaries, pinned facts, the placeholder registry) lives at `~/.gpt/channels/discord/` by default; override with `GPT_STATE_DIR`. Designed to run as a systemd user service; SIGHUP hot-reloads `access.json` + `persona.md`.

### Slash commands

`allow` · `revoke` · `channel` · `persona` · `compact` · `trace` · `thinking` · `engine` · `effort` · `counter` · `mention` · `stats` · `cache`

### Key env vars

| Var | Purpose |
|---|---|
| `GPT_CODEX_BIN` | path to the `codex` CLI (default the nvm v22 install) |
| `GPT_CODEX_HELPER_BIN` | path to the separately installed privileged helper used by `codex_helper` |
| `GPT_CODEX_DEFAULT_REPO` | repo under `~/repos` used when the read-only Codex tool gets no repo (default `gpt-bot`) |
| `GPT_CODEX_CHAT` | set `0` to force the API engine everywhere |
| `GPT_CODEX_HEARTBEAT_MS` | Discord proof-of-life animation while Codex is silent (default 5000) |
| `GPT_CODEX_IDLE_TIMEOUT_MS` | meaningful-activity watchdog; malformed/noisy JSONL does not reset it (default 600000) |
| `GPT_CODEX_CHAT_TIMEOUT_MS` | hard runaway fuse for a Codex turn, not the normal work limit (default 2700000) |
| `GPT_CODEX_KILL_GRACE_MS` | maximum wait for a killed child to close before the queue force-settles (default 5000) |
| `GPT_VOICE_CODEX_TIMEOUT_MS` | hard timeout for background Codex jobs delegated from voice (default 1800000) |
| `GPT_LIVE_UI_SETTLE_MS` | maximum wait for a Discord progress edit during final cleanup (default 5000) |
| `GPT_THOUGHT_LINGER_MS` | how long collapse keeps the thought-for / trace cards (default 120000) |
| `GPT_MCP_URL` / `GPT_MCP_LABEL` | MCP server to auto-register tools from |
| `SQUAD_STORE_URL` / `SQUAD_STORE_BOT` | shared shared-memory endpoint + this bot's identity |
| `GPT_SQUAD_STORE_BIN` / `GPT_VECGREP_BIN` | CLI paths the codex path shells out to |
| `OPENAI_REALTIME_MODEL` / `OPENAI_REALTIME_VOICE` / `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | voice |
| `GPT_MODEL` | default API model for unconfigured channels |
| `GPT_HISTORY_TOKEN_BUDGET` / `GPT_MAX_TOOL_LOOPS` | history budget + API tool-loop cap (default 256 rounds) |
| `GPT_SUMMARIZATION_MODEL` / `_THRESHOLD` / `_BATCH_LIMIT` | rolling channel summaries |

## Runtime

Node 22+ (the codex CLI + the streaming path assume it). Native modules (`better-sqlite3`, `sqlite-vss`, `jsdom`) degrade gracefully on older runtimes — the bot still runs, minus the affected feature (RAG / HTML extraction).

## Tests

```bash
node --test --import tsx tests/*.test.ts
```

## License

MIT — see [LICENSE](./LICENSE).
