import type { ToolCall } from './openai.ts'

export interface CompletionReceipt {
  text: string
  filesChanged: number
}

const TEST_COMMAND_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bpytest\b|\bnode\s+--test\b|\bgo\s+test\b|\bcargo\s+test\b/i
const DEPLOY_COMMAND_RE = /\bgit\s+push\b|\bsystemctl\b.*\b(?:restart|reload|SIGUSR2)\b|\bdeploy\b/i

function commandOf(call: ToolCall): string {
  return String(call.args?.command ?? call.args?.cmd ?? '')
}

function testSummary(calls: ToolCall[]): string | null {
  const tests = calls.filter(call => !call.failed && call.name === 'shell' && TEST_COMMAND_RE.test(commandOf(call)))
  if (!tests.length) return null
  for (const call of [...tests].reverse()) {
    const output = call.resultPreview ?? ''
    const pytest = output.match(/(\d+)\s+passed(?:,\s*(\d+)\s+skipped)?/i)
    if (pytest) return `${pytest[1]} tests passed${pytest[2] ? ` / ${pytest[2]} skipped` : ''}`
    const tapPass = output.match(/#\s*pass\s+(\d+)/i)
    const tapSkip = output.match(/#\s*skipped\s+(\d+)/i)
    if (tapPass) return `${tapPass[1]} tests passed${tapSkip?.[1] ? ` / ${tapSkip[1]} skipped` : ''}`
  }
  return `${tests.length === 1 ? 'tests passed' : `${tests.length} test runs passed`}`
}

export function buildCompletionReceipt(toolCalls: ToolCall[]): CompletionReceipt | null {
  const files = new Set(
    toolCalls
      .filter(call => !call.failed && call.name === 'edit')
      .map(call => String(call.args?.file_path ?? '').trim())
      .filter(Boolean),
  )
  const successfulShell = toolCalls.filter(call => !call.failed && call.name === 'shell')
  const tests = testSummary(successfulShell)
  const commit = successfulShell
    .map(call => call.resultPreview?.match(/\[[^\]]+\s+([0-9a-f]{7,40})\]/i)?.[1])
    .find(Boolean)
  const deployed = successfulShell.some(call => DEPLOY_COMMAND_RE.test(commandOf(call)))

  if (!files.size && !tests && !commit && !deployed) return null

  const facts: string[] = []
  if (files.size) facts.push(`${files.size} file${files.size === 1 ? '' : 's'} changed`)
  if (tests) facts.push(tests)
  if (commit) facts.push(`commit ${commit.slice(0, 8)}`)
  if (deployed) facts.push('deployed')
  return {
    filesChanged: files.size,
    text: `-# ▸ work receipt · ||${facts.join(' · ')}||`,
  }
}
