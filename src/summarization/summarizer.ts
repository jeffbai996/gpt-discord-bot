import type OpenAI from 'openai'

export interface SummarizableMessage {
  authorName: string
  content: string
  timestamp: string
  messageId: string
}

const SYSTEM_PROMPT = `You are summarizing a Discord channel for context preservation. Produce a tight, factual summary that captures:
- Key decisions and conclusions
- Recurring themes or running jokes
- Important named entities (people, places, projects)
- Open questions or pending items
- The general tone of the channel

Constraints:
- Maximum ~500 words.
- Plain prose, no headers or bullets unless necessary for clarity.
- Don't editorialize. Report what was discussed.

If a previous summary is provided, incorporate it. Old facts that are still relevant stay; old facts superseded by newer messages are updated. Don't double-count.

Output ONLY the summary text. No preamble, no metadata.`

export interface SummarizerDeps {
  client: OpenAI
  model: string
}

// One-shot completion — non-streaming, no tools, no JSON mode. Returns the
// trimmed summary text + the message ID of the newest input message (the new
// "last_summarized_message_id" for the store).
export async function runSummarization(
  oldSummary: string | null,
  newMessages: SummarizableMessage[],
  deps: SummarizerDeps
): Promise<{ summary: string; lastMessageId: string }> {
  if (newMessages.length === 0) throw new Error('runSummarization called with empty newMessages')

  const formatted = newMessages
    .map(m => `[${m.timestamp}] ${m.authorName}: ${m.content}`)
    .join('\n')

  const userText = `PREVIOUS SUMMARY:\n${oldSummary ?? '(none)'}\n\nNEW MESSAGES SINCE PREVIOUS SUMMARY:\n${formatted}`

  // gpt-5.x rejects custom temperature + max_tokens.
  const isGpt5 = deps.model.startsWith('gpt-5')
  const params = isGpt5
    ? { max_completion_tokens: 1500 }
    : { temperature: 0.3, max_tokens: 1500 }

  const resp = await deps.client.chat.completions.create({
    model: deps.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText }
    ],
    ...params
  })

  const summary = (resp.choices?.[0]?.message?.content ?? '').trim()
  const lastMessageId = newMessages[newMessages.length - 1].messageId
  return { summary, lastMessageId }
}
