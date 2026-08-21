import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Tool } from './registry.ts'
import { SQUAD_STORE_IDENTITY } from '../codex-chat.ts'

const execFileAsync = promisify(execFile)
const CODEX_BIN = process.env.GPT_CODEX_BIN ||
  path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.22.2', 'bin', 'codex')
const REPOS_DIR = process.env.GPT_REPOS_DIR || path.join(os.homedir(), 'repos')
const TIMEOUT_MS = 230_000 // ~4 min — this runs in the bot's own process, so there's
// no short hook ceiling.
const OUT_CAP = 6000
const HELPER_TIMEOUT_MS = Number(process.env.GPT_VOICE_CODEX_TIMEOUT_MS || 1_800_000)
const HELPER_OUT_CAP = 24_000
const HELPER_BIN = process.env.GPT_CODEX_HELPER_BIN ||
  path.resolve(process.cwd(), '..', 'gpt-helper', 'bin', 'gpt-helper.mjs')

export interface CodexRunInput {
  task: string
  repo: string
  writable: boolean
}

interface CodexHelperOptions {
  run?: (input: CodexRunInput) => Promise<string>
  makeJobId?: () => string
}

function cleanRepo(value: unknown, fallback = process.env.GPT_CODEX_DEFAULT_REPO || 'gpt-bot'): string | null {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return raw !== '.' && raw !== '..' && /^[A-Za-z0-9._-]+$/.test(raw) ? raw : null
}

async function runCodexReadOnly(
  input: Pick<CodexRunInput, 'task' | 'repo'>,
  timeoutMs: number,
  outCap: number,
): Promise<string> {
  const repoDir = `${REPOS_DIR}/${input.repo}`
  const nonce = randomBytes(6).toString('hex')
  const outfile = `/tmp/gpt_codex_${nonce}.txt`
  const logfile = `/tmp/gpt_codex_${nonce}.log`
  const script =
    `[ -d "${repoDir}" ] || { echo "no such repo: ${input.repo}"; exit 2; }; ` +
    `timeout -k 5 ${Math.floor(timeoutMs / 1000)} "${CODEX_BIN}" exec --skip-git-repo-check ` +
    `-s read-only -C "${repoDir}" -o "${outfile}" "$CODEX_TASK" </dev/null >"${logfile}" 2>&1; ` +
    `if [ -s "${outfile}" ]; then cat "${outfile}"; else echo "(codex produced no answer)"; tail -8 "${logfile}"; fi`
  try {
    const { stdout } = await execFileAsync('bash', ['-lc', script], {
      timeout: timeoutMs + 10_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEX_TASK: input.task },
    })
    const out = (stdout || '').trim()
    if (!out) return 'codex: empty result'
    return out.length > outCap ? `${out.slice(0, outCap)}\n…(truncated)` : out
  } catch (e: any) {
    return `codex: ${e?.message ?? String(e)}`
  } finally {
    await Promise.all([
      rm(outfile, { force: true }).catch(() => {}),
      rm(logfile, { force: true }).catch(() => {}),
    ])
  }
}

async function runCodexHelper(input: CodexRunInput): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER_BIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // The helper runs its own codex, which can reach the store CLI, so it
      // needs the same identity the chat path carries (see codex-chat.ts).
      env: { ...process.env, SQUAD_STORE_BOT: SQUAD_STORE_IDENTITY },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdout.length < HELPER_OUT_CAP) stdout = `${stdout}${chunk}`.slice(0, HELPER_OUT_CAP)
    })
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-6000) })

    const timer = setTimeout(() => child.kill('SIGTERM'), HELPER_TIMEOUT_MS + 10_000)
    timer.unref()
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      const output = stdout.trim()
      if (code === 0 && output) {
        resolve(output)
        return
      }
      reject(new Error(stderr.trim() || `helper exited ${code ?? 'without a result'}`))
    })
    child.stdin.on('error', () => { /* spawn/early-exit error is reported by the child events */ })
    child.stdin.end(JSON.stringify({ task: input.task, repo: input.repo }))
  })
}

// Codex — OpenAI's agentic CLI (GPT-5.6) — exposed as a function tool. The bot
// runs on the same host as the repos and the codex binary, so we exec it locally
// and async. Read-only: it inspects code, never modifies it. The MODEL decides
// when to reach for it (repo-aware questions), so the user never types a prefix.
export function makeCodexTool(): Tool {
  return {
    name: 'codex',
    description:
      'Run Codex — an agentic CLI (OpenAI GPT-5.6) that READS a repository on this host and answers deeply about its code: explain a flow, find where something is implemented, audit for bugs, or reason across multiple files. Use this whenever a question is about THIS host\'s codebases instead of guessing. Read-only — never modifies files. Slower than answering directly (~15-60s), so reserve it for questions that genuinely need to inspect the code.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The question or task for Codex about the repo.' },
        repo: { type: 'string', description: 'Repo under ~/repos to inspect. Defaults to gpt-bot.' }
      },
      required: ['task']
    },
    async execute(args, _ctx): Promise<string> {
      const task = args.task
      if (typeof task !== 'string' || !task.trim()) return 'codex: task must be a non-empty string'
      const repo = cleanRepo(args.repo)
      if (!repo) return 'codex: invalid repo name'
      return runCodexReadOnly({ task: task.trim(), repo }, TIMEOUT_MS, OUT_CAP)
    }
  }
}

/**
 * Live-call handoff to a writable Codex worker. Unlike `codex`, this returns to
 * Realtime immediately; VoiceSession later injects the completed result and
 * asks the voice model to report it naturally. The explicit defer sink prevents
 * text/API turns from launching orphaned background mutations.
 */
export function makeCodexHelperTool(options: CodexHelperOptions = {}): Tool {
  const run = options.run ?? runCodexHelper
  const makeJobId = options.makeJobId ?? (() => `job_${randomBytes(4).toString('hex')}`)
  return {
    name: 'codex_helper',
    availability: 'voice',
    description:
      'Delegate substantial repository work to a background Codex coding agent on this host. Use for implementing fixes/features, editing files, running tests, codebase-wide investigation, commits, or deployment work that should continue while the voice call stays responsive. Give a self-contained task and the repo name under ~/repos. The call gets an immediate job acknowledgement; completion is delivered automatically later. Do not use for quick factual questions or ordinary conversation.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete implementation order, including verification and deployment expectations.' },
        repo: { type: 'string', description: 'Repo directory under ~/repos (for example gpt-bot).' },
      },
      required: ['task', 'repo'],
    },
    async execute(args, ctx): Promise<string> {
      if (!ctx.defer) return 'codex_helper is only available during a live voice session'
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (!task) return 'codex_helper: task must be a non-empty string'
      const repo = cleanRepo(args.repo, '')
      if (!repo) return 'codex_helper: invalid repo name'
      const id = makeJobId()
      const result = run({ task, repo, writable: true })
        .catch(e => `codex_helper failed: ${e instanceof Error ? e.message : String(e)}`)
      ctx.defer({ id, tool: 'codex_helper', result })
      return `${id} accepted and running in the background. Tell the caller briefly, then keep the conversation available; the completed result will arrive automatically.`
    },
  }
}
