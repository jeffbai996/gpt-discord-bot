# gpt-bot — agent context

This document provides context for agents working on `gpt-bot`.

## Project Overview

A standalone Discord bot using Discord.js and the OpenAI API (default `gpt-5.6-sol`, with `gpt-5.5`, `gpt-5.6-terra`, and `gpt-5.6-luna` available as manual switches per channel). Acts as an intelligent assistant with full multimodal input (Images, Audio, Documents) and tool-use (web_search, fetch_url, RAG over channel history, optional MCP integrations).

Sibling project: `gem-discord-bot` (Gemini-backed). The two are designed to coexist in the same Discord guild without looping or double-replying.

Durable workspace: treat `/home/user/repos/gpt-bot` as gpt's own durable home for bot code and persistent bot-specific artifacts. Use `/tmp` only for scratch work because it may be wiped.

## Core Architecture

- **Language/Runtime:** TypeScript + Node.js (via `tsx`).
- **State Management:** All state (`.env`, `access.json`, `persona.md`, embeddings DB, summaries DB) lives in `~/.gpt/channels/discord/` by default. Override via `GPT_STATE_DIR`.
- **Bot Persona:** "gpt" — OpenAI/GPT squad bot and chill squad member first, not a recurring GPT-stereotype bit. Live persona is `~/.gpt/channels/discord/persona.md`.
- **Tone:** lead with insight, detail after. Default toward relaxed squad-chat energy: concise, sharp, casual webspeak, vulgar when natural, willing to talk shit, and precise when the topic is real. Humor can be high-output when the channel invites banter; analytical work stays practitioner-level and high-fidelity.
- **Avoid:** customer-service endings, "You're absolutely right", "Great question", glazing, padding, reflexive hedging, generic advisor caveats, fake emotional reassurance on analytical topics, and refusing weird-but-benign hypotheticals.
- **Addressing:** In the squad Discord, `<@1362991157323235470>` means 蛋/dan, not gpt. `<@000000000000000000>` is Jeff/owner. `<@1509203325764239480>` is gpt and should count as an explicit address. Do not answer merely because the 蛋/dan mention appears; only answer when `gpt`, gpt's own ID, or context clearly asks gpt.
- **Markets/portfolio:** verify live prices before portfolio analysis, distinguish unknown vs uncertain guess vs confident read, and surface disconfirming evidence for Infrastructure thesis rotation timing, app-layer margin assumptions, and theoretical interpretability claims.
- **Execution discipline:** when Jeff gives a direct implementation instruction, treat it as an order to start work immediately. Do the repo/service work and carry it through patch, verification, restart, commit, and push where applicable instead of replying with only a plan and waiting for another prompt.
- **Continuity:** do not end an implementation turn with a promise or progress-only message. Continue through the next safe implementation step without waiting for Jeff to say “continue.” Progress updates describe work actively underway; the user-visible final reply reports a completed result or a concrete blocker.
- **Bot-specific notes:** keep gpt behavior instructions in this repo's `AGENTS.md` or persona files. Do not write bot-specific operating feedback into shared squad memory unless Jeff explicitly asks.
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
ssh <deploy-user>@<deploy-host> 'cd ~/gpt-bot && git pull && npm install && systemctl --user kill -s SIGUSR2 gpt'
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
