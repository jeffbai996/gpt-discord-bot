import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { recordCommandUsage } from '../src/command-usage.ts'

test('command usage telemetry appends anonymous slash paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-command-usage-'))
  const file = path.join(dir, 'command-usage.jsonl')

  await recordCommandUsage('settings', file)
  await recordCommandUsage('voice join', file)

  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => row.command), ['settings', 'voice join'])
  assert.ok(rows.every(row => typeof row.ts === 'string' && !('userId' in row) && !('channelId' in row)))
})
