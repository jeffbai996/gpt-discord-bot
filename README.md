# gpt-bot

**A Discord bot that runs OpenAI's Codex CLI as a persistent, agentic chat engine.** It combines flat-subscription Codex sessions with live tool traces, multimodal input, voice, semantic memory, browser automation, and a metered API fallback.

Most turns run through **Codex with `gpt-5.6-sol`** on a ChatGPT subscription. The bot streams public progress and tool events into Discord while Codex searches, reads, edits, runs commands, and verifies work. The OpenAI API remains available as an explicit per-channel engine and as a guarded fallback after a confirmed Codex process failure.

> **Current shape:** persistent Codex sessions, four-mode thinking and trace surfaces, per-turn token telemetry, safe queueing and steering, plan approval, multimodal carryover, realtime voice, local RAG, and drain-safe deployment.

---

## What a turn looks like

While work is running, one Discord message stays alive in place:

```text
💭 ✻ thinking with high effort…
> 🧠 inspecting the current implementation
-# ◐ cogitating · 1m 12s elapsed · 31s since update
```

Tool calls stream into a separate diff-colored trace:

```diff
🔧 Tool trace
+ ● edit(/workspace/app/config.ts)
  ⎿ [+2, -1]
  const PORT = 8080
- const DEBUG = true
+ const DEBUG = false
+ ● shell(rg -n "DEBUG" src)
  ⎿ src/config.ts:3:const DEBUG = false [1 lines]
```

The completed reply can carry a compact two-row counter:

```text
Done — flipped DEBUG off and verified the only remaining reference.

-# ` input ↑  66,889      output ↓ 5,169    ◷ 145.8 s `
-# ` cache ↑ 958,376   reasoning ↓ 1,000    » 35.5 t/s`
```

Thinking, trace, and counter surfaces are independently configurable per channel. Turning them off hides the instrumentation, not the underlying tools.

---

## Chat engines

| Engine | Runs | Billing | Tool surface |
|---|---|---|---|
| **`codex`** (default) | persistent Codex CLI session; per-channel model and reasoning effort | ChatGPT subscription | shell, filesystem, network, web search, installed tools, MCP, images |
| **`api`** | OpenAI API request loop | metered tokens | built-in function registry, web/fetch/browser, semantic memory, MCP |

Codex receives images directly with `codex exec --image`; image turns no longer detour through the API. Fallback is intentionally conservative: an ordinary adapter error does not silently swap a repository task onto a weaker surface. The API path is used only when selected explicitly or after the bot confirms the Codex child actually died and the fallback grace window elapsed.

Normal Codex execution uses approvals and sandbox bypass so implementation requests can actually edit, test, commit, deploy, and use browser/MCP tools. Run the service under an appropriately isolated OS account. `/gpt plan` is the read-only exception: it launches the next turn with a read-only sandbox and waits for explicit approval before execution.

The bot consumes Codex's JSONL event stream for live progress and then reads the rollout artifact to recover file-edit hunks that are absent from the stream.

---

## Token telemetry

The reply footer is a tiny per-turn profiler rather than decorative token confetti:

- `input ↑` is **new, uncached input** for this turn.
- `cache ↑` is replayed prompt-prefix input reported by the provider.
- `output ↓` is generated output.
- `reasoning ↓` is the reasoning-token shard.
- `◷` is wall-clock turn time; `»` is output tokens per second.

`/gpt counter token` keeps the single top row. `/gpt counter both` adds cache, reasoning, and throughput when those values exist. `/gpt counter off` removes the footer.

Codex reports cumulative usage when a session resumes, so gpt-bot stores the prior session snapshot and renders the **delta for the current turn**. Numeric columns expand for large values, remain right-aligned, and keep both pills equal-width. Zero cache/reasoning fields disappear instead of leaving fake zero telemetry.

Longer-horizon views:

- **`/gpt stats`** — persistent totals across restarts and channels, cache/reasoning splits, API-cost equivalent, model counts, uptime, context pressure, and the latest subscription-limit snapshot.
- **`/gpt cache`** — rolling 50-turn prompt-cache telemetry for one channel.
- **`/gpt limits`** — live ChatGPT subscription windows with usage bars and reset countdowns.

---

## Live thinking and tool traces

Both surfaces have four modes:

| Mode | Thinking | Tool trace |
|---|---|---|
| `off` | hidden | hidden |
| `on` | keep the completed reasoning card | keep the full paginated trace |
| `live` | one rolling current-thought headline | one rolling trace window capped to one Discord code-block card |
| `collapse` | stream the accumulated reasoning trace, then remove it after the linger | stream the full paginated trace, then delete it after the reply |

The trace renderer includes:

- live `shell`, `web_search`, `edit`, and other tool rows;
- Claude-style file diffs with aligned line numbers and `+N/-M` summaries;
- command-result previews with line counts;
- full pagination for `on` and `collapse`, without silently truncating late calls;
- one-card rolling behavior for `live`;
- credential-like string redaction before Discord rendering;
- display-width-aware truncation for wide Unicode and Discord's 2,000-character limit;
- persistent crash failsafes that clean up transient trace cards after a restart.

The live work bubble has a spinner, public Codex progress, and a delayed proof-of-life heartbeat. A healthy but quiet model therefore shows elapsed and idle time instead of looking dead. Discord edits are paced and bounded so a stuck UI request cannot wedge the underlying turn.

Lifecycle reactions track `received → thinking → searching/tooling → replied`, with distinct terminal states for interruption, truncation, blocking, denial, error, and intentional silence.

---

## Persistent conversation and turn control

- **Per-channel Codex sessions** resume across messages and bot restarts. `/gpt history` exposes the readable session transcript; `/gpt clear` drops the session and stamps a Discord-history cutoff so the next turn is genuinely fresh.
- **Automatic rollover** watches session input pressure. Before the context ceiling, the bot rolls older channel history into a summary, drops the oversized Codex session, and continues from the compacted context.
- **Token-aware Discord history** fetches up to 100 recent messages and trims by budget while always retaining a small recent floor.
- **Queueing** serializes work within a channel while other channels continue independently. Rapid follow-ups are batched into the next turn instead of spawning competing workers.
- **Steering/barge-in** lets a newer message replace stale work, but waits for a safe lifecycle boundary rather than killing Codex halfway through a shell command or file edit.
- **Hard stop** is available through `/gpt stop`, a lone `❌`/`X` message, or the reaction action. It kills the process group and clears queued follow-ups.
- **Continuity guard** detects implementation replies that end with “I'll do that next,” resumes the same session automatically, and requires completion or a concrete blocker.
- **Plan approval** arms the next message as read-only planning. React ✅ to execute the saved plan, ✏️ to revise it, or ❌ to cancel. Plans persist across restarts until their TTL expires.
- **Drain-safe restarts** let accepted turns finish, preserve deferred messages, coalesce duplicate restart requests, and restart from outside the service cgroup.

---

## Multimodal input and generated files

- **Images:** PNG, JPEG, WebP, and GIF are downloaded to private temporary files and passed directly to Codex vision. Bytes are cached for one hour.
- **Cross-turn images:** replying to an older image rehydrates that exact attachment. A text reference such as “that screenshot” can reuse the current user's latest image from the last hour. Plain text turns do not eagerly download old media.
- **Audio:** common Discord audio and voice-message formats are transcribed before the turn.
- **Documents:** text, source code, notebooks, email, JSON/data files, SVG, subtitles, PDF, RTF, EPUB, Word, PowerPoint, Excel, OpenDocument, and Apple iWork formats are extracted and injected as text, with size caps.
- **Archives:** ZIP members with supported text types are extracted; TAR, gzip, 7z, and binary Office variants use bounded best-effort text recovery.
- **Unsupported media:** video and unknown binaries are reported explicitly rather than silently ignored.
- **Outputs:** screenshots, generated images, and files returned by tools are attached back to Discord. Browser work is considered complete only after the relevant final-state screenshot is attached.

Attachments are processed with bounded sizes and temporary files are cleaned after the turn.

---

## Browser, tools, and memory

- **Interactive browser:** a browser tool can drive a logged-in Chromium session for JS-heavy or authenticated pages. MCP screenshot image blocks are materialized and attached to the reply.
- **Web tools:** `fetch_url` performs guarded extraction with SSRF protection; `web_search` uses a dedicated search model.
- **Multiple MCP servers:** comma-separated `GPT_MCP_URL` and `GPT_MCP_LABEL` values load independent streamable-HTTP servers. One failed server registers an explicit unavailable stub without disabling the others.
- **Shared knowledge tools:** optional HTTP/CLI integrations expose durable memory and file search to both engines.
- **Local semantic memory:** allowed channel messages are embedded with a local Ollama model and stored in SQLite + sqlite-vss. `search_memory` retrieves channel-scoped history.
- **Rolling summaries:** older conversation is summarized locally and injected above the recent message window. `/gpt compact` forces a rollup.
- **Persona layering:** the runtime persona, per-guild overrides, repository `AGENTS.md`, rolling summary, pinned facts, and current wall-clock context are composed for every turn. SIGHUP reloads persona and access state without a full restart.

The bot ignores other bot-authored messages, so multiple agents can share a channel without manufacturing an infinite meeting.

---

## Voice and reaction actions

`/gpt voice join` starts an OpenAI Realtime voice session in the caller's voice channel. The session receives the current persona, recent text-channel context, and a latency-filtered tool registry. `/gpt voice type` changes the voice, `/gpt voice speak` speaks one line, and `/gpt voice leave` disconnects.

Substantial coding work from a live call can be delegated to an optional background Codex helper; the result is injected back into the active conversation when it completes. TTS provides a fallback speech path.

Reactions on gpt's replies:

| Emoji | Action |
|---|---|
| 🔁 | regenerate in place |
| 🔍 | expand with more depth |
| 📌 | pin the reply into this channel's persistent context |
| ❌ | delete gpt's message |
| 🔇 / 🔊 | toggle the mention gate |
| ✏️ | make the user's next message edit this reply |

---

## Slash commands

Administrative commands are owner-gated and reply ephemerally where appropriate.

| Command | Purpose |
|---|---|
| `/gpt allow @user` / `/gpt revoke @user` | manage the user allowlist |
| `/gpt channel #channel enabled require_mention` | configure channel access |
| `/gpt settings [#channel]` | show all resolved channel settings |
| `/gpt mention [#channel]` | toggle mention gating with one tap |
| `/gpt engine codex\|api [#channel]` | choose the chat engine |
| `/gpt model [model] [#channel]` | show or set the Codex model |
| `/gpt effort none\|low\|medium\|high\|xhigh\|max [#channel]` | set reasoning effort |
| `/gpt thinking off\|on\|live\|collapse [#channel]` | configure reasoning display |
| `/gpt trace off\|on\|live\|collapse [#channel]` | configure tool-trace display |
| `/gpt counter off\|token\|both [#channel]` | configure per-turn telemetry |
| `/gpt plan` | make the next turn a read-only plan with reaction approval |
| `/gpt stop` | abort the active turn and queued follow-ups |
| `/gpt clear` | reset this channel's Codex and Discord context |
| `/gpt history` | show or attach the current Codex session transcript |
| `/gpt compact [#channel]` | force a rolling-summary update |
| `/gpt stats` | show persistent usage, context, and limit telemetry |
| `/gpt cache [#channel]` | show rolling automatic prompt-cache telemetry |
| `/gpt limits` | show ChatGPT subscription usage windows |
| `/gpt persona <filename>` | hot-swap the runtime persona |
| `/gpt voice join\|type\|leave\|speak` | control realtime voice |

Current Codex model choices: `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.

---

## Getting started

Requirements:

- Node.js 22+
- an installed and authenticated Codex CLI;
- a Discord application with Message Content intent;
- an OpenAI API key for fallback, search, transcription, and voice;
- optionally, an Ollama-compatible endpoint for local embeddings and summaries.

```bash
git clone <this-repo>
cd gpt-bot
npm install

mkdir -p ~/.gpt/channels/discord
cp .env.example ~/.gpt/channels/discord/.env
# Fill in DISCORD_BOT_TOKEN, DISCORD_APP_ID, and OPENAI_API_KEY.

npm run start
```

Runtime state defaults to `~/.gpt/channels/discord/` and can be moved with `GPT_STATE_DIR`.

| State | Purpose |
|---|---|
| `.env` | runtime configuration and credentials |
| `access.json` | allowlists and per-channel flags |
| `persona.md` / `persona.<guildId>.md` | default and per-guild personas |
| `channel-sessions.json` / `channel-usage.json` | persistent Codex sessions and usage baselines |
| `channel-cleared.json` | durable context-reset cutoffs |
| `memory.db` | channel messages, vectors, and rolling summaries |
| `pinned-facts.md` | reaction-pinned channel context |
| `global-stats.json` | cumulative token telemetry |
| `pending-placeholders.json` / `deferred-actions.json` | crash recovery and delayed cleanup |
| `plan-mode.json` / `restart-inbox.json` | plan approvals and restart-preserved work |

### Key environment variables

| Variable | Purpose |
|---|---|
| `GPT_STATE_DIR` | runtime state directory |
| `GPT_CODEX_BIN` | Codex CLI path |
| `GPT_CODEX_CHAT` | set `0` to disable Codex as the default engine |
| `GPT_CODEX_DEFAULT_REPO` | default repository for delegated Codex work |
| `GPT_CODEX_MAX_SESSION_INPUT_TOKENS` | session rollover threshold |
| `GPT_CODEX_IDLE_TIMEOUT_MS` / `GPT_CODEX_CHAT_TIMEOUT_MS` | meaningful-activity watchdog and hard runaway fuse |
| `GPT_CODEX_HEARTBEAT_DELAY_MS` / `GPT_CODEX_HEARTBEAT_MS` | proof-of-life delay and refresh interval |
| `GPT_CODEX_FALLBACK_MIN_ELAPSED_MS` | minimum elapsed time before a confirmed Codex death can fall back |
| `GPT_CODEX_KILL_GRACE_MS` | process-tree shutdown grace |
| `GPT_LIVE_UPDATE_INTERVAL_MS` / `GPT_LIVE_UI_SETTLE_MS` | Discord edit pacing and final settle bound |
| `GPT_LIVE_END_LINGER_MS` / `GPT_THOUGHT_LINGER_MS` | completed live-thinking and collapse cleanup timing |
| `GPT_TRACE_FAILSAFE_MS` | optional transient-trace crash-cleanup override |
| `GPT_HISTORY_TOKEN_BUDGET` | Discord-history budget |
| `GPT_MODEL` | API engine/fallback model |
| `GPT_MAX_TOOL_LOOPS` | API tool-loop cap |
| `GPT_MCP_URL` / `GPT_MCP_LABEL` | comma-separated MCP endpoints and labels |
| `OLLAMA_URL` | local OpenAI-compatible embeddings/summarization endpoint |
| `GPT_EMBEDDING_MODEL` / `GPT_EMBEDDING_DIM` | local embedding model and vector dimension |
| `GPT_EMBED_COOLDOWN_MS` | passive-ingestion throttle |
| `GPT_SUMMARIZATION_MODEL` / `_THRESHOLD` / `_BATCH_LIMIT` | rolling-summary configuration |
| `GPT_SEARCH_MODEL` | web-search side-call model |
| `GPT_PLAN_TTL_MS` | persisted plan approval lifetime |
| `GPT_CODEX_HELPER_BIN` / `GPT_VOICE_CODEX_TIMEOUT_MS` | optional voice-to-Codex worker |
| `OPENAI_REALTIME_MODEL` / `OPENAI_REALTIME_VOICE` | realtime voice configuration |
| `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | fallback speech configuration |
| `GPT_VOICE_TOOL_DENY` | tools withheld from latency-sensitive voice sessions |

---

## Deployment

The production shape is a systemd user service:

```bash
git push origin main
ssh <deploy-user>@<deploy-host> \
  'cd ~/gpt-bot && git pull && npm install && systemctl --user kill --kill-who=main -s SIGUSR2 gpt'
```

`SIGUSR2` requests the normal in-band deploy restart: active turns drain, duplicate requests coalesce, queued work is preserved, and a transient unit restarts the service from outside its cgroup. Use a direct `systemctl --user restart gpt` only for recovery when the bot cannot process the signal.

For persona or access changes only:

```bash
systemctl --user kill --kill-who=main -s HUP gpt
```

---

## Tests

```bash
npm run test
npx tsc --noEmit
```

The suite uses `node:test` and covers command contracts, access migration, token counters, trace pagination, live UI, Codex supervision, session rollover, queueing, plans, attachments, browser/MCP plumbing, memory, voice, restart recovery, secret redaction, and Discord rendering.

## License

MIT — see [LICENSE](./LICENSE).
