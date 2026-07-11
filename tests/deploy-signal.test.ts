import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('documented deploy signals only the service main process', async () => {
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  assert.match(agents, /systemctl --user kill --kill-who=main -s SIGUSR2 gpt/)
  assert.doesNotMatch(agents, /systemctl --user kill -s SIGUSR2 gpt/)
})
