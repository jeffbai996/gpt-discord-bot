# gpt-bot — repository guide

This document provides context for agents working on `gpt-bot`.

## Project Overview

A standalone Discord bot using Discord.js and the OpenAI API (default
`gpt-5.6-sol`, with `gpt-5.5`, `gpt-5.6-terra`, and `gpt-5.6-luna` available as
manual switches per channel). It supports multimodal input and tool use.

This file is injected as deep runtime context. Keep it limited to durable
gpt-specific architecture and operating facts. Voice, people, squad-wide
behavior, and current project state belong in live runtime context—not
duplicated here.

## Core Architecture

- **Language/Runtime:** TypeScript + Node.js (via `tsx`).
- **State Management:** All state (`.env`, `access.json`, `persona.md`, embeddings DB, summaries DB) lives in `~/.gpt/channels/discord/` by default. Override via `GPT_STATE_DIR`.
- **Bot Persona:** "gpt" — OpenAI/GPT squad bot. The live persona at `~/.gpt/channels/discord/persona.md` owns tone, identity, people, and addressing rules.
- **Execution discipline:** when Jeff gives a direct implementation instruction, treat it as an order to start work immediately. Do the repo/service work and carry it through patch, verification, restart, commit, and push where applicable instead of replying with only a plan and waiting for another prompt.
- **Continuity:** do not end an implementation turn with a promise or progress-only message. Continue through the next safe implementation step without waiting for Jeff to say “continue.” Progress updates describe work actively underway; the user-visible final reply reports a completed result or a concrete blocker.
- **Bot-specific notes:** keep durable gpt runtime behavior here and voice or social behavior in persona files. Do not write bot-specific operating feedback into shared squad memory unless Jeff explicitly asks.
- **Admin Control:** Discord Slash Commands (`/gpt`) control permissions to avoid manual JSON edits.
- **Bot-vs-bot loop guard:** the bot ignores all `message.author.bot === true` senders. Sibling bots (e.g. gem) can therefore live in the same channel without triggering each other.

## Development Rules

- Use `tsx` for running the bot locally (`npm run start`).
- Use `node:test` for testing (`npm run test`).
- Keep features modular (`src/openai.ts`, `src/attachments.ts`, `src/chunk.ts`, etc).
- Avoid adding heavy database dependencies unless strictly necessary (SQLite is preferred if needed later).
- When processing media, use `Promise.allSettled` to maintain high throughput and non-blocking I/O.
- No personal data in source: no real ticker symbols, no internal hostnames, no real Discord IDs, no broker/portfolio details. Use generic defaults (AAPL, MSFT, GOOGL) and example IDs in docs.

## Deployment

Designed to run as a systemd user service (`gpt.service`) on a Linux host with Node 22+. The service invokes `node --import tsx/esm src/gpt.ts`.

Deploy flow (replace `<deploy-host>` and `<deploy-user>` with your own):

```bash
git push origin main
ssh <deploy-user>@<deploy-host> 'cd ~/gpt-bot && git pull && npm install && systemctl --user kill --kill-who=main -s SIGUSR2 gpt'
```

Use `SIGUSR2` for in-band deploy restarts. The bot drains active turns,
coalesces duplicate requests, then asks systemd to restart from a transient
unit outside `gpt.service`'s cgroup. Direct `systemctl restart gpt` is reserved
for recovery when the bot is unresponsive.

Hot reload (no restart — reloads `access.json` and `persona.md` only):

```bash
ssh <deploy-user>@<deploy-host> 'systemctl --user kill -s HUP gpt'
```

Logs: `~/.gpt/channels/discord/gpt.log`.

## Future Roadmap

- **Streaming + lifecycle reactions** (v0.4) — surface `👀 received → 🤔 thinking → ✅ replied` and terminal states (`✂️ truncated`, `🛑 blocked`, `⚠️ denied`, `❌ errored`).
- **Multimodal + DM intent** (v0.5).
- **ToolRegistry + web_search + fetch_url** (v0.6).
- **Semantic memory + RAG via sqlite-vss** (v0.7).
- **Reaction-driven actions** (v0.8) — user reactions on bot replies trigger regenerate / expand / pin / delete / mute / edit.
- **Summarization scheduler** (v0.9) — persistent rolling per-channel summaries injected into system prompt.
- **MCP auto-registration** (v0.10) — bridge MCP tool servers (e.g. broker integrations) to OpenAI function-calls.
