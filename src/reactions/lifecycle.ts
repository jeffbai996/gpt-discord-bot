/**
 * Lifecycle reactions on inbound user messages — surface what's happening
 * inside a turn so the bot is legible while it works.
 *
 * Each state cleans up its declared transient predecessors. Final states
 * (replied, errored, denied, blocked, truncated) clean every transient.
 *
 * Visible mid-stream signals:
 *   👀 received   — message accepted, before any work
 *   📎 ingesting  — processing attachments before generate (v0.5+)
 *   🤔 thinking   — model call in flight
 *   🧠 reasoning  — o-series reasoning summary or gpt-5.x thought signal (v0.4+)
 *   🌐 searching  — web_search grounding fired this turn (v0.6+)
 *   🔧 tooling    — function-call (fetch_url, search_memory, …) running (v0.6+)
 *
 * Terminal states (post-stream):
 *   ✅ replied    — substantive reply committed
 *   ✂️ truncated  — finish_reason === 'length', reply may be cut off
 *   🛑 blocked    — content_policy refusal
 *   ⚠️ denied     — rate-limited / quota / 429
 *   ❌ errored    — caught exception of any other kind
 *   ⏳ interrupted — codex turn was killed by the runaway-process backstop
 *
 * Virtual: silenced — no emoji, used when the model returns nothing and we
 * deliberately stay quiet; clears all transients without leaving a tombstone.
 */
import type { Message } from 'discord.js'

export const EMOJI = {
  received:   '👀',
  ingesting:  '📎',
  thinking:   '🤔',
  reasoning:  '🧠',
  searching:  '🌐',
  tooling:    '🔧',
  replied:    '✅',
  truncated:  '✂️',
  blocked:    '🛑',
  errored:    '❌',
  interrupted:'⏳',
  denied:     '⚠️',
  silenced:   '',
} as const

export type LifecycleState = keyof typeof EMOJI

const ALL_TRANSIENTS: LifecycleState[] = [
  'received', 'ingesting', 'thinking', 'reasoning',
  'searching', 'tooling',
]

const PREDECESSORS: Record<LifecycleState, LifecycleState[]> = {
  received:   [],
  ingesting:  ['received'],
  thinking:   ['received', 'ingesting'],
  reasoning:  ['received', 'ingesting'],
  searching:  ['received', 'ingesting'],
  tooling:    ['received', 'ingesting'],
  replied:    ALL_TRANSIENTS,
  truncated:  ALL_TRANSIENTS,
  blocked:    ALL_TRANSIENTS,
  errored:    ALL_TRANSIENTS,
  interrupted:ALL_TRANSIENTS,
  denied:     ALL_TRANSIENTS,
  silenced:   ALL_TRANSIENTS,
}

export async function applyLifecycle(message: Message, state: LifecycleState): Promise<void> {
  const emoji = EMOJI[state]

  const me = message.client.user
  if (me) {
    for (const prev of PREDECESSORS[state]) {
      const prevEmoji = EMOJI[prev]
      if (!prevEmoji || prevEmoji === emoji) continue
      const r = message.reactions.cache.get(prevEmoji)
      if (r) {
        await r.users.remove(me.id).catch(() => { /* fire-and-forget */ })
      }
    }
  }

  if (!emoji) return

  await message.react(emoji).catch(e => {
    console.error(`[lifecycle] react ${emoji} (${state}) failed:`, e)
  })
}

export async function dropLifecycle(message: Message, state: LifecycleState): Promise<void> {
  const emoji = EMOJI[state]
  if (!emoji) return
  const me = message.client.user
  if (!me) return
  const r = message.reactions.cache.get(emoji)
  if (r) {
    await r.users.remove(me.id).catch(() => { /* fire-and-forget */ })
  }
}
