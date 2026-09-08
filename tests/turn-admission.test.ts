import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { TurnAdmissionLedger } from '../src/turn-admission.ts'

const AUGUST_25 = Date.parse('2026-08-25T12:00:00-07:00')
const AUGUST_26 = Date.parse('2026-08-26T12:00:00-07:00')

test('completed or failed turns cannot recycle principal or global daily quota', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gpt-turn-admission-'))
  const file = path.join(dir, 'ledger.json')
  try {
    const ledger = new TurnAdmissionLedger(file, { perPrincipal: 2, global: 3 }, () => AUGUST_25)
    assert.equal(ledger.reserve('alice').allowed, true)
    assert.equal(ledger.reserve('alice').allowed, true)
    assert.deepEqual(ledger.reserve('alice'), { allowed: false, reason: 'principal' })
    assert.equal(ledger.reserve('bob').allowed, true)
    assert.deepEqual(ledger.reserve('bob'), { allowed: false, reason: 'global' })

    const restarted = new TurnAdmissionLedger(file, { perPrincipal: 2, global: 3 }, () => AUGUST_25)
    assert.deepEqual(restarted.reserve('alice'), { allowed: false, reason: 'principal' })
    assert.deepEqual(restarted.reserve('bob'), { allowed: false, reason: 'global' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('daily admission resets only after the Pacific calendar day changes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gpt-turn-admission-day-'))
  const file = path.join(dir, 'ledger.json')
  let now = AUGUST_25
  try {
    const ledger = new TurnAdmissionLedger(file, { perPrincipal: 1, global: 1 }, () => now)
    assert.equal(ledger.reserve('alice').allowed, true)
    assert.equal(ledger.reserve('alice').allowed, false)
    now = AUGUST_26
    assert.equal(ledger.reserve('alice').allowed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an exhausted principal cannot consume another principal contribution', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gpt-turn-admission-principals-'))
  const file = path.join(dir, 'ledger.json')
  try {
    const ledger = new TurnAdmissionLedger(file, { perPrincipal: 1, global: 3 }, () => AUGUST_25)
    assert.equal(ledger.reserve('alice').allowed, true)
    assert.deepEqual(ledger.reserve('alice'), { allowed: false, reason: 'principal' })
    assert.equal(ledger.reserve('bob').allowed, true)
    assert.deepEqual(ledger.reserve('alice'), { allowed: false, reason: 'principal' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
