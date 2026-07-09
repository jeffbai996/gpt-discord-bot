# bot-harness Phase 0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a provider-agnostic `Provider` seam into gpt-bot — core talks to a `Provider` interface instead of `OpenAIClient` directly — with **zero behavior change**. This is the structural foundation the Gemini provider plugs into in Phase 1.

**Architecture:** Add `src/core/provider.ts` (the `Provider` contract + the neutral lifecycle/response types). Make the existing `OpenAIClient` implement it as `OpenAIProvider`. Add a `FakeProvider` for provider-agnostic core tests. Repoint `gpt.ts` to the interface. OpenAI SDK types still flow through `RespondInput.history` for now — neutralizing the *message* types is deferred to Phase 1, when a second provider actually forces it (YAGNI).

**Tech Stack:** TypeScript + Node, `tsx`, `node:test`. Spec: `docs/design/2026-06-16-agent-harness-design.md`.

---

## File Structure

- **Create** `src/core/provider.ts` — the `Provider` interface + re-homed neutral types (`ParsedResponse`, `LifecycleEvent`, `RespondInput`, `RespondResult`). Single responsibility: the contract between core and any model backend.
- **Create** `src/providers/fake-provider.ts` — a deterministic `Provider` for tests (no network).
- **Modify** `src/openai.ts` — `OpenAIClient` implements `Provider`; add `id`, `capabilities`, `embed()`; import the shared types from `core/provider.ts` instead of declaring them. Export an `OpenAIProvider` alias.
- **Modify** `src/gpt.ts` — type the provider handle as `Provider`; call `provider.embed()` instead of the free `embed(client, …)` where the provider is in scope.
- **Create** `tests/core/provider.test.ts` — the interface is satisfiable; `FakeProvider` conforms; capabilities are correct.

> Note: the superpowers default plan dir `docs/superpowers/plans/` is **gitignored in this repo**; plans live in `docs/design/` alongside the spec.

---

### Task 1: Define the `Provider` interface + re-home shared types

**Files:**
- Create: `src/core/provider.ts`
- Test: `tests/core/provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/provider.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Provider } from '../../src/core/provider.ts'

test('a minimal object can satisfy the Provider contract', () => {
  const p: Provider = {
    id: 'stub',
    defaultModel: 'm',
    capabilities: { voice: false, managedCache: false, nativeWebSearch: false },
    async respond() {
      return { react: null, reply: '', usage: null, finishReason: 'stop', durationMs: 0, modelUsed: 'm' }
    },
    async embed() { return [0, 0, 0] }
  }
  assert.equal(p.id, 'stub')
  assert.equal(p.capabilities.voice, false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --import tsx tests/core/provider.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/provider.ts'`.

- [ ] **Step 3: Create `src/core/provider.ts`**

Move the four shared types out of `openai.ts` verbatim and add the `Provider` interface. (They are currently declared in `src/openai.ts:4-60` — `ParsedResponse`, `LifecycleEvent`, `RespondInput`, `RespondResult`.)

```ts
import type OpenAI from 'openai'
import type { ToolRegistry } from '../tools/registry.ts'

export interface ParsedResponse {
  react: string | null
  reply: string
}

export type LifecycleEvent =
  | { type: 'thinking_start' }
  | { type: 'reasoning_start' }
  | { type: 'first_token' }
  | { type: 'partial', reply: string }
  | { type: 'tool_start', name: string, args?: string }
  | { type: 'tool_end', name: string }
  | { type: 'searching' }
  | { type: 'done' }

export interface RespondInput {
  systemPrompt: string
  // NOTE (Phase 0): history is still the OpenAI message-param shape. Phase 1
  // introduces a neutral CoreMessage type when GeminiProvider needs it.
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  model: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  imageParts?: OpenAI.Chat.Completions.ChatCompletionContentPartImage[]
  extraText?: string
  toolRegistry?: ToolRegistry
  channelId?: string
  userId?: string
  onEvent?: (event: LifecycleEvent) => void
}

export interface RespondResult extends ParsedResponse {
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cachedInputTokens: number
    reasoningTokens: number
  } | null
  finishReason: string | null
  durationMs: number
  modelUsed: string
}

// The contract core depends on. A model backend is anything that can stream a
// reply (respond) and produce embeddings (embed). Tool-schema formatting stays
// internal to each provider's respond(); capabilities let core branch on
// provider-specific features (voice, native web search) without importing SDKs.
export interface Provider {
  readonly id: string
  readonly defaultModel: string
  readonly capabilities: {
    voice: boolean
    managedCache: boolean
    nativeWebSearch: boolean
  }
  respond(input: RespondInput): Promise<RespondResult>
  embed(text: string): Promise<number[]>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx tests/core/provider.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/core/provider.ts tests/core/provider.test.ts
git commit -m "feat(core): add Provider interface + re-home shared response types"
```

---

### Task 2: Make `OpenAIClient` implement `Provider`

**Files:**
- Modify: `src/openai.ts` (remove the four moved type decls at lines 4-60; import them; add `implements Provider` + `id`, `capabilities`, `embed`)
- Modify: `src/memory.ts` (export the embed helper if not already, so the provider can wrap it)
- Test: `tests/core/provider.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/core/provider.test.ts`:

```ts
import { OpenAIProvider } from '../../src/openai.ts'

test('OpenAIProvider conforms to Provider with correct capabilities', () => {
  const p: Provider = new OpenAIProvider('sk-test', 'gpt-5.6')
  assert.equal(p.id, 'openai')
  assert.equal(p.defaultModel, 'gpt-5.6')
  assert.equal(p.capabilities.voice, false)
  assert.equal(p.capabilities.managedCache, false)
  assert.equal(p.capabilities.nativeWebSearch, false)
  assert.equal(typeof p.respond, 'function')
  assert.equal(typeof p.embed, 'function')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --import tsx tests/core/provider.test.ts`
Expected: FAIL — `OpenAIProvider` is not exported / `id` undefined.

- [ ] **Step 3: Edit `src/openai.ts`**

1. Delete the type declarations now living in `core/provider.ts` (`ParsedResponse`, `LifecycleEvent`, `RespondInput`, `RespondResult` — `openai.ts:4-60`) and import them instead:

```ts
import type { Provider, RespondInput, RespondResult, LifecycleEvent, ParsedResponse } from './core/provider.ts'
```
(Keep `export type { LifecycleEvent, RespondInput, RespondResult, ParsedResponse }` re-exports if other modules import them from `./openai.ts`, so callers don't break.)

2. Change the class declaration and add the three new members:

```ts
export class OpenAIClient implements Provider {
  private client: OpenAI
  public readonly defaultModel: string
  public readonly id = 'openai' as const
  public readonly capabilities = { voice: false, managedCache: false, nativeWebSearch: false } as const

  constructor(apiKey: string, defaultModel: string) {
    this.client = new OpenAI({ apiKey })
    this.defaultModel = defaultModel
  }

  async embed(text: string): Promise<number[]> {
    return embed(this.client, text)   // wraps the existing helper from memory.ts
  }

  // respond(...) unchanged
}

// Provider-named alias — the harness refers to providers by their role, not SDK.
export { OpenAIClient as OpenAIProvider }
```

3. Add the import for the embed helper at the top:

```ts
import { embed } from './memory.ts'
```

Verify `embed` is exported from `src/memory.ts` (signature `embed(client: OpenAI, text: string): Promise<number[]>`). If it is not exported, add `export` to its declaration.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx tests/core/provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `node --test --import tsx $(find tests -name '*.test.ts')`
Expected: all PASS (the prior 153 + the new ones). If any import of types from `./openai.ts` broke, fix by ensuring the re-exports in step 3.1 are present.

- [ ] **Step 6: Commit**

```bash
git add src/openai.ts src/memory.ts tests/core/provider.test.ts
git commit -m "feat(core): OpenAIClient implements Provider (id, capabilities, embed)"
```

---

### Task 3: Add `FakeProvider` for provider-agnostic core tests

**Files:**
- Create: `src/providers/fake-provider.ts`
- Test: `tests/core/provider.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/core/provider.test.ts`:

```ts
import { FakeProvider } from '../../src/providers/fake-provider.ts'

test('FakeProvider returns a scripted reply + deterministic embedding', async () => {
  const p = new FakeProvider({ reply: 'hello' })
  const res = await p.respond({
    systemPrompt: '', history: [], userMessage: 'hi', userName: 'u', model: 'fake'
  })
  assert.equal(res.reply, 'hello')
  assert.equal(res.modelUsed, 'fake')
  const e1 = await p.embed('x')
  const e2 = await p.embed('x')
  assert.deepEqual(e1, e2)               // deterministic
  assert.equal(e1.length, 1536)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --import tsx tests/core/provider.test.ts`
Expected: FAIL — module `fake-provider.ts` not found.

- [ ] **Step 3: Create `src/providers/fake-provider.ts`**

```ts
import type { Provider, RespondInput, RespondResult } from '../core/provider.ts'

// Deterministic in-memory Provider for testing core without a network or SDK.
// `respond` returns a scripted reply; `embed` hashes the input to a fixed-length
// vector so equal inputs give equal embeddings (lets RAG tests assert recall).
export class FakeProvider implements Provider {
  readonly id = 'fake'
  readonly defaultModel = 'fake'
  readonly capabilities = { voice: false, managedCache: false, nativeWebSearch: false }
  constructor(private script: { reply?: string, react?: string | null } = {}) {}

  async respond(input: RespondInput): Promise<RespondResult> {
    return {
      react: this.script.react ?? null,
      reply: this.script.reply ?? '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      finishReason: 'stop',
      durationMs: 0,
      modelUsed: input.model || this.defaultModel
    }
  }

  async embed(text: string): Promise<number[]> {
    const dim = 1536
    const v = new Array(dim).fill(0)
    for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i)
    return v
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx tests/core/provider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/fake-provider.ts tests/core/provider.test.ts
git commit -m "test(core): add FakeProvider for provider-agnostic core tests"
```

---

### Task 4: Repoint `gpt.ts` to the `Provider` interface

**Files:**
- Modify: `src/gpt.ts` (the bot entry — `src/gpt.ts:56` constructs `new OpenAIClient(...)`)

- [ ] **Step 1: Type the provider handle as `Provider`**

In `src/gpt.ts`, add the import and annotate the handle so the entry depends on the interface, not the concrete class:

```ts
import type { Provider } from './core/provider.ts'
import { OpenAIProvider } from './openai.ts'   // was: OpenAIClient
// ...
const provider: Provider = new OpenAIProvider(OPENAI_KEY, DEFAULT_MODEL)
```

Replace later references to the old `openai` handle name with `provider` (the `respond` call site). Leave the separate `openaiRaw` (`new OpenAI(...)`) handle as-is for now — it's passed to `buildDefaultRegistry` and `embed`; Phase 1 removes the raw handle once embed routes through `provider.embed`. (Phase 0 keeps it to avoid touching the registry/ingestion path.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors. Fix any reference that still names the old `OpenAIClient` import or the renamed handle.

- [ ] **Step 3: Run the full suite**

Run: `node --test --import tsx $(find tests -name '*.test.ts')`
Expected: all PASS — behavior is unchanged; this is a type-level repoint.

- [ ] **Step 4: Smoke-check the bot boots**

Run: `node --check` is insufficient for tsx; instead dry-import the entry:
`node --import tsx -e "import('./src/gpt.ts').then(()=>{console.log('import ok'); process.exit(0)}).catch(e=>{console.error(e); process.exit(1)})"`
Expected: prints `import ok` (or fails fast on a real config/env error unrelated to the refactor — if it errors on missing `OPENAI_KEY`/env, that's expected in a bare shell; the import-resolution must not error on the renamed symbols).

- [ ] **Step 5: Commit**

```bash
git add src/gpt.ts
git commit -m "refactor(core): entry depends on Provider interface, not OpenAIClient"
```

---

## Deploy (after all 4 tasks green)

- [ ] Push: `git push origin main`
- [ ] host-a: check state first (`git fetch && git rev-list --left-right --count HEAD...origin/main`), then `git pull --ff-only origin main`, `npm install`, `systemctl --user restart gpt.service`, confirm `is-active`.
- [ ] Verify Gem still replies in its channel (behavior unchanged is the whole point of Phase 0).

## Definition of done

- `Provider` interface exists in `core/`; `OpenAIProvider` implements it; `FakeProvider` exists for tests.
- `gpt.ts` depends on `Provider`, not `OpenAIClient` concretely.
- Full suite green; `tsc --noEmit` clean; Gem runs identically in production.
- No neutral message-type work yet (deferred to Phase 1) — Phase 0 is the seam only.
