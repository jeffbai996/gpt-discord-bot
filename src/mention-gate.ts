type MentionedUser = {
  id: string
  bot?: boolean
}

export function isAddressedToAnotherBot(
  selfId: string,
  mentionedUsers: Iterable<MentionedUser>
): boolean {
  let mentionsSelf = false
  let mentionsAnotherBot = false

  for (const user of mentionedUsers) {
    if (user.id === selfId) mentionsSelf = true
    else if (user.bot) mentionsAnotherBot = true
  }

  return mentionsAnotherBot && !mentionsSelf
}
