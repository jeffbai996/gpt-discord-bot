import { settleWithin } from './promise-deadline.ts'

export interface RolloverSummarizer {
  runForChannel(channelId: string): Promise<{ messageCount: number } | null>
}

export type SessionRolloverResult =
  | { status: 'compacted'; messageCount: number; droppedSession: boolean }
  | { status: 'unavailable' | 'timed_out' | 'no_summary' }
  | { status: 'failed'; error: unknown }

interface SessionRolloverDeps {
  summarizer: RolloverSummarizer | null
  channelId: string
  dropSession: (channelId: string) => boolean
  timeoutMs: number
}

/** A rollover is destructive to provider context, so summary persistence is
 * the commit point. Failure or timeout leaves the existing session untouched. */
export async function preserveAndDropSession(
  deps: SessionRolloverDeps,
): Promise<SessionRolloverResult> {
  if (!deps.summarizer) return { status: 'unavailable' }
  try {
    const result = await settleWithin(
      deps.summarizer.runForChannel(deps.channelId),
      deps.timeoutMs,
    )
    if (result.status === 'timed-out') return { status: 'timed_out' }
    if (!result.value || result.value.messageCount <= 0) return { status: 'no_summary' }
    return {
      status: 'compacted',
      messageCount: result.value.messageCount,
      droppedSession: deps.dropSession(deps.channelId),
    }
  } catch (error) {
    return { status: 'failed', error }
  }
}
