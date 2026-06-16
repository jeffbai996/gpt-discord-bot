# bot-harness Phase 1b — GeminiProvider (minimal-viable)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Add a `GeminiProvider` that implements the `Provider` interface, so the harness can run as Gemini. **Minimal-viable scope (option ii):** the provider *answers correctly* — streaming respond + function-call tool loop + structured-reply parsing + embed + Gemini tool-schema formatting + google_search grounding flag + basic multimodal. **Explicitly deferred to a 1b-followup:** grounding-source footers, code-execution artifact rendering, and the managed context-cache (cost optimization). gpt-bot (OpenAI) behavior is unchanged.

**Architecture:** Port the *core* of gem-bot's `src/gemini.ts` (~the half that makes Gemini work) into `src/providers/gemini/`, adapting it to the `Provider` contract that Phase 0/1a established. The neutral `CoreMessage[]` (from 1a) maps to Gemini `Content[]`; this phase also closes 1a's deferral by neutralizing `imageParts`.

**Tech Stack:** TS + Node, `tsx`, `node:test`, `@google/genai`. Branch: `feat/phase1b-gemini-provider`. Spec: `docs/design/2026-06-16-agent-harness-design.md`. **Port source:** `~/repos/gem-bot/src/gemini.ts` + `~/repos/gem-bot/src/history.ts` (`formatHistory`) + `~/repos/gem-bot/src/tools/mcp-schema.ts` (`mcpSchemaToGemini`). The executor should read those files — they are the proven implementation being ported, not re-derived.

**Three key adaptations to the Provider contract (READ FIRST):**
1. **Registry is per-call, not constructor.** gem-bot's `GeminiClient` takes the registry at construction (`gemini.ts:627`). The `Provider` contract passes it per-call via `input.toolRegistry`. So `GeminiProvider`'s constructor takes `(apiKey, defaultModel)` (like `OpenAIProvider`), and `respond()` builds tools from `input.toolRegistry` each call.
2. **Return shape.** gem-bot's `respond()` returns `{ parsed, meta }`; the `Provider` contract returns `RespondResult` (= `ParsedResponse` + `usage`/`finishReason`/`durationMs`/`modelUsed`). The port maps gem-bot's `meta` → those `RespondResult` fields.
3. **Lifecycle + structured reply.** Emit the same `LifecycleEvent`s via `input.onEvent`. Gemini + tools can't be held to strict JSON, so port gem-bot's `parseResponse` + `normalizeJsonWhitespace` (`gemini.ts:114,157`) verbatim — they handle the messy extraction into `{react, reply}`.

---

## File Structure
- **Modify** `package.json` — add `"@google/genai": "^1.51.0"` (match gem-bot's pin).
- **Modify** `src/core/provider.ts` — neutralize `imageParts`: add a `CoreImagePart` type (`{ mimeType: string, dataBase64?: string, url?: string }`), change `RespondInput.imageParts` to `CoreImagePart[]`. (Closes the 1a deferral.)
- **Modify** `src/openai.ts` — `OpenAIProvider` maps `CoreImagePart[]` → OpenAI `ChatCompletionContentPartImage[]` internally (behavior-preserving for GPT).
- **Create** `src/providers/gemini/parse.ts` — port `parseResponse`, `normalizeJsonWhitespace`, `extractModelText`, `extractJsonObject`, `normalize` from gem-bot `gemini.ts` (pure functions; port verbatim + their existing unit tests).
- **Create** `src/providers/gemini/format.ts` — `coreMessagesToContents(history: CoreMessage[], selfId): Content[]` (adapt gem-bot `history.ts:formatHistory` to gpt-bot's `CoreMessage` shape `{id,authorId,authorName,content,attachments}` + map `CoreImagePart[]` to Gemini parts) and `registryToGeminiTools(registry)` (port `buildTools` + `mcpSchemaToGemini`).
- **Create** `src/providers/gemini/gemini-provider.ts` — the `GeminiProvider` class implementing `Provider`: constructor `(apiKey, defaultModel)`, `respond()` (streaming + function-call loop, ported from `GeminiClient.runOneTurn`/`respond` core), `embed()` (port the raw-HTTP `embedContent` call), `id='gemini'`, `capabilities={voice:true, managedCache:true, nativeWebSearch:true}`.
- **Create** `tests/providers/gemini/parse.test.ts`, `tests/providers/gemini/format.test.ts`, `tests/providers/gemini/gemini-provider.test.ts`.

> **Exclusions (do NOT port in 1b):** `extractGroundingSources`/`formatGroundingSources`, `extractCodeArtifacts`/`stripDuplicateCodeBlocks`, `GeminiCacheManager` (`cache.ts`). These are the deferred enhancements. The provider should still *function* without them (it just won't render source footers / code-exec blocks / use the cost-cache). Leave a `// TODO(1b-followup): grounding sources / code-exec / managed cache` marker where each would hook in.

---

### Task 1: Add the Gemini dep + neutralize `imageParts`

**Files:** `package.json`, `src/core/provider.ts`, `src/openai.ts`, `tests/core/provider.test.ts`

- [ ] **Step 1: Failing test** — append to `tests/core/provider.test.ts`:
```ts
import type { CoreImagePart } from '../../src/core/provider.ts'
test('RespondInput.imageParts is the neutral CoreImagePart[]', () => {
  const imageParts: CoreImagePart[] = [{ mimeType: 'image/png', dataBase64: 'AAAA' }]
  const input: RespondInput = {
    systemPrompt: '', history: [], userMessage: 'x', userName: 'u', model: 'm', imageParts
  }
  assert.equal(input.imageParts?.[0].mimeType, 'image/png')
})
```
- [ ] **Step 2: Run, verify fail** — `node --test --import tsx tests/core/provider.test.ts` → FAIL (`CoreImagePart` not exported).
- [ ] **Step 3: Implement** — in `src/core/provider.ts`:
```ts
// A provider-neutral inline image. Each provider maps it to its own wire form
// (OpenAI image_url part / Gemini inlineData or fileData part).
export interface CoreImagePart {
  mimeType: string
  dataBase64?: string   // inline base64 (small images)
  url?: string          // remote/file URL (large images / fileData path)
}
```
Change `RespondInput.imageParts` to `CoreImagePart[]`. Remove the `import type OpenAI` from provider.ts if `imageParts` was its last use (check: history is now `CoreMessage[]`, so OpenAI types may no longer be referenced here — if so, delete the import).
- [ ] **Step 4: Map in OpenAIProvider** — in `src/openai.ts` `respond()`, where `imageParts` is spliced into the user message, convert `CoreImagePart[]` → OpenAI parts:
```ts
const oaiImageParts = (input.imageParts ?? []).map(p => ({
  type: 'image_url' as const,
  image_url: { url: p.url ?? `data:${p.mimeType};base64,${p.dataBase64 ?? ''}` }
}))
// use oaiImageParts where input.imageParts was used before
```
Update `src/gpt.ts` / `src/attachments.ts` if they construct `imageParts` in OpenAI shape — have them produce `CoreImagePart[]` instead (grep `imageParts` + `image_url` across src/). Keep GPT behavior identical.
- [ ] **Step 5: Add dep** — `npm install @google/genai@^1.51.0` (adds to package.json + lock).
- [ ] **Step 6: Run full suite + tsc** — all green, 0 errors. (Behavior-preserving for GPT — verify the image path still builds the same OpenAI parts.)
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(core): neutral CoreImagePart + add @google/genai dep"`

---

### Task 2: Port the pure Gemini parsing helpers

**Files:** `src/providers/gemini/parse.ts`, `tests/providers/gemini/parse.test.ts`

- [ ] **Step 1: Port the gem-bot unit tests first.** gem-bot has tests for `parseResponse`/`normalizeJsonWhitespace` — find them (`~/repos/gem-bot/tests/` grep `parseResponse|normalizeJson`) and copy the relevant cases into `tests/providers/gemini/parse.test.ts`, importing from `../../../src/providers/gemini/parse.ts`. These are the behavior contract.
- [ ] **Step 2: Run, verify fail** — module doesn't exist yet → FAIL.
- [ ] **Step 3: Port the functions** — copy `parseResponse`, `normalizeJsonWhitespace`, `extractModelText`, `extractJsonObject`, `normalize` from `~/repos/gem-bot/src/gemini.ts` (lines ~74-265) into `src/providers/gemini/parse.ts` verbatim (they're pure, no SDK dep). Export `parseResponse`, `normalizeJsonWhitespace`, `extractModelText`, and the `ParsedResponse` type — but import `ParsedResponse` from `../../core/provider.ts` instead of re-declaring it (it's the same shape).
- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git add src/providers/gemini/parse.ts tests/providers/gemini/parse.test.ts && git commit -m "feat(gemini): port pure reply-parsing helpers"`

---

### Task 3: Port history + tool formatting (CoreMessage→Content, registry→Gemini tools)

**Files:** `src/providers/gemini/format.ts`, `tests/providers/gemini/format.test.ts`

- [ ] **Step 1: Failing tests** — in `tests/providers/gemini/format.test.ts`:
```ts
import { coreMessagesToContents, registryToGeminiTools } from '../../../src/providers/gemini/format.ts'
import { ToolRegistry } from '../../../src/tools/registry.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('coreMessagesToContents maps CoreMessage to Gemini Content with role + text', () => {
  const out = coreMessagesToContents(
    [{ id: '1', authorId: 'bot1', authorName: 'gem', content: 'hello', attachments: [] }],
    'bot1'  // selfId → this message is the model's own
  )
  assert.equal(out[0].role, 'model')
  assert.ok(out[0].parts.some((p: any) => p.text?.includes('hello')))
})

test('registryToGeminiTools returns a tools array shaped for the SDK', () => {
  const r = new ToolRegistry()
  // register a trivial tool (use the real Tool shape from registry.ts)
  r.register({ name: 't', description: 'd', parameters: { type: 'object', properties: {} }, async execute() { return 'ok' } })
  const tools = registryToGeminiTools(r)
  assert.ok(Array.isArray(tools))
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — port `formatHistory` from `~/repos/gem-bot/src/history.ts:112` into `coreMessagesToContents`, adapting: input is gpt-bot's `CoreMessage` (`{id,authorId,authorName,content,attachments}`), role is `authorId === selfId ? 'model' : 'user'`, prefix non-self author name into text (match gem-bot's behavior), map `CoreImagePart[]` (if threaded through) to Gemini `{inlineData}`/`{fileData}` parts. Port `buildTools` + `mcpSchemaToGemini` (`~/repos/gem-bot/src/tools/mcp-schema.ts`) into `registryToGeminiTools(registry)` — convert each `Tool`'s JSON-Schema `parameters` to the Gemini function-declaration shape. **Exclude** the codeExecution/googleSearch tool entries for now EXCEPT the googleSearch grounding flag (keep that — it's core/capability, cheap).
- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git add src/providers/gemini/format.ts tests/providers/gemini/format.test.ts && git commit -m "feat(gemini): port history + tool-schema formatting"`

---

### Task 4: `GeminiProvider` — embed + capabilities + the contract skeleton

**Files:** `src/providers/gemini/gemini-provider.ts`, `tests/providers/gemini/gemini-provider.test.ts`

- [ ] **Step 1: Failing test** — conformance + embed (stub the HTTP/SDK):
```ts
import { GeminiProvider } from '../../../src/providers/gemini/gemini-provider.ts'
import type { Provider } from '../../../src/core/provider.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('GeminiProvider conforms to Provider with Gemini capabilities', () => {
  const p: Provider = new GeminiProvider('key', 'gemini-3-flash-preview')
  assert.equal(p.id, 'gemini')
  assert.equal(p.defaultModel, 'gemini-3-flash-preview')
  assert.equal(p.capabilities.voice, true)
  assert.equal(p.capabilities.managedCache, true)
  assert.equal(p.capabilities.nativeWebSearch, true)
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement skeleton + embed** — create `GeminiProvider implements Provider`: constructor `(apiKey, defaultModel)` storing both + a `GoogleGenAI` client; `id='gemini'`; `capabilities` as above; `embed(text)` ported from `gemini.ts:675` (the raw-HTTP `embedContent` call to `gemini-embedding-001`). Leave `respond()` throwing `new Error('not implemented')` for now (Task 5 fills it).
- [ ] **Step 4: Run test** — PASS (conformance + capabilities; embed tested in Task 5 with a stub or skipped as a network call).
- [ ] **Step 5: Commit** — `git add src/providers/gemini/gemini-provider.ts tests/providers/gemini/gemini-provider.test.ts && git commit -m "feat(gemini): GeminiProvider skeleton (id, capabilities, embed)"`

---

### Task 5: `GeminiProvider.respond()` — streaming + function-call loop

**Files:** `src/providers/gemini/gemini-provider.ts`, `tests/providers/gemini/gemini-provider.test.ts`

- [ ] **Step 1: Failing test** — stub the `GoogleGenAI` client's `models.generateContentStream` to yield a scripted stream (a text reply, no tool call), assert `respond()` returns a `RespondResult` with the parsed `reply` and a populated `modelUsed`/`durationMs`. Add a second test where the stubbed stream yields a `functionCall` part → assert the loop dispatches the registry tool (use a `ToolRegistry` with a fake tool that records its call) and feeds the result back for a second turn. Model the stub on the real chunk shape (`candidate.content.parts[]` with `text`/`functionCall`) — see `gemini.ts:832-874`.
- [ ] **Step 2: Run, verify fail** (respond throws 'not implemented').
- [ ] **Step 3: Implement `respond()`** — port the core of `GeminiClient.respond` + `runOneTurn` (`gemini.ts:784-920`), adapting:
  - Inputs from `RespondInput`: build `contents` via `coreMessagesToContents(input.history, input.selfId ?? '')` + the current `userMessage`/`imageParts`/`extraText`; system prompt via `formatSystemPrompt`; tools via `registryToGeminiTools(input.toolRegistry)` (per-call registry); model `input.model || this.defaultModel`.
  - Stream via `this.client.models.generateContentStream(...)`; emit `LifecycleEvent`s (`first_token`, `partial`, `tool_start`/`tool_end`, `done`) through `input.onEvent`.
  - **Function-call loop:** on a `functionCall` part, emit `tool_start`, dispatch `input.toolRegistry.dispatch(name, args, {channelId, userId})`, append the tool result as a function-response part, run another turn — same control flow as gem-bot, capped at gem-bot's max-turns.
  - Parse the final text via `parseResponse` → `{react, reply}`.
  - **Map to `RespondResult`:** `{ react, reply, usage: <map from extractUsage or null>, finishReason, durationMs: Date.now()-start, modelUsed }`.
  - `// TODO(1b-followup): grounding sources, code-exec artifacts, managed cache` at the hook points.
- [ ] **Step 4: Run tests** — PASS (text reply + tool-loop). Then full suite + `tsc --noEmit` → all green, 0 errors.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(gemini): GeminiProvider.respond — streaming + tool loop"`

---

## Definition of done
- `GeminiProvider implements Provider`, conforms (id/capabilities), `embed` + `respond` (streaming + tool loop + structured reply) work against stubbed clients.
- `@google/genai` added; `imageParts` neutralized (1a deferral closed); OpenAI path behavior-preserving.
- Full suite green; `tsc --noEmit` clean. (No live Gemini run yet — that's Phase 1c, when the bots/ config layer lets you launch a Gemini bot.)
- Enhancements (grounding footers, code-exec, managed cache) explicitly deferred with TODO markers.

## Notes for the executor
- This is a PORT: read the gem-bot source files named above and adapt them, don't re-derive. Match gem-bot's control flow for the tool loop exactly — it handles real Gemini streaming quirks (the `functionCallPart` capture-at-stream-time, the JSON-whitespace normalization) that are easy to get subtly wrong.
- Do NOT wire GeminiProvider into `gpt.ts` — gpt-bot stays OpenAI. GeminiProvider gets exercised by tests now and by a real bot in Phase 1c (config layer). This keeps Phase 1b non-disruptive to the live GPT bot.
- After merge, there's nothing to deploy/restart for the live bots (GeminiProvider isn't wired into either yet) — it's library code + tests. Verify with the green suite only.
