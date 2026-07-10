import { spawn, type ChildProcessByStdio, type SpawnOptionsWithoutStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

type SupervisedChild = ChildProcessByStdio<null, Readable, Readable>

export type ProcessStopReason = 'idle' | 'hard' | 'user'

export interface ProcessSupervisorPolicy {
  idleTimeoutMs: number
  hardTimeoutMs: number
  heartbeatMs: number
  killGraceMs: number
}

export interface ProcessHeartbeat {
  elapsedMs: number
  idleMs: number
}

export interface ProcessSupervisorResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
  stopReason: ProcessStopReason | null
  forced: boolean
}

export interface ProcessSupervisorHooks {
  kill?: (child: SupervisedChild) => void
  onHeartbeat?: (heartbeat: ProcessHeartbeat) => void
}

export interface SupervisedProcess {
  child: SupervisedChild
  markActivity: () => void
  stop: (reason?: ProcessStopReason) => void
  wait: () => Promise<ProcessSupervisorResult>
}

/**
 * Spawn and supervise one long-running child without allowing any exit, kill,
 * or pipe race to hold the caller forever. The hard deadline is absolute; the
 * idle deadline advances only when the caller marks a meaningful protocol event.
 */
export function spawnSupervisedProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  policy: ProcessSupervisorPolicy,
  hooks: ProcessSupervisorHooks = {},
): SupervisedProcess {
  const startedAt = Date.now()
  let lastActivityAt = startedAt
  let stopReason: ProcessStopReason | null = null
  let settled = false
  let forceTimer: ReturnType<typeof setTimeout> | null = null

  // stdin is deliberately closed. A CLI waiting for accidental inherited input
  // is indistinguishable from a hung model in a headless Discord service.
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let finish!: (result: ProcessSupervisorResult) => void
  const resultPromise = new Promise<ProcessSupervisorResult>(resolve => { finish = resolve })

  const clearTimers = () => {
    clearTimeout(hardTimer)
    clearInterval(idleTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (forceTimer) clearTimeout(forceTimer)
  }

  const settle = (result: Omit<ProcessSupervisorResult, 'stopReason'>) => {
    if (settled) return
    settled = true
    clearTimers()
    finish({ ...result, stopReason })
  }

  const kill = () => {
    try {
      if (hooks.kill) hooks.kill(child)
      else child.kill('SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch { /* force-settle timer is the final backstop */ }
    }
  }

  const stop = (reason: ProcessStopReason = 'user') => {
    if (settled || stopReason) return
    stopReason = reason
    kill()
    // A failed process-tree walk or a broken native child must not wedge the bot's
    // promise forever. Kill twice, then release the channel even if Node never
    // receives `close`; systemd remains the outer containment boundary.
    forceTimer = setTimeout(() => {
      kill()
      settle({ code: null, signal: null, forced: true })
    }, Math.max(1, policy.killGraceMs))
  }

  // Attach terminal listeners in the same synchronous turn as spawn. Node cannot
  // deliver a fast child's events until this call stack yields, closing the old
  // "child exited before wait() registered close" hole.
  child.once('error', error => settle({ code: null, signal: null, error, forced: false }))
  child.once('close', (code, signal) => settle({ code, signal, forced: false }))

  const hardTimer = setTimeout(() => stop('hard'), Math.max(1, policy.hardTimeoutMs))
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivityAt >= policy.idleTimeoutMs) stop('idle')
  }, Math.min(1_000, Math.max(5, Math.floor(policy.idleTimeoutMs / 4))))
  const heartbeatTimer = policy.heartbeatMs > 0
    ? setInterval(() => {
        if (settled) return
        const now = Date.now()
        try { hooks.onHeartbeat?.({ elapsedMs: now - startedAt, idleMs: now - lastActivityAt }) } catch { /* UI hooks cannot kill supervision */ }
      }, policy.heartbeatMs)
    : null

  return {
    child,
    markActivity: () => { if (!settled && !stopReason) lastActivityAt = Date.now() },
    stop,
    wait: () => resultPromise,
  }
}
