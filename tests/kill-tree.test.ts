import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { descendantPidsFromParentMap, killProcessTree } from '../src/kill-tree.ts'

// Reproduces the /gpt stop bug: gpt runs codex as
//   bash -lc "timeout -k 5 <n> codex exec …"  (spawned detached)
// and the old killTree did `process.kill(-bashPid)`. But GNU `timeout` calls
// setpgid() and puts its child in its OWN process group, so the group-kill hits
// bash and MISSES timeout + the real codex process — they keep running orphaned.
// killProcessTree must cross that boundary and leave nothing alive.

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Collect the whole descendant tree so the test can assert every node died,
// independent of process groups.
const descendants = (pid: number, acc: number[] = []): number[] => {
  let out = ''
  try { out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }) } catch { return acc }
  for (const line of out.split('\n')) {
    const c = parseInt(line.trim(), 10)
    if (c) { acc.push(c); descendants(c, acc) }
  }
  return acc
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('descendant snapshot crosses process groups and orders leaves first', () => {
  const parents = new Map([
    [20, 10],
    [30, 20],
    [40, 10],
    [50, 999],
  ])
  assert.deepEqual(descendantPidsFromParentMap(10, parents), [30, 20, 40])
})

test('killProcessTree kills a timeout-wrapped tree that re-groups (the /gpt stop bug)', async () => {
  // Exact shape of the gpt-bot codex spawn: detached bash → timeout → child.
  const script = `timeout -k 5 120 bash -c 'sleep 300' </dev/null 2>/dev/null`
  const child = spawn('bash', ['-lc', script], { detached: true })
  assert.ok(child.pid, 'spawn returned a pid')

  // Let the tree materialize (bash → timeout → sleep).
  await sleep(1200)
  const tree = [child.pid!, ...descendants(child.pid!)]
  // Sanity: the tree must actually include a `timeout` in its own group, else
  // the test isn't reproducing the bug.
  assert.ok(tree.length >= 3, `expected bash+timeout+sleep, got pids ${tree.join(',')}`)

  killProcessTree(child.pid!)

  // Give signals a beat to land, then assert NOTHING survived.
  await sleep(600)
  const survivors = tree.filter(alive)
  assert.deepEqual(survivors, [], `orphaned processes survived the kill: ${survivors.join(',')}`)
})
