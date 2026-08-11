# Bot lifecycle contract (v1)

This bot conforms to the squad Discord lifecycle contract shared by gpt, llm,
and Gem.

1. Every accepted inbound message holds an admission lease until its channel
   work has settled.
2. A restart request is pending, not draining: unrelated channels keep being
   admitted and become part of the idle calculation.
3. Duplicate restart requests coalesce. A ten-minute overrun is logged as a
   warning and never kills healthy work.
4. At natural idle, intake closes atomically before a transient systemd unit
   requests the service restart. Messages arriving in that cutover window are
   durably deduplicated and replayed on the next boot.
5. Once systemd commits the restart with SIGTERM, cleanup is bounded to 15
   seconds by default so a wedged child cannot hold Discord offline forever.
6. Explicit stop remains an immediate kill. Normal follow-up steering stays
   separate and must not be relabeled as an interruption.
7. A process that dies with an unfinished placeholder marks that placeholder
   `✗ **Interrupted**` on boot; queued cutover messages are replayed instead.

The lifecycle primitives are deliberately vendored in each bot for v1. The
provider ingress, command, placeholder, and steering seams still differ enough
that a shared runtime package would hide coupling rather than remove it.
Equivalent conformance tests are the contract. Reconsider extraction after the
next cross-bot lifecycle change, once two real changes expose a stable API.
