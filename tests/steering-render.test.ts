import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('steering silently removes the superseded UI instead of rendering Interrupted', () => {
  const source = fs.readFileSync(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const stoppedBranch = source.slice(
    source.indexOf('if (e instanceof CodexStoppedError) {'),
    source.indexOf('// An intentional restart', source.indexOf('if (e instanceof CodexStoppedError) {')),
  )

  assert.match(stoppedBranch, /consumeSteered/)
  assert.match(stoppedBranch, /steered \? 'silenced' : 'interrupted'/)
  assert.match(stoppedBranch, /workMessage\.delete/)
})
