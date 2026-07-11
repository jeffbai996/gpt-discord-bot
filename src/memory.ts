import path from 'path'
import os from 'os'
import OpenAI from 'openai'

// Embedding backend. We embed every passive message, so this runs constantly —
// it's pointed at the local Ollama `bge-m3` embedder (1024-dim) rather than the
// metered OpenAI `text-embedding-3-small` (1536-dim) it used through v0.9. The
// chat engine moved to the flat-sub Codex CLI; this closes the last metered
// per-message API call. Override both together — model and dim MUST agree, and
// changing them requires re-embedding the store (dimension is baked into the
// vss table). Mirrors llm-bot's memory backend.
export const EMBEDDING_DIM = Number(process.env.GPT_EMBEDDING_DIM) || 1024
export const EMBEDDING_MODEL = process.env.GPT_EMBEDDING_MODEL || 'bge-m3:latest'

// better-sqlite3 + sqlite-vss are native modules. They fail to load on Node
// versions without the right ABI. We lazy-load both so the rest of the bot
// (discord layer, openai client, fetch_url tool) runs even when memory is
// unavailable. The MemoryStore.open() factory returns null when the native
// modules can't load; callers fall back to a no-op path.
type DatabaseCtor = new (path: string) => any
type SqliteVssMod = { load(db: any): void }

let _Database: DatabaseCtor | null = null
let _vss: SqliteVssMod | null = null
// A load failure used to latch permanently (_loadFailed = true), so one
// transient hiccup disabled the memory store until process restart. Instead we
// record WHEN the last failure happened and refuse retries only during a short
// cooldown — after that the next call tries again. A genuinely broken ABI just
// keeps failing every LOAD_RETRY_COOLDOWN_MS, which is cheap and self-healing.
const LOAD_RETRY_COOLDOWN_MS = 60_000
let _lastLoadFailureAt = 0
async function loadNative(): Promise<{ Database: DatabaseCtor; vss: SqliteVssMod } | null> {
  if (_Database && _vss) return { Database: _Database, vss: _vss }
  if (_lastLoadFailureAt && Date.now() - _lastLoadFailureAt < LOAD_RETRY_COOLDOWN_MS) return null
  try {
    const [dbMod, vssMod] = await Promise.all([
      import('better-sqlite3'),
      import('sqlite-vss')
    ])
    _Database = (dbMod.default ?? (dbMod as any)) as DatabaseCtor
    _vss = vssMod as SqliteVssMod
    _lastLoadFailureAt = 0
    return { Database: _Database, vss: _vss }
  } catch (e) {
    console.error('memory: native modules unavailable, RAG disabled (will retry):', e instanceof Error ? e.message : e)
    _lastLoadFailureAt = Date.now()
    return null
  }
}

export interface MessageRow {
  id: string
  channel_id: string
  author_id: string
  author_name: string
  content: string
  timestamp: string
}

export interface SearchResult extends MessageRow {
  distance: number
}

export class MemoryStore {
  private constructor(
    private db: any,
    private statements: {
      insertMsg: any
      insertVss: any
      search: any
      fetchSince: any
      upsertSummary: any
      getSummary: any
    }
  ) {}

  static async open(dbPath?: string): Promise<MemoryStore | null> {
    const native = await loadNative()
    if (!native) return null

    const stateDir = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
    const file = dbPath ?? path.join(stateDir, 'memory.db')

    const db = new native.Database(file)
    native.vss.load(db)

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS vss_messages USING vss0(
        embedding(${EMBEDDING_DIM})
      );

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        channel_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        last_summarized_message_id TEXT NOT NULL,
        updated_at DATETIME NOT NULL
      );
    `)

    return new MemoryStore(db, {
      insertMsg: db.prepare(`
        INSERT OR IGNORE INTO messages (id, channel_id, author_id, author_name, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      insertVss: db.prepare(`
        INSERT OR IGNORE INTO vss_messages (rowid, embedding) VALUES (?, ?)
      `),
      search: db.prepare(`
        SELECT m.id, m.channel_id, m.author_id, m.author_name, m.content, m.timestamp, v.distance
        FROM vss_messages v
        JOIN messages m ON v.rowid = m.rowid
        WHERE vss_search(v.embedding, vss_search_params(?, ?))
          AND m.channel_id = ?
      `),
      fetchSince: db.prepare(`
        SELECT id, channel_id, author_id, author_name, content, timestamp
        FROM messages
        WHERE channel_id = ?
          AND (? IS NULL OR CAST(id AS INTEGER) > CAST(? AS INTEGER))
        ORDER BY CAST(id AS INTEGER) ASC
        LIMIT ?
      `),
      upsertSummary: db.prepare(`
        INSERT INTO conversation_summaries (channel_id, summary, last_summarized_message_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          summary = excluded.summary,
          last_summarized_message_id = excluded.last_summarized_message_id,
          updated_at = excluded.updated_at
      `),
      getSummary: db.prepare(`
        SELECT channel_id, summary, last_summarized_message_id, updated_at
        FROM conversation_summaries WHERE channel_id = ?
      `)
    })
  }

  insertMessage(row: MessageRow, embedding: number[]): void {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(`embedding dim ${embedding.length} ≠ expected ${EMBEDDING_DIM}`)
    }
    const embJson = JSON.stringify(embedding)
    const tx = this.db.transaction(() => {
      const info = this.statements.insertMsg.run(
        row.id, row.channel_id, row.author_id, row.author_name, row.content, row.timestamp
      )
      if (info.changes > 0) {
        this.statements.insertVss.run(info.lastInsertRowid, embJson)
      }
    })
    tx()
  }

  searchMessages(channelId: string, queryEmbedding: number[], limit: number = 10): SearchResult[] {
    const queryJson = JSON.stringify(queryEmbedding)
    return this.statements.search.all(queryJson, limit, channelId) as SearchResult[]
  }

  fetchMessagesSince(channelId: string, sinceMessageId: string | null, limit: number): MessageRow[] {
    return this.statements.fetchSince.all(channelId, sinceMessageId, sinceMessageId, limit) as MessageRow[]
  }

  upsertSummary(channelId: string, summary: string, lastMessageId: string): void {
    this.statements.upsertSummary.run(channelId, summary, lastMessageId, new Date().toISOString())
  }

  getSummary(channelId: string): SummaryRow | null {
    return (this.statements.getSummary.get(channelId) as SummaryRow | undefined) ?? null
  }

  close(): void {
    try { this.db.close() } catch { /* idempotent */ }
  }
}

export interface SummaryRow {
  channel_id: string
  summary: string
  last_summarized_message_id: string
  updated_at: string
}

// Embed a string via OpenAI; returns null on failure so the caller can decide
// whether to skip the message or surface the error.
export async function embed(client: OpenAI, text: string): Promise<number[] | null> {
  if (!text.trim()) return null
  try {
    const resp = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text
    })
    return resp.data?.[0]?.embedding ?? null
  } catch (e) {
    console.error('embed failed:', e instanceof Error ? e.message : e)
    return null
  }
}
