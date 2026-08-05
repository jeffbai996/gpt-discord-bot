import type { PollData } from 'discord.js'

const CUSTOM_EMOJI = /^(<a?:[A-Za-z0-9_]+:\d+>)\s+(.+)$/u
const UNICODE_EMOJI = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|[\p{Regional_Indicator}]{2})\s+(.+)$/u

export function parsePollAnswers(spec: string): PollData['answers'] {
  const parts = spec.split('|').map(x => x.trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > 10) throw new Error('poll needs 2–10 options separated by |')
  return parts.map(part => {
    const match = part.match(CUSTOM_EMOJI) ?? part.match(UNICODE_EMOJI)
    const text = (match?.[2] ?? part).trim()
    if (!text || text.length > 55) throw new Error('each poll option must be 1–55 characters')
    return match ? { text, emoji: match[1] } : { text }
  })
}

export function buildPoll(question: string, options: string, duration = 24, allowMultiselect = false): PollData {
  const q = question.trim()
  if (!q || q.length > 300) throw new Error('poll question must be 1–300 characters')
  if (!Number.isInteger(duration) || duration < 1 || duration > 768) throw new Error('poll duration must be 1–768 whole hours')
  return { question: { text: q }, answers: parsePollAnswers(options), duration, allowMultiselect }
}
