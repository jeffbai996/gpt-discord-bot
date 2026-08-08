import type { ToolCall } from './openai.ts'

// A final answer that merely announces imminent action is not a result. Keep
// this deliberately narrow: first-person implementation promises, not ordinary
// predictions such as "I think it will rise".
const BARE_ACTION_PROMISE = /\b(?:on it|i(?:'m| am)\s+(?:working on|making|fixing|implementing|checking|investigating|running|starting|deploying|updating|changing|building)|i(?:'ll| will)\s+(?:fix|implement|check|investigate|run|start|deploy|make|update|change|build|do|handle))\b/i

export function isBareActionPromise(reply: string, toolCalls: Array<Pick<ToolCall, 'name'>>): boolean {
  return toolCalls.length === 0 && BARE_ACTION_PROMISE.test(reply)
}

export const COMPLETION_RETRY_PROMPT = `
[SYSTEM COMPLETION GATE]
Your previous final answer only promised future action and executed no tools.
That is an invalid terminal state. Execute the requested work now. Do not stop
at a plan or progress update. Finish and verify it, or report a concrete blocker
that genuinely requires user input or new authority.
`.trim()
