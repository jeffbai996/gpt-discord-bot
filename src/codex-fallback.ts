import { CodexInterruptedError, CodexProcessDiedError } from './codex-chat.ts'

export function codexFallbackWaitMs(error: unknown, minimumElapsedMs: number): number | null {
  if (!(error instanceof CodexInterruptedError) && !(error instanceof CodexProcessDiedError)) return null
  return Math.max(0, minimumElapsedMs - error.afterMs)
}
