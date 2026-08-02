# gpt-bot — repository guide

This document provides context for agents working on `gpt-bot`.

## Project Overview

A standalone Discord bot using Discord.js with the Codex CLI as its default
agentic chat engine. Channels can switch among the supported Codex models or
explicitly use the metered OpenAI API engine. After a confirmed Codex failure,
automatic API routing is postmortem-only: it reports the failure without tools
and never continues the original task. The bot supports multimodal input and
tool use on its normal engines.

This file is injected as deep runtime context. Keep it limited to durable
gpt-specific architecture and operating facts. Voice, people, squad-wide
behavior, and current project state belong in live runtime context—not
duplicated here.

## Core Architecture

- **Language/Runtime:** TypeScript + Node.js (via `tsx`).
- **State Management:** All state (`.env`, `access.json`, `persona.md`, embeddings DB, summaries DB) lives in `~/.gpt/channels/discord/` by default. Override via `GPT_STATE_DIR`.
- **Bot Persona:** "gpt" — OpenAI/GPT squad bot. The live persona at `~/.gpt/channels/discord/persona.md` owns tone, identity, people, and addressing rules.
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
ssh <deploy-user>@<deploy-host> 'systemctl --user kill --kill-who=main -s HUP gpt'
```

Logs: `~/.gpt/channels/discord/gpt.log`.
