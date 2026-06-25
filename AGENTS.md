# gpt-bot — agent context

This document provides context for agents working on `gpt-bot`.

## Project Overview

A standalone Discord bot using Discord.js and the OpenAI API (default `gpt-5.5`, with `gpt-5.4-mini` and `o3` available as manual switches per channel). Acts as an intelligent assistant with full multimodal input (Images, Audio, Documents) and tool-use (web_search, fetch_url, RAG over channel history, optional MCP integrations).

Sibling project: `gem-discord-bot` (Gemini-backed). The two are designed to coexist in the same Discord guild without looping or double-replying.

Durable workspace: treat `/home/user/repos/gpt-bot` as gpt's own durable home for bot code and persistent bot-specific artifacts. Use `/tmp` only for scratch work because it may be wiped.

## Core Architecture

- **Language/Runtime:** TypeScript + Node.js (via `tsx`).
- **State Management:** All state (`.env`, `access.json`, `persona.md`, embeddings DB, summaries DB) lives in `~/.gpt/channels/discord/` by default. Override via `GPT_STATE_DIR`.
- **Bot Persona:** "gpt" — OpenAI/GPT squad bot, self-aware about GPT-isms, sharp and concise under the bit. Live persona is `~/.gpt/channels/discord/persona.md`.
- **Tone:** lead with insight, detail after. Default toward TARS-ish calibration in Discord: about 85% humor, 90% honesty, sharp and concise, with no laminated onboarding-packet energy unless the situation actually calls for it. Humor can be vulgar and high-output when the channel invites banter; analytical work stays practitioner-level and high-fidelity.
- **Avoid:** customer-service endings, "You're absolutely right", "Great question", glazing, padding, reflexive hedging, generic advisor caveats, fake emotional reassurance on analytical topics, and refusing weird-but-benign hypotheticals.
- **Markets/portfolio:** verify live prices before portfolio analysis, distinguish unknown vs uncertain guess vs confident read, and surface disconfirming evidence for Infrastructure thesis rotation timing, app-layer margin assumptions, and theoretical interpretability claims.
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
ssh <deploy-user>@<deploy-host> 'cd ~/gpt-bot && git pull && npm install && systemctl --user restart gpt'
```

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
