import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, EMBEDDING_DIM, EMBEDDING_MODEL, embed } from '../src/memory.ts'

// Tests memory.ts through its PUBLIC interface only — memory.ts is NOT modified.
//
// Why no MemoryStore.open(): open() loads native sqlite-vss and builds the vss0
// virtual table. In this environment that native path SIGSEGVs the test
// process, which is exactly why the project (see memory.test.ts) declines to
// unit-test open() and verifies it live instead. We therefore exercise the
// dimension guard WITHOUT a live DB: insertMessage() validates embedding.length
// and throws BEFORE it ever touches this.db, so an instance created via the
// prototype (bypassing the native-dependent constructor) reaches the guard.

test('EMBEDDING_DIM defaults to the bge-m3 (Ollama) dimension', () => {
  // Only assert the default when no override is set, so a custom env var
  // doesn't fail this spuriously.
  if (!process.env.GPT_EMBEDDING_DIM) {
    assert.equal(EMBEDDING_DIM, 1024)
  }
})

test('EMBEDDING_MODEL defaults to local Ollama bge-m3', () => {
  if (!process.env.GPT_EMBEDDING_MODEL) {
    assert.equal(EMBEDDING_MODEL, 'bge-m3:latest')
  }
})

// ─────────────────────────── insertMessage dim guard ───────────────────────────

const sampleRow = {
  id: '1',
  channel_id: 'chan-1',
  author_id: 'author-1',
  author_name: 'tester',
  content: 'hello world',
  timestamp: new Date().toISOString()
}

// A bare instance with no native db. The dim guard runs first, so the db is
// never dereferenced on the rejection paths below.
function bareStore(): MemoryStore {
  return Object.create(MemoryStore.prototype) as MemoryStore
}

test('insertMessage: rejects wrong-dimension embedding', () => {
  const store = bareStore()
  const tooShort = new Array(10).fill(0.1)
  assert.throws(
    () => store.insertMessage(sampleRow, tooShort),
    new RegExp(`embedding dim 10 ≠ expected ${EMBEDDING_DIM}`)
  )
})

test('insertMessage: rejects empty embedding', () => {
  const store = bareStore()
  assert.throws(
    () => store.insertMessage(sampleRow, []),
    new RegExp(`embedding dim 0 ≠ expected ${EMBEDDING_DIM}`)
  )
})

test('insertMessage: rejects oversized embedding', () => {
  const store = bareStore()
  const tooLong = new Array(EMBEDDING_DIM + 1).fill(0.1)
  assert.throws(
    () => store.insertMessage(sampleRow, tooLong),
    new RegExp(`embedding dim ${EMBEDDING_DIM + 1} ≠ expected ${EMBEDDING_DIM}`)
  )
})

// ─────────────────────────── embed() edge cases ───────────────────────────

test('embed: whitespace-only returns null without calling API', async () => {
  let called = false
  const stub = { embeddings: { create: async () => { called = true; return { data: [{ embedding: [1] }] } } } } as any
  assert.equal(await embed(stub, '\n\t  '), null)
  assert.equal(called, false)
})

test('embed: missing embedding field returns null', async () => {
  const stub = { embeddings: { create: async () => ({ data: [{}] }) } } as any
  assert.equal(await embed(stub, 'text'), null)
})
