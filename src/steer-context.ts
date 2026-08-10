const STEER_JUDGMENT = `[Queued follow-up context: this message arrived while the prior turn was working. The prior turn was allowed to finish; this is not a reset or replacement task. Use judgment:
- Use the prior turn's result and tool work as context. Handle an immediate addition or correction now, but do not redo the completed task unless the user asks.
- Record a concise durable todo using the available project mechanism when it is genuinely separate future work or the user says it should happen later; do not start that work now.
- Only abandon or replace the original task when the user clearly cancels it or the steer clearly supersedes it. If it corrects or narrows the active request, adjust the active work and preserve already-completed useful progress.
- If it is merely conversational context, incorporate it without inventing work.
Briefly state what you chose when the choice is not obvious.]`

export function frameSteeredMessages(messages: string[]): string {
  const content = messages.filter(Boolean).join('\n')
  return content ? `${STEER_JUDGMENT}\n\n${content}` : ''
}
