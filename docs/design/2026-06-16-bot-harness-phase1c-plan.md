# bot-harness Phase 1c — Config layer + generic runner

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Make the bot launchable from a **config** that selects the provider, by extracting `gpt.ts`'s orchestration into a provider-agnostic `core/` runner. After this, `bots/gpt` is a thin config + `runBot(config)` call, and a Gemini bot is launchable the same way (its live parallel-run is Phase 2). **Zero behavior change for the live GPT bot.**

**Architecture:** `gpt.ts` currently threads a raw OpenAI client (`openaiRaw`) into four subsystems — embed (ingestion + search_memory), the web_search tool, attachment audio-transcription (Whisper), and summarization. The runner decouples the first two (embed → `provider.embed` which exists since Phase 0; tools → provider-aware registry) and **OpenAI-gates** the last two for now (Gemini does audio natively / summarization is a follow-up). A `BotConfig` + a provider factory drive `runBot(config)`.

**Tech Stack:** TS + Node, `tsx`, `node:test`. Branch: `feat/phase1c-config-runner`. Spec: `docs/design/2026-06-16-agent-harness-design.md`. Depends on Phase 0/1a/1b (Provider, CoreMessage, OpenAIProvider, GeminiProvider all merged).

**Deferred (NOT in 1c — explicit):**
- A live `bots/gemma` parallel-run + cutover → **spec Phase 2/3**.
- Gemini audio transcription (it's multimodal-native; OpenAI keeps Whisper) and Gemini summarization → **follow-up**; both stay `provider.id === 'openai'`-gated.
- The 1b enhancements (grounding footers / code-exec / managed cache) → 1b-follow-up.

---

## File Structure
- **Create** `src/core/bot-config.ts` — the `BotConfig` interface + a `createProvider(config)` factory (switch on `config.provider`).
- **Create** `src/core/run-bot.ts` — `runBot(config: BotConfig)`: the generic Discord orchestration extracted from `gpt.ts` (client + intents, `ready`/`interactionCreate`/`messageCreate` handlers, ingest, handleUserMessage, login), parameterized by the provider + config. Provider-specific bits (Whisper transcription, summarizer) gated on `provider.id`.
- **Modify** `src/tools/index.ts` — `buildDefaultRegistry` becomes provider-aware: takes an `embed` fn (or the `Provider`) instead of the raw OpenAI client; registers `web_search` only when `provider.capabilities.nativeWebSearch === false` (OpenAI); `search_memory` uses `provider.embed`.
- **Modify** `src/tools/search-memory.ts` / `src/tools/web-search.ts` — `makeSearchMemoryTool` takes an embed fn (not the OpenAI client); `makeWebSearchTool` stays OpenAI-specific (only registered for OpenAI).
- **Modify** `src/gpt.ts` → becomes the thin **`src/bots/gpt.ts`** entry: defines the gpt `BotConfig` and calls `runBot(config)`. (Keep the `gpt.service` ExecStart working — either keep the file at `src/gpt.ts` re-exporting, or update the systemd unit; see Task 5.)
- **Create** tests: `tests/core/bot-config.test.ts` (factory picks the right provider), `tests/core/run-bot.test.ts` (runner wiring with a FakeProvider, no real Discord — test the pure handler logic that's extractable).

---

### Task 1: `BotConfig` + provider factory

**Files:** `src/core/bot-config.ts`, `tests/core/bot-config.test.ts`

- [ ] **Step 1: Failing test:**
```ts
import { createProvider, type BotConfig } from '../../src/core/bot-config.ts'
import { test } from 'node:test'; import assert from 'node:assert/strict'

test('createProvider returns the provider named by config', () => {
  const base: BotConfig = {
    id: 'gpt', provider: 'openai', model: 'gpt-5.6-luna', apiKey: 'k',
    stateDir: '/tmp/x', personaPath: '/tmp/p.md', mcpServers: [], voice: false
  }
  assert.equal(createProvider(base).id, 'openai')
  assert.equal(createProvider({ ...base, id: 'gemma', provider: 'gemini', model: 'gemini-3-flash-preview' }).id, 'gemini')
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `src/core/bot-config.ts`:
```ts
import type { Provider } from './provider.ts'
import { OpenAIProvider } from '../openai.ts'
import { GeminiProvider } from '../providers/gemini/gemini-provider.ts'

export interface BotConfig {
  id: string
  provider: 'openai' | 'gemini'
  model: string
  apiKey: string
  stateDir: string
  personaPath: string
  mcpServers: { label: string, url: string }[]
  voice: boolean
}

export function createProvider(c: BotConfig): Provider {
  switch (c.provider) {
    case 'openai': return new OpenAIProvider(c.apiKey, c.model)
    case 'gemini': return new GeminiProvider(c.apiKey, c.model)
    default: throw new Error(`unknown provider: ${(c as any).provider}`)
  }
}
```
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git add src/core/bot-config.ts tests/core/bot-config.test.ts && git commit -m "feat(core): BotConfig + provider factory"`

---

### Task 2: Decouple embedding from the raw OpenAI client

**Files:** `src/tools/search-memory.ts`, `src/tools/index.ts`, `src/gpt.ts` (ingestMessage), tests as needed

- [ ] **Step 1:** Change `makeSearchMemoryTool` to take an `embed: (text: string) => Promise<number[]>` instead of the OpenAI client. (Read its current body — it calls the client to embed the query; swap that for the injected `embed`.) Update its existing test (`tests/tools/search-memory.test.ts`) to pass a fake `embed`.
- [ ] **Step 2:** In `ingestMessage` (`gpt.ts:117`), replace `embed(openaiRaw, message.content)` with `provider.embed(message.content)`. (Provider.embed exists since Phase 0.) Handle the empty-vector case from the Phase 0 note: **if `provider.embed` returns `[]` (empty), skip storing** — don't write a zero-length vector to the store. Add that guard here.
- [ ] **Step 3:** Run full suite + tsc → green. (Behavior-preserving: OpenAIProvider.embed wraps the same memory.ts embed.)
- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor(core): embedding goes through provider.embed, not the raw client"`

---

### Task 3: Provider-aware tool registry

**Files:** `src/tools/index.ts`, `tests/tools/registry.test.ts`

- [ ] **Step 1: Failing test** — `buildDefaultRegistry` registers `web_search` for an OpenAI-like provider (nativeWebSearch=false) but NOT for a Gemini-like one (nativeWebSearch=true). Use a stub provider object with the right `capabilities` + `embed`.
- [ ] **Step 2:** Change `buildDefaultRegistry` signature from `(client: OpenAI, memory)` to `(provider: Provider, memory)`. Inside:
  - `search_memory`: `makeSearchMemoryTool((t) => provider.embed(t), memory)`.
  - `web_search`: register `makeWebSearchTool(...)` **only if `!provider.capabilities.nativeWebSearch`** (OpenAI). Gemini relies on native grounding (wired in the 1b-followup). `makeWebSearchTool` still needs the OpenAI client — for the OpenAI branch only, construct it from the provider; OR keep `web_search` OpenAI-specific and pass the OpenAI client through `BotConfig`/provider. Simplest: have `OpenAIProvider` expose a `rawClient` getter used only here. Document why.
  - MCP autoload: unchanged (already env/config-driven).
- [ ] **Step 3:** Run full suite + tsc → green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor(tools): provider-aware registry (web_search OpenAI-only, embed via provider)"`

---

### Task 4: Extract the generic `runBot(config)` runner

**Files:** `src/core/run-bot.ts`, `tests/core/run-bot.test.ts`

- [ ] **Step 1:** Create `src/core/run-bot.ts` exporting `async function runBot(config: BotConfig)`. Move into it, from `gpt.ts`: the `AccessManager`/`PersonaLoader`/`PinnedFactsStore`/`MemoryStore`/`SummaryStore` setup (parameterized by `config.stateDir`/`config.personaPath`), the `createProvider(config)` call, `buildDefaultRegistry(provider, memory)`, the Discord `Client` + intents, the `ready`/`interactionCreate`/`messageCreate`/`ingestMessage`/`handleUserMessage` handlers, and `client.login(config token from env)`.
- [ ] **Step 2: Gate the provider-specific subsystems:**
  - **Attachments transcription:** `processAttachments` needs an OpenAI client for Whisper. Gate it: only transcribe audio when `provider.id === 'openai'` (pass the OpenAI client only then); for other providers, skip audio transcription (leave a `// TODO(phase1c-followup): Gemini native audio`).
  - **Summarizer:** construct the `SummarizationScheduler` only when `provider.id === 'openai'` (it uses the OpenAI client). `// TODO(phase1c-followup): provider-agnostic summarization`.
- [ ] **Step 3:** Where `handleUserMessage` calls the model, it already uses the `Provider` interface (`provider.respond(...)`) from Phase 0/1a — keep that. Ensure nothing inside the runner references `openaiRaw` except the two gated OpenAI-only branches.
- [ ] **Step 4: Test** — extract any pure handler logic worth unit-testing (e.g. the should-respond decision) and test it with a FakeProvider. The Discord client wiring itself is covered manually (mocking discord.js is heavy — note this).
- [ ] **Step 5:** Run full suite + tsc → green.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(core): generic runBot(config) runner extracted from gpt.ts"`

---

### Task 5: `gpt.ts` becomes the thin `bots/gpt` entry

**Files:** `src/gpt.ts` (or new `src/bots/gpt.ts`)

- [ ] **Step 1:** Reduce `gpt.ts` to: read env (token/app id/keys/model/state dir), build the gpt `BotConfig`, call `await runBot(config)`. Everything else now lives in `run-bot.ts`.
```ts
import { runBot } from './core/run-bot.ts'
import type { BotConfig } from './core/bot-config.ts'
import path from 'path'; import os from 'os'

const config: BotConfig = {
  id: 'gpt',
  provider: 'openai',
  model: process.env.GPT_MODEL || 'gpt-5.6',
  apiKey: process.env.OPENAI_API_KEY!,
  stateDir: process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord'),
  personaPath: /* existing persona path */ '',
  mcpServers: process.env.GPT_MCP_URL ? [{ label: process.env.GPT_MCP_LABEL || 'mcp', url: process.env.GPT_MCP_URL }] : [],
  voice: false
}
await runBot(config)
```
- [ ] **Step 2: Keep `gpt.service` working.** The unit's ExecStart runs `src/gpt.ts` — keep the file at `src/gpt.ts` (don't move to `src/bots/`) so the systemd unit is unchanged, OR move to `src/bots/gpt.ts` and update the unit's ExecStart. Pick the file-stays-put option to avoid touching deploy. Note the choice in the commit.
- [ ] **Step 3: Boot smoke-check** — `node --import tsx -e "import('./src/gpt.ts')..."` resolves; full suite + tsc green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor(gpt): thin bots/gpt entry over runBot(config)"`

---

## Definition of done
- `BotConfig` + `createProvider` factory exist; `runBot(config)` runs the bot generically; `gpt.ts` is a thin config + `runBot` call.
- Embedding goes through `provider.embed`; the registry is provider-aware (web_search OpenAI-only).
- Whisper transcription + summarization are OpenAI-gated (deferred for Gemini).
- Full suite green; tsc clean; **GPT bot runs byte-identically** (this is the gate — it's a behavior-preserving extraction).
- A Gemini bot is now *launchable* via a BotConfig — but standing up + parallel-running live Gemma is Phase 2.

## Deploy
After review + merge: on the deploy host, discard dependency-lock churn if needed → `git pull --ff-only` → `npm install` → restart the service → confirm the bot replies normally (behavior-preservation is the whole point).

## Note for the executor
This is the highest-risk phase so far — it restructures the live GPT bot's entry. Go task-by-task, keep the full suite green at every step, and treat "Gem boots + replies identically after deploy" as the real acceptance test. If extracting the runner reveals coupling the plan didn't anticipate (e.g. a handler that reaches a module-level singleton), STOP and report rather than guessing — a broken runner takes down the live GPT bot.
