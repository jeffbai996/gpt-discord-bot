import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('gpt systemd guard contains browser-heavy turns inside the service cgroup', async () => {
  const guard = await readFile(
    new URL('../systemd/gpt.service.d/50-memory-guard.conf', import.meta.url),
    'utf8',
  )

  assert.match(guard, /^MemoryAccounting=yes$/m)
  assert.match(guard, /^MemoryHigh=4G$/m)
  assert.match(guard, /^MemoryMax=5G$/m)
  assert.match(guard, /^MemorySwapMax=512M$/m)
  assert.match(guard, /^OOMPolicy=kill$/m)
})
