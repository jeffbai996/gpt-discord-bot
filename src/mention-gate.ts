type MentionedUser = {
  id: string
  bot?: boolean
}

export function isAddressedToAnotherUser(
  selfId: string,
  mentionedUsers: Iterable<MentionedUser>
): boolean {
  let mentionsSelf = false
  let mentionsAnotherUser = false

  for (const user of mentionedUsers) {
    if (user.id === selfId) mentionsSelf = true
    else mentionsAnotherUser = true
  }

  return mentionsAnotherUser && !mentionsSelf
}
