import { execFileSync } from 'node:child_process'

// Kill a spawned process and its ENTIRE descendant tree, crossing process-group
// boundaries. This exists because the codex turn runs as
//   bash -lc "timeout -k 5 <n> codex exec …"   (spawned detached)
// and GNU `timeout` calls setpgid() to put codex in its OWN process group. So the
// old `process.kill(-bashPid)` group-kill hit bash but MISSED timeout + codex —
// they survived and kept running after /gpt stop ("✗ showed but gpt still running",
// Jeff 2026-07-05). Walking the tree by PPID reaches every node regardless of group.
//
// Order matters: collect the whole tree FIRST (while parents are alive so pgrep can
// see the links), THEN signal — kill a parent first and pgrep can no longer find its
// orphaned children (they reparent to init).

/** Recursively collect all descendant PIDs of `pid` (not including `pid` itself). */
function descendantPids(pid: number, acc: number[] = []): number[] {
  let out = ''
  try {
    // execFileSync (no shell) — pid is numeric, but keep the injection surface at zero.
    out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  } catch {
    // pgrep exits non-zero when there are no children — that's normal, not an error.
    return acc
  }
  for (const line of out.split('\n')) {
    const child = parseInt(line.trim(), 10)
    if (child && !acc.includes(child)) {
      acc.push(child)
      descendantPids(child, acc)
    }
  }
  return acc
}

/**
 * SIGKILL `rootPid` and every descendant. Best-effort and idempotent: already-dead
 * pids are ignored. Also fires a process-group kill as belt-and-suspenders for any
 * child that forked into rootPid's group after we snapshotted the tree.
 */
export function killProcessTree(rootPid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  // Snapshot the tree BEFORE killing anything (a dead parent hides its children).
  const tree = [rootPid, ...descendantPids(rootPid)]
  // Kill leaves-first (reverse) so a parent can't respawn/reparent a child mid-sweep.
  for (const pid of tree.reverse()) {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
  // Belt-and-suspenders: also nuke rootPid's own process group.
  try { process.kill(-rootPid, signal) } catch { /* group already empty */ }
}
