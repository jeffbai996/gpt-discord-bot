export type ReactionAction =
  | 'regenerate' | 'expand' | 'pin' | 'delete'
  | 'mute' | 'unmute' | 'markForEdit'

const REACTION_ACTIONS: Record<string, ReactionAction> = {
  '🔁': 'regenerate',
  '🔍': 'expand',
  '📌': 'pin',
  '❌': 'delete',
  '🔇': 'mute',
  '🔊': 'unmute',
  '✏️': 'markForEdit'
}

export function actionFor(emoji: string): ReactionAction | null {
  return REACTION_ACTIONS[emoji] ?? null
}

// Match a single Unicode emoji or ZWJ sequence (👨‍👩‍👧‍👦, 🏳️‍🌈, etc.).
// Discord's reaction PUT endpoint accepts standard unicode emojis without
// auth issues; custom Discord emojis (`:name:id`) only work if the bot has
// access to that emoji. The model occasionally emits custom emoji names from
// past Discord context, which Discord rejects with "Unknown Emoji" (10014).
// This validator rejects anything that isn't a pure Unicode emoji.
const SINGLE_EMOJI_RE =
  /^\p{Extended_Pictographic}(?:\u{FE0F})?(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F})?)*$/u

export function isValidOutboundReactEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  return SINGLE_EMOJI_RE.test(value)
}
