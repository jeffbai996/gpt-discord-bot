import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  RestartCoordinator,
  ShutdownGate,
  rewriteEnvVar,
  waitForIdleOrDeadline,
  GRACEFUL_SHUTDOWN_DEADLINE_MS,
  RESTART_DRAIN_DEADLINE_MS,
} from '../src/restart.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const tmp = path.join(os.tmpdir(), `gpt-restart-test-${process.pid}`)
const envPath = path.join(tmp, '.env')

async function setup(initial: string) {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  await fs.writeFile(envPath, initial)
}

describe('rewriteEnvVar', () => {
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('replaces an existing key in place', async () => {
    await setup('OPENAI_MODEL=gpt-5.6-luna\nDISCORD_BOT_TOKEN=abc\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'gpt-5.6-sol')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^OPENAI_MODEL=gpt-5\.6-sol$/m)
    // Other keys preserved.
    assert.match(body, /^DISCORD_BOT_TOKEN=abc$/m)
    // Only one model line — no duplicates.
    assert.equal(body.match(/^OPENAI_MODEL=/gm)!.length, 1)
  })

  test('preserves comments and ordering', async () => {
    const initial = '# secrets\nDISCORD_BOT_TOKEN=tok\n\n# admin\nGPT_ADMIN_ID=42\nOPENAI_MODEL=old\n'
    await setup(initial)
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'new')
    const body = await fs.readFile(envPath, 'utf8')
    const lines = body.split('\n')
    assert.equal(lines[0], '# secrets')
    assert.equal(lines[3], '# admin')
    assert.equal(lines[4], 'GPT_ADMIN_ID=42')
    assert.equal(lines[5], 'OPENAI_MODEL=new')
  })

  test('appends a missing key with trailing newline', async () => {
    await setup('DISCORD_BOT_TOKEN=tok\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'gpt-5.6-sol')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^DISCORD_BOT_TOKEN=tok$/m)
    assert.match(body, /^OPENAI_MODEL=gpt-5\.6-sol$/m)
    assert.ok(body.endsWith('\n'), 'file should end with a newline')
  })

  test('creates the file if it does not exist', async () => {
    await fs.rm(tmp, { recursive: true, force: true })
    await fs.mkdir(tmp, { recursive: true })
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'gpt-5.6-sol')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^OPENAI_MODEL=gpt-5\.6-sol$/m)
  })

  test('write is atomic (no .tmp left behind)', async () => {
    await setup('OPENAI_MODEL=old\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'new')
    const entries = await fs.readdir(tmp)
    assert.deepEqual(entries.sort(), ['.env'])
  })

  test('does not match keys that share a prefix', async () => {
    await setup('OPENAI_MODEL_NICKNAME=robot\nOPENAI_MODEL=old\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'new')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^OPENAI_MODEL_NICKNAME=robot$/m)
    assert.match(body, /^OPENAI_MODEL=new$/m)
  })
})

describe('RestartCoordinator', () => {
  test('waits for active work to become idle before launching', async () => {
    let resolveIdle!: () => void
    const idle = new Promise<void>(resolve => { resolveIdle = resolve })
    let launches = 0
    const coordinator = new RestartCoordinator(() => idle, () => { launches++ })

    assert.equal(coordinator.request(), true)
    await Promise.resolve()
    assert.equal(launches, 0)

    resolveIdle()
    await idle
    await Promise.resolve()
    assert.equal(launches, 1)
  })

  test('coalesces duplicate restart requests', async () => {
    let resolveIdle!: () => void
    const idle = new Promise<void>(resolve => { resolveIdle = resolve })
    let launches = 0
    const coordinator = new RestartCoordinator(() => idle, () => { launches++ })

    assert.equal(coordinator.request(), true)
    assert.equal(coordinator.request(), false)
    resolveIdle()
    await idle
    await Promise.resolve()
    assert.equal(launches, 1)
  })

  test('closes intake immediately while active work drains', async () => {
    let resolveIdle!: () => void
    const idle = new Promise<void>(resolve => { resolveIdle = resolve })
    const gate = new ShutdownGate()
    const coordinator = new RestartCoordinator(
      () => idle,
      () => {},
      () => gate.beginDrain(),
    )

    coordinator.request()
    assert.equal(gate.isDraining(), true, 'restart pending must defer new turns')
    resolveIdle()
    await idle
    await Promise.resolve()
    assert.equal(gate.isDraining(), true)
  })

  test('a cross-channel arrival while restart is pending is deferred', async () => {
    const gate = new ShutdownGate()
    const firstDone = gate.enter()
    assert.ok(firstDone)
    let launches = 0
    const coordinator = new RestartCoordinator(
      () => gate.waitForIdle(),
      () => { launches++ },
      () => gate.beginDrain(),
    )

    coordinator.request()
    const secondDone = gate.enter()
    assert.equal(secondDone, null, 'pending restart must not extend its own drain')
    firstDone()
    await Promise.resolve()
    assert.equal(launches, 1)
    assert.equal(gate.enter(), null)
  })
})

describe('RestartCoordinator drain deadline', () => {
  test('has a bounded default so one long turn cannot hold the bot offline forever', () => {
    assert.ok(RESTART_DRAIN_DEADLINE_MS > 0)
    assert.ok(RESTART_DRAIN_DEADLINE_MS <= 30 * 60_000,
      'must stay inside the unit TimeoutStopSec=30min budget')
  })

  test('reports the deadline without killing active work', async () => {
    let launches = 0
    let expired = 0
    const coordinator = new RestartCoordinator(
      () => new Promise<void>(() => {}), // never idle — the stuck-turn case
      () => { launches++ },
      () => {},
      { deadlineMs: 5, onDeadline: () => { expired++ } },
    )

    coordinator.request()
    assert.equal(launches, 0)
    await tick(30)
    assert.equal(expired, 1, 'the overrun should be reported, not silent')
    assert.equal(launches, 0, 'healthy long work must not be killed by the coordinator')
  })

  test('keeps intake closed after a deadline warning', async () => {
    const gate = new ShutdownGate()
    const coordinator = new RestartCoordinator(
      () => new Promise<void>(() => {}),
      () => {},
      () => gate.beginDrain(),
      { deadlineMs: 5 },
    )

    coordinator.request()
    assert.equal(gate.isDraining(), true)
    await tick(30)
    assert.equal(gate.isDraining(), true)
  })

  test('launches once work becomes idle after a deadline warning', async () => {
    let resolveIdle!: () => void
    const idle = new Promise<void>(resolve => { resolveIdle = resolve })
    let launches = 0
    const coordinator = new RestartCoordinator(
      () => idle,
      () => { launches++ },
      () => {},
      { deadlineMs: 5 },
    )

    coordinator.request()
    await tick(30)
    assert.equal(launches, 0)

    resolveIdle()
    await tick(10)
    assert.equal(launches, 1)
  })

  test('a normal idle launch does not later fire the deadline', async () => {
    let launches = 0
    const coordinator = new RestartCoordinator(
      () => Promise.resolve(),
      () => { launches++ },
      () => {},
      { deadlineMs: 5 },
    )

    coordinator.request()
    await tick(30)
    assert.equal(launches, 1)
  })
})

describe('graceful shutdown deadline', () => {
  test('is short enough that a wedged child cannot leave Discord offline', () => {
    assert.ok(GRACEFUL_SHUTDOWN_DEADLINE_MS > 0)
    assert.ok(GRACEFUL_SHUTDOWN_DEADLINE_MS <= 30_000)
  })

  test('reports idle when active work settles before the deadline', async () => {
    assert.equal(await waitForIdleOrDeadline(Promise.resolve(), 30), 'idle')
  })

  test('reports timeout when active work never settles', async () => {
    const result = await waitForIdleOrDeadline(new Promise<void>(() => {}), 5)
    assert.equal(result, 'timeout')
  })
})

describe('ShutdownGate', () => {
  test('SIGTERM can begin exit after a restart already entered drain mode', () => {
    const gate = new ShutdownGate()

    assert.equal(gate.beginDrain(), true)
    assert.equal(gate.isDraining(), true)
    assert.equal(gate.beginExit(), true)
  })

  test('coalesces duplicate exit signals', () => {
    const gate = new ShutdownGate()

    assert.equal(gate.beginExit(), true)
    assert.equal(gate.beginExit(), false)
  })

  test('direct exit also stops new work from being accepted', () => {
    const gate = new ShutdownGate()

    assert.equal(gate.isDraining(), false)
    assert.equal(gate.beginExit(), true)
    assert.equal(gate.isDraining(), true)
  })
})
