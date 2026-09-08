import fs from 'node:fs'
import path from 'node:path'
import { pacificDay } from './cache-stats.ts'

interface DailyAdmissionState {
  day: string
  global: number
  principals: Record<string, number>
}

export interface TurnAdmissionLimits {
  perPrincipal: number
  global: number
}

export type TurnAdmissionResult =
  | { allowed: true, principalRemaining: number, globalRemaining: number }
  | { allowed: false, reason: 'principal' | 'global' }

/**
 * Persistent admission-time circuit breaker. Reservations are intentionally
 * charged before provider work and survive failures/restarts: a failed request
 * can still consume provider resources and must not recycle quota indefinitely.
 */
export class TurnAdmissionLedger {
  private state: DailyAdmissionState

  constructor(
    private readonly file: string,
    private readonly limits: TurnAdmissionLimits,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(limits.perPrincipal) || limits.perPrincipal <= 0 ||
        !Number.isSafeInteger(limits.global) || limits.global <= 0) {
      throw new Error('turn admission limits must be positive integers')
    }
    this.state = this.load()
  }

  reserve(principalId: string): TurnAdmissionResult {
    if (!principalId) return { allowed: false, reason: 'principal' }
    this.rotateDay()
    const principalTurns = this.state.principals[principalId] ?? 0
    if (principalTurns >= this.limits.perPrincipal) {
      return { allowed: false, reason: 'principal' }
    }
    if (this.state.global >= this.limits.global) {
      return { allowed: false, reason: 'global' }
    }

    this.state.principals[principalId] = principalTurns + 1
    this.state.global += 1
    this.save()
    return {
      allowed: true,
      principalRemaining: this.limits.perPrincipal - principalTurns - 1,
      globalRemaining: this.limits.global - this.state.global,
    }
  }

  private rotateDay(): void {
    const day = pacificDay(this.now())
    if (this.state.day === day) return
    this.state = { day, global: 0, principals: {} }
  }

  private load(): DailyAdmissionState {
    const currentDay = pacificDay(this.now())
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<DailyAdmissionState>
      if (parsed.day !== currentDay) return { day: currentDay, global: 0, principals: {} }
      if (!Number.isSafeInteger(parsed.global) || (parsed.global ?? -1) < 0 ||
          !parsed.principals || typeof parsed.principals !== 'object' || Array.isArray(parsed.principals) ||
          Object.values(parsed.principals).some(
            value => !Number.isSafeInteger(value) || value < 0,
          )) {
        throw new Error('invalid turn admission ledger')
      }
      return {
        day: parsed.day,
        global: parsed.global,
        principals: { ...parsed.principals },
      } as DailyAdmissionState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { day: currentDay, global: 0, principals: {} }
      }
      throw error
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp.${process.pid}`
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }
}
