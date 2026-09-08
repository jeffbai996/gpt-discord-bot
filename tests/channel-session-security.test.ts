import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('session security epoch backs up and invalidates resumable sessions exactly once', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'gpt-session-security-'))
  const oldStateDir = process.env.GPT_STATE_DIR
  process.env.GPT_STATE_DIR = stateDir
  try {
    await writeFile(path.join(stateDir, 'channel-sessions.json'), JSON.stringify({ channel: 'session-secret' }))
    await writeFile(path.join(stateDir, 'channel-usage.json'), JSON.stringify({
      channel: { input: 10, output: 2, cachedInput: 0, reasoning: 1 },
    }))
    await chmod(path.join(stateDir, 'channel-sessions.json'), 0o664)
    await chmod(path.join(stateDir, 'channel-usage.json'), 0o664)
    const { channelSessions } = await import(`../src/channel-sessions.ts?security=${Date.now()}`)

    assert.equal(channelSessions.get('channel'), 'session-secret')
    assert.equal(channelSessions.invalidateAllOnce('history-auth-test-v1'), 1)
    assert.equal(channelSessions.get('channel'), undefined)
    assert.equal(await readFile(path.join(stateDir, 'channel-sessions.json'), 'utf8'), '{}')
    assert.match(
      await readFile(path.join(stateDir, 'channel-sessions.json.history-auth-test-v1.bak'), 'utf8'),
      /session-secret/,
    )
    for (const file of [
      'channel-sessions.json',
      'channel-usage.json',
      'channel-session-security-epoch',
      'channel-sessions.json.history-auth-test-v1.bak',
      'channel-usage.json.history-auth-test-v1.bak',
    ]) {
      assert.equal((await stat(path.join(stateDir, file))).mode & 0o777, 0o600)
    }

    channelSessions.set('channel', 'new-session')
    await chmod(path.join(stateDir, 'channel-sessions.json'), 0o664)
    assert.equal(channelSessions.invalidateAllOnce('history-auth-test-v1'), 0)
    assert.equal(channelSessions.get('channel'), 'new-session')
    assert.equal((await stat(path.join(stateDir, 'channel-sessions.json'))).mode & 0o777, 0o600)
  } finally {
    if (oldStateDir === undefined) delete process.env.GPT_STATE_DIR
    else process.env.GPT_STATE_DIR = oldStateDir
    await rm(stateDir, { recursive: true, force: true })
  }
})
