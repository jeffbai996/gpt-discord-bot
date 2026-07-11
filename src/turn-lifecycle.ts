/** Structured, content-free turn telemetry for queue/restart investigations. */
export interface TurnLifecycleEvent {
  event: string
  channelId?: string
  generation?: number
  queueDepth?: number
  stopReason?: string
  signal?: string
  engine?: 'codex' | 'api'
  fallbackReason?: string
  restartPhase?: string
}

export function logTurnLifecycle(event: TurnLifecycleEvent): void {
  const record = {
    ts: new Date().toISOString(),
    event: event.event,
    channelId: event.channelId,
    generation: event.generation,
    queueDepth: event.queueDepth,
    stopReason: event.stopReason,
    signal: event.signal,
    engine: event.engine,
    fallbackReason: event.fallbackReason,
    restartPhase: event.restartPhase,
  }
  console.error(JSON.stringify(record))
}
