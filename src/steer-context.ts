const STEER_JUDGMENT = `[Steering context: this message arrived while you were already working. Treat it as guidance, not an automatic replacement task. Use judgment:
- Do it now when the user explicitly asks for immediate action, it is necessary to complete the active task correctly, or delaying it would create avoidable risk.
- An immediate side task does not cancel the active task. After handling the side task, resume the original task in the same turn and do not give a final response until both are complete or genuinely blocked.
- Record a concise durable todo using the available project mechanism when it is genuinely separate future work or the user says it should happen later; do not start that work now.
- Only abandon or replace the original task when the user clearly cancels it or the steer clearly supersedes it. If it corrects or narrows the active request, adjust the active work and preserve already-completed useful progress.
- If it is merely conversational context, incorporate it without inventing work.
Briefly state what you chose when the choice is not obvious.]`

export function frameSteeredMessages(messages: string[]): string {
  const content = messages.filter(Boolean).join('\n')
  return content ? `${STEER_JUDGMENT}\n\n${content}` : ''
}
