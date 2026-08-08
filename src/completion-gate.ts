// Codex CLI can exit cleanly while its authoritative "final" is actually a
// progress update. A clean child exit is process completion, not task
// completion, so keep the session alive and ask it to continue.

export const MAX_COMPLETION_CONTINUATIONS = 2

const ACTIVE_VERB = 'auditing|building|checking|changing|deploying|designing|diagnosing|fixing|implementing|inspecting|investigating|mapping|patching|refining|running|starting|testing|tracing|updating|verifying|working'
const FUTURE_VERB = 'audit|build|check|change|continue|deploy|design|diagnose|do|fix|implement|inspect|investigate|map|patch|refine|run|start|test|trace|update|verify|work'
const ONGOING_ACTION = new RegExp([
  String.raw`\b(?:on it|working on it)\b`,
  String.raw`\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:(?:still|currently|now|actively)\s+)?(?:${ACTIVE_VERB})\b`,
  String.raw`\b(?:next\s+)?i(?:'ll| will)\s+(?:${FUTURE_VERB})\b`,
  String.raw`\b(?:next\s+)?i(?:'m| am)\s+going to\s+(?:${FUTURE_VERB})\b`,
].join('|'), 'i')

export function isNonTerminalActionReply(reply: string): boolean {
  return ONGOING_ACTION.test(reply.trim())
}

export function completionContinuationPrompt(attempt: number): string {
  return [
    '[SYSTEM COMPLETION GATE]',
    `Continuation ${attempt}/${MAX_COMPLETION_CONTINUATIONS}: your previous final answer was a progress update, not a terminal result.`,
    'Continue the same requested task from its current state. Do not repeat the plan or merely announce another next action.',
    'Keep using commentary for progress while you work. End only with the completed and verified result, or a concrete blocker that genuinely requires user input or new authority.',
  ].join('\n')
}

export class NonTerminalCompletionError extends Error {
  constructor(public readonly attempts: number) {
    super(`Codex remained non-terminal after ${attempts} completion continuations`)
    this.name = 'NonTerminalCompletionError'
  }
}
