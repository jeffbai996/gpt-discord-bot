# gpt queue/steering death and API fallback investigation

Work in the checked-out `gpt-bot` repository. The Discord bot is the `gpt.service`
systemd user service. Its default chat engine is the Codex CLI; the OpenAI API
is only a fallback. Jeff reports that follow-up messages/steering often kill the
Codex turn, lose visible progress, and unexpectedly continue on the API.

## Confirmed evidence

`~/.gpt/channels/discord/gpt.log` repeatedly shows this exact sequence:

```text
[restart] requested; draining active turns before asking systemd to restart
[codex-turn] error ... codex exited code=null signal=SIGUSR2
codex chat failed, falling back to API: Error: codex exited code=null signal=SIGUSR2
[shutdown] SIGTERM received; waiting for active turns to finish
```

This happened at least three times on 2026-07-10. The API tool-loop cap is not
the cause: `GPT_MAX_TOOL_LOOPS` already defaults to 256.

The deploy command `systemctl --user kill -s SIGUSR2 gpt` signals the service
cgroup, including the active Codex child, not reliably just the Node main
process. That kills Codex before graceful drain completes. The generic Codex
catch then misclassifies the intentional signal as a crash and starts API
fallback while the service is shutting down.

There was also a false-idle bug in `src/active-turns.ts`: `stopFor()` called
the killer and immediately deleted liveness. The Discord handler and child
teardown were still unwinding, so restart drain and barge logic observed idle
too early.

## Patch already present in the working tree

- `src/active-turns.ts`: `stopFor()` keeps liveness registered until the
  handler's `finally` calls `done()`.
- `src/gpt.ts`: a Codex exit while the shutdown gate is draining suppresses
  API fallback and reports restart-in-progress.
- `src/gpt.ts`: persisted thinking uses one Discord multiline quote (`>>>`)
  rather than prefixing every newline with `>`.
- `tests/active-turns-barge.test.ts`: expectations cover teardown liveness.

Do not discard unrelated user work. `SQUAD-trim-full-diff.md` is untracked and
not part of this task.

## Investigation/fix still required

1. Change every deploy/restart sender to signal only the main Node process:
   `systemctl --user kill --kill-who=main -s SIGUSR2 gpt`. Search docs,
   scripts, operator integrations, and remote deploy commands. Do not edit
   system dotfiles or unit files without Jeff's approval.
2. Make restart drain wait for the real per-channel runner (`channelTurns`) as
   well as `activeTurns`, including Discord rendering/cleanup and queued
   batches.
3. Add generation tokens to active-turn registration so stale completion/tool
   events from an old process cannot clear or mutate a newer channel turn.
4. Fix the deferred-barge absolute deadline. If the eight-second timer fires
   during a busy tool it currently sets `timer = null` and can wait forever
   when the expected completion event never arrives. Preserve tool safety but
   add bounded recovery and explicit telemetry.
5. Decide and test queue semantics. Barge currently uses
   `st.queue.unshift(message)` while ordinary queuing uses `push`, so
   repeated steering can reverse order. Prefer FIFO unless an explicit
   latest-wins policy is chosen.
6. Split live thought/progress ownership from partial/final output. The generic
   `partial` handler still edits `workMessage`, which can overwrite the
   thought card and then disappear on completion.
7. Add a deterministic integration test with a fake long-lived Codex child:
   enqueue A/B/C, barge during idle and during a simulated shell tool, request
   restart, and assert no API responder call, no false idle, FIFO delivery, one
   final per accepted batch, and clean shutdown.
8. Add structured lifecycle logging with channel/turn generation, queue depth,
   stop reason, signal, engine, fallback reason, and restart phase. Do not log
   message bodies or private content.

## Verification

```bash
cd <gpt-bot-repo>
npm test
git diff --check
systemctl --user status gpt --no-pager -l
tail -n 300 ~/.gpt/channels/discord/gpt.log
```

For a deploy test, start a long Codex turn in the private test channel, queue
two follow-ups, then signal only the main process. Verify the child is not
directly hit with `SIGUSR2`, restart waits or explicitly hands off queued
work, and the log contains no `falling back to API` line. Do not use a public
channel for the first destructive lifecycle test.

Carry the work through tests, commit, push, and safe in-band deploy. Report the
mechanism, changed files, test counts, deployed commit, and remaining risk.
