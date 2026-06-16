# bot-harness Phase 1a — Neutral Message Types

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Make `RespondInput.history` provider-neutral so a non-OpenAI provider can consume it. Today it's `OpenAI.Chat.Completions.ChatCompletionMessageParam[]` (already OpenAI-formatted by the caller). Retype it to a neutral `CoreMessage[]` and move the OpenAI formatting *inside* `OpenAIProvider`. **Zero behavior change** for GPT.

**Architecture:** The neutral source already exists — `fetchHistory()` returns `HistoryMessage[]` (role/author/content/attachments, provider-neutral). Promote that to the core message type (`CoreMessage`), change `RespondInput.history` to it, and have `OpenAIProvider.respond()` call the existing `formatHistoryForOpenAI` internally instead of the caller pre-formatting. This is the abstraction Phase 0 deferred; Phase 1b (GeminiProvider) maps the same `CoreMessage[]` to Gemini `Content[]`.

**Tech Stack:** TS + Node, `tsx`, `node:test`. Branch: `feat/phase1a-neutral-messages`. Spec: `docs/design/2026-06-16-agent-harness-design.md`.

**Out of scope (deferred to 1b):** `imageParts` stays OpenAI-typed for now — Gemini multimodal forces its neutralization in 1b, same deferral pattern Phase 0 used for history.

---

## File Structure

- **Modify** `src/history.ts` — export the existing `HistoryMessage` interface (it's the neutral shape); no behavior change.
- **Modify** `src/core/provider.ts` — add `export type CoreMessage = HistoryMessage` (import from history.ts); change `RespondInput.history` from `ChatCompletionMessageParam[]` to `CoreMessage[]`. Drop the now-unused `OpenAI` history import if nothing else needs it (keep it for `imageParts`).
- **Modify** `src/openai.ts` — `OpenAIProvider.respond()` calls `formatHistoryForOpenAI(input.history, …)` internally to get the OpenAI message array, instead of receiving it pre-formatted. `formatHistoryForOpenAI` needs `selfId`; thread it via `RespondInput` (add `selfId?: string`) or via the provider constructor — see Task 2.
- **Modify** `src/gpt.ts` — pass the raw `HistoryMessage[]` from `fetchHistory` straight into `respond({ history })`; delete the `formatHistoryForOpenAI(...)` pre-call at the call site.
- **Modify** `tests/core/provider.test.ts` — update the FakeProvider/contract test if it constructs a `RespondInput` with a history value (use a `CoreMessage[]`).

---

### Task 1: Promote `HistoryMessage` to `CoreMessage` + retype `RespondInput.history`

**Files:**
- Modify: `src/history.ts` (ensure `HistoryMessage` is exported — it already is per `history.ts:11`)
- Modify: `src/core/provider.ts`
- Test: `tests/core/provider.test.ts`

- [ ] **Step 1: Failing test** — append to `tests/core/provider.test.ts`:

```ts
import type { CoreMessage, RespondInput } from '../../src/core/provider.ts'

test('RespondInput.history accepts neutral CoreMessage[], not OpenAI params', () => {
  // HistoryMessage shape (src/history.ts): { id, authorId, authorName, content, attachments }.
  // There is NO `role` field — the provider derives role from authorId === selfId.
  const history: CoreMessage[] = [
    { id: '1', authorId: 'u1', authorName: 'alice', content: 'hi', attachments: [] }
  ]
  const input: RespondInput = {
    systemPrompt: '', history, userMessage: 'yo', userName: 'alice', model: 'm'
  }
  assert.equal(input.history[0].content, 'hi')
})
```

- [ ] **Step 2: Run, verify fail** — `node --test --import tsx tests/core/provider.test.ts` → FAIL (`CoreMessage` not exported / history type mismatch).

- [ ] **Step 3: Implement** in `src/core/provider.ts`:

```ts
import type { HistoryMessage } from '../history.ts'
// The neutral, provider-agnostic message shape. It is exactly what fetchHistory
// produces; each provider maps CoreMessage[] to its own wire format inside
// respond(). (Phase 1a — replaces the OpenAI-typed history.)
export type CoreMessage = HistoryMessage
```
Change `RespondInput.history` to:
```ts
  history: CoreMessage[]
```
Keep the `import type OpenAI from 'openai'` only if `imageParts` still references it (it does — leave it).

- [ ] **Step 4: Run, verify pass** — `node --test --import tsx tests/core/provider.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add src/core/provider.ts tests/core/provider.test.ts && git commit -m "feat(core): neutral CoreMessage type for RespondInput.history"`

---

### Task 2: `OpenAIProvider.respond()` formats history internally

**Files:**
- Modify: `src/openai.ts`
- Modify: `src/core/provider.ts` (add `selfId?: string` to `RespondInput` so the provider can format)

- [ ] **Step 1: Note `formatHistoryForOpenAI`'s signature** in `src/history.ts`: `async formatHistoryForOpenAI(messages: HistoryMessage[], selfId: string, budget?, countTokens?)` → `Promise<ChatCompletionMessageParam[]>`. It's **async** (must be `await`ed) and needs `selfId` to tag the bot's own messages (`authorId === selfId` → `assistant`).

- [ ] **Step 2: Add `selfId` to RespondInput** in `src/core/provider.ts`:

```ts
  // The bot's own Discord user id — lets the provider tag its own past
  // messages as assistant/model when formatting history.
  selfId?: string
```

- [ ] **Step 3: In `src/openai.ts`**, at the top of `respond()`, format the neutral history to OpenAI's shape internally. Find where `history` is currently consumed (it's spread/used when building the `messages` array) and replace the direct use of `input.history` with a formatted local:

```ts
import { formatHistoryForOpenAI } from './history.ts'
// inside respond(), before building the messages array (it's async — await it):
const oaiHistory = await formatHistoryForOpenAI(input.history, input.selfId ?? '')
// …then use `oaiHistory` everywhere the code previously used `input.history`/`history`.
```
Do not change any other logic. The output messages array must be byte-identical to before for the same inputs.

- [ ] **Step 4: Run the full suite** — `node --test --import tsx $(find tests -name '*.test.ts')` → all PASS. `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit** — `git add src/openai.ts src/core/provider.ts && git commit -m "refactor(openai): format history inside the provider, not the caller"`

---

### Task 3: `gpt.ts` passes neutral history

**Files:**
- Modify: `src/gpt.ts` (the call site that does `formatHistoryForOpenAI(raw, selfId)` then passes it — around `gpt.ts:206`)

- [ ] **Step 1: Find the call site.** In `gpt.ts`, history is currently formatted then passed to `respond`. Change it to pass the raw neutral history + `selfId`:

```ts
// BEFORE (illustrative):
//   const history = await formatHistoryForOpenAI(raw, selfId)
//   ... provider.respond({ ..., history })
// AFTER:
const history = raw                       // raw HistoryMessage[] from fetchHistory
... provider.respond({ ..., history, selfId })
```
Remove the now-unused `formatHistoryForOpenAI` import from `gpt.ts` if nothing else there uses it. (`grep -n formatHistoryForOpenAI src/gpt.ts`.)

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → 0 errors. Fix any type mismatch on the `raw` variable (it should already be `HistoryMessage[]` from `fetchHistory`).

- [ ] **Step 3: Full suite** — `node --test --import tsx $(find tests -name '*.test.ts')` → all PASS.

- [ ] **Step 4: Boot smoke-check** —
`node --import tsx -e "import('./src/gpt.ts').then(()=>{console.log('import ok');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `import ok` (or a benign missing-env error unrelated to the refactor; symbol resolution must not fail).

- [ ] **Step 5: Commit** — `git add src/gpt.ts && git commit -m "refactor(gpt): pass neutral CoreMessage history to the provider"`

---

## Definition of done
- `RespondInput.history` is `CoreMessage[]` (neutral); OpenAIProvider formats it internally; gpt.ts passes raw history + selfId.
- Full suite green; tsc clean; Gem boots + runs identically.
- `imageParts` still OpenAI-typed (deferred to 1b).

## Deploy
Push branch → merge main (after review) → host-a `git pull --ff-only` (discard any `package-lock.json` churn first: `git checkout -- package-lock.json`) → `npm install` → `systemctl --user restart gpt.service` → confirm `gpt online` in the log.
