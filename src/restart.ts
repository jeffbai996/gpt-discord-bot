/**
 * Self-restart helper for slash commands that change startup-time config.
 *
 * Some commands (default-model swap, etc.) can only take effect by restarting
 * the process — env vars are read once at boot. Rather than telling the user
 * "now run `systemctl --user restart gpt`," these commands write the new
 * value, ack the user, then schedule the restart in a detached subprocess
 * after a short delay so Discord receives the interaction response before
 * this process dies.
 *
 * Why detached: a child of the dying parent would die with it. We want the
 * `systemctl restart` to outlive us.
 *
 * Gem parity: ported from gem-bot src/restart.ts (b0193187).
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'

type WaitForIdle = () => Promise<void>
type RestartLauncher = () => void

/**
 * Tracks two distinct shutdown phases:
 * - draining stops new Discord work while an in-band restart waits for turns;
 * - exiting lets the later systemd SIGTERM run cleanup exactly once.
 *
 * A single boolean cannot represent both phases: SIGUSR2 enters drain mode
 * before systemd sends SIGTERM, so treating "already draining" as "already
 * exiting" leaves the service stuck in stop-sigterm.
 */
export class ShutdownGate {
  private draining = false
  private exiting = false

  beginDrain(): boolean {
    if (this.draining) return false
    this.draining = true
    return true
  }

  beginExit(): boolean {
    if (this.exiting) return false
    this.draining = true
    this.exiting = true
    return true
  }

  isDraining(): boolean {
    return this.draining
  }
}

/**
 * Coalesces restart requests and does not ask systemd to stop the service until
 * every active turn has finished. This is deliberately separate from SIGTERM:
 * once systemd starts a stop job, a second restart request can replace that job
 * and SIGKILL the still-running worker even when TimeoutStopSec is generous.
 */
export class RestartCoordinator {
  private pending = false

  constructor(
    private readonly waitForIdle: WaitForIdle,
    private readonly launch: RestartLauncher,
  ) {}

  request(): boolean {
    if (this.pending) return false
    this.pending = true
    void this.waitForIdle()
      .then(() => this.launch())
      .catch(err => {
        this.pending = false
        console.error('[restart] failed while waiting for idle:', err)
      })
    return true
  }
}

/**
 * Atomically rewrite an `.env` file with a new value for `key`.
 * Preserves the rest of the file (comments, other vars, ordering).
 * Appends if `key` is missing.
 */
export async function rewriteEnvVar(envPath: string, key: string, value: string): Promise<void> {
  let body = ''
  try {
    body = await fs.readFile(envPath, 'utf8')
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
  }
  const lines = body.split('\n')
  const re = new RegExp(`^\\s*${key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*=`)
  let replaced = false
  const out = lines.map(line => {
    if (re.test(line)) {
      replaced = true
      return `${key}=${value}`
    }
    return line
  })
  if (!replaced) {
    // Drop a single trailing blank if present, then append + newline
    while (out.length && out[out.length - 1] === '') out.pop()
    out.push(`${key}=${value}`)
    out.push('')
  }
  const tmp = envPath + '.tmp'
  await fs.writeFile(tmp, out.join('\n'), { mode: 0o644 })
  await fs.rename(tmp, envPath)
}

/**
 * Detach + schedule a `systemctl --user restart <unit>`. Returns immediately.
 *
 * The 1.5s delay gives Discord time to receive whatever interaction reply
 * the caller sent. systemd handles re-up; the new process re-reads .env.
 */
export function scheduleSelfRestart(unit: string = 'gpt', delayMs: number = 1500): void {
  // Run the restart from a transient unit, outside the service cgroup. A
  // detached child alone still belongs to gpt.service and can be killed by the
  // stop operation it initiated.
  const transientUnit = `${unit}-restart-${process.pid}-${Date.now()}`
  const proc = spawn(
    'systemd-run',
    [
      '--user',
      `--unit=${transientUnit}`,
      '--collect',
      `--on-active=${Math.max(0.1, delayMs / 1000).toFixed(2)}s`,
      'systemctl', '--user', 'restart', unit,
    ],
    { detached: true, stdio: 'ignore' },
  )
  proc.unref()
}
