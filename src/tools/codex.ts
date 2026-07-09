import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { Tool } from './registry.ts'

const execFileAsync = promisify(execFile)
const CODEX_BIN = process.env.GPT_CODEX_BIN || '/home/user/.nvm/versions/node/v22.22.2/bin/codex'
const REPOS_DIR = '/home/user/repos'
const TIMEOUT_MS = 230_000 // ~4 min — this runs in the bot's own process, so there's
// no Claude-Code 60s hook ceiling (unlike the shared-context /code passthrough).
const OUT_CAP = 6000

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
        repo: { type: 'string', description: 'Repo under ~/repos to inspect (e.g. shared-context, gpt-bot, gem-bot). Defaults to shared-context.' }
      },
      required: ['task']
    },
    async execute(args, _ctx): Promise<string> {
      const task = args.task
      if (typeof task !== 'string' || !task.trim()) return 'codex: task must be a non-empty string'
      const repoRaw = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : 'shared-context'
      const repo = repoRaw.replace(/[^A-Za-z0-9._-]/g, '')
      const repoDir = `${REPOS_DIR}/${repo}`
      const outfile = `/tmp/gpt_codex_${randomBytes(6).toString('hex')}.txt`
      // Task is passed via env (CODEX_TASK) so arbitrary prompt text can't break
      // out of the shell command. repo + outfile are sanitized/internal.
      const script =
        `[ -d "${repoDir}" ] || { echo "no such repo: ${repo}"; exit 2; }; ` +
        `timeout -k 5 ${Math.floor(TIMEOUT_MS / 1000)} "${CODEX_BIN}" exec --skip-git-repo-check ` +
        `-s read-only -C "${repoDir}" -o "${outfile}" "$CODEX_TASK" </dev/null >/tmp/gpt_codex_log.txt 2>&1; ` +
        `if [ -s "${outfile}" ]; then cat "${outfile}"; else echo "(codex produced no answer)"; tail -4 /tmp/gpt_codex_log.txt; fi`
      try {
        const { stdout } = await execFileAsync('bash', ['-lc', script], {
          timeout: TIMEOUT_MS + 10_000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, CODEX_TASK: task }
        })
        await rm(outfile, { force: true }).catch(() => {})
        const out = (stdout || '').trim()
        if (!out) return 'codex: empty result'
        return out.length > OUT_CAP ? `${out.slice(0, OUT_CAP)}\n…(truncated)` : out
      } catch (e: any) {
        await rm(outfile, { force: true }).catch(() => {})
        return `codex: ${e?.message ?? String(e)}`
      }
    }
  }
}
