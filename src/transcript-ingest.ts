import type { MessageRow } from './memory.ts'
import { stripBotMetadata } from './history.ts'

export interface TranscriptStore {
  insertMessageText(row: MessageRow): void
  insertMessageEmbedding(messageId: string, embedding: number[]): void
}

interface PersistTranscriptDeps {
  store: TranscriptStore
  row: MessageRow
  shouldEmbed: boolean
  embed: (text: string) => Promise<number[] | null>
}

export interface TranscriptPersistResult {
  stored: boolean
  embedded: boolean
}

/** Persist the readable conversation first; semantic indexing is best-effort. */
export async function persistTranscriptMessage(
  deps: PersistTranscriptDeps,
): Promise<TranscriptPersistResult> {
  deps.store.insertMessageText(deps.row)
  if (!deps.shouldEmbed) return { stored: true, embedded: false }
  const vector = await deps.embed(deps.row.content)
  if (!vector) return { stored: true, embedded: false }
  deps.store.insertMessageEmbedding(deps.row.id, vector)
  return { stored: true, embedded: true }
}

/** Final replies only: discard transient thought/trace/counter UI. */
export function cleanBotTranscriptContent(content: string): string {
  return stripBotMetadata(content).trim()
}
