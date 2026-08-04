type MentionedUser = {
  id: string
  bot?: boolean
}

const USER_MENTION_RE = /<@!?(\d+)>/g

export function explicitUserMentionIds(content: string): Set<string> {
  const ids = new Set<string>()
  for (const match of content.matchAll(USER_MENTION_RE)) ids.add(match[1])
  return ids
}

export function isExplicitlyAddressedToAnotherUser(selfId: string, content: string): boolean {
  const explicitIds = explicitUserMentionIds(content)
  return explicitIds.size > 0 && !explicitIds.has(selfId)
}

export function isAddressedToAnotherUser(
  selfId: string,
  mentionedUsers: Iterable<MentionedUser>,
  content?: string,
  repliedAuthor?: MentionedUser | null,
): boolean {
  // Discord includes the author of a replied-to message in `mentions.users`
  // when reply-ping is enabled, even when the user explicitly addressed
  // somebody else in the message body. Explicit mention tokens are the real
  // addressing signal; a synthetic reply mention must not override them.
  if (content !== undefined) {
    const explicitIds = explicitUserMentionIds(content)
    if (explicitIds.size > 0) {
      return !explicitIds.has(selfId)
    }
  }

  // A reply is an address to the referenced bot even when reply-ping is off
  // and Discord therefore omits it from mentions.users.
  if (repliedAuthor?.bot) return repliedAuthor.id !== selfId

  let mentionsSelf = false
  let mentionsAnotherUser = false

  for (const user of mentionedUsers) {
    if (user.id === selfId) mentionsSelf = true
    else mentionsAnotherUser = true
  }

  return mentionsAnotherUser && !mentionsSelf
}
