// One-off migration: re-embed the passive-memory store from OpenAI
// text-embedding-3-small (1536-dim) to local Ollama bge-m3 (1024-dim).
//
// Why: gpt-bot's chat engine moved to the flat-sub Codex CLI, but the
// per-message embedding path was left on the metered OpenAI API. Repointing it
// at Ollama changes the vector dimension, which is baked into the vss0 virtual
// table — so the existing vectors are incompatible and must be rebuilt.
//
// Safe to re-run: it rebuilds vss_messages from the `messages` table each time.
// The `messages` table (source content) is never touched. Back up memory.db
// first anyway (the caller already did).
//
// Run: node --import tsx/esm scripts/reembed-memory.ts
// Reads GPT_STATE_DIR, OLLAMA_URL, GPT_EMBEDDING_MODEL, GPT_EMBEDDING_DIM from env.

import path from 'path'
import os from 'os'
import { createRequire } from 'module'
import OpenAI from 'openai'
import { embed, EMBEDDING_DIM, EMBEDDING_MODEL } from '../src/memory.ts'

const require = createRequire(import.meta.url)

const stateDir = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
const dbFile = path.join(stateDir, 'memory.db')
const ollamaUrl = process.env.OLLAMA_URL || 'http://100.94.27.37:11434'
const client = new OpenAI({ apiKey: 'ollama', baseURL: ollamaUrl + '/v1' })

// Load the same native modules MemoryStore uses.
const Database = require('better-sqlite3')
const sqliteVss = require('sqlite-vss')

const db = new Database(dbFile)
sqliteVss.load(db)

console.error(`re-embed: db=${dbFile}`)
console.error(`re-embed: model=${EMBEDDING_MODEL} dim=${EMBEDDING_DIM} via ${ollamaUrl}`)

// Rebuild the vss table at the new dimension. DROP is fine — it's derived data.
db.exec('DROP TABLE IF EXISTS vss_messages;')
db.exec(`CREATE VIRTUAL TABLE vss_messages USING vss0( embedding(${EMBEDDING_DIM}) );`)

const rows = db.prepare(
  'SELECT rowid, content FROM messages ORDER BY rowid ASC'
).all() as Array<{ rowid: number; content: string }>

console.error(`re-embed: ${rows.length} messages to process`)

const insertVss = db.prepare('INSERT OR IGNORE INTO vss_messages (rowid, embedding) VALUES (?, ?)')

let ok = 0, skipped = 0, failed = 0
for (let i = 0; i < rows.length; i++) {
  const { rowid, content } = rows[i]
  const emb = await embed(client, content)
  if (!emb) { skipped++; continue }
  if (emb.length !== EMBEDDING_DIM) {
    console.error(`re-embed: dim mismatch rowid=${rowid} got ${emb.length} want ${EMBEDDING_DIM}`)
    failed++
    continue
  }
  insertVss.run(rowid, JSON.stringify(emb))
  ok++
  if ((i + 1) % 250 === 0) console.error(`re-embed: ${i + 1}/${rows.length} (ok=${ok} skip=${skipped} fail=${failed})`)
}

console.error(`re-embed: DONE ok=${ok} skipped=${skipped} failed=${failed}`)
db.close()
