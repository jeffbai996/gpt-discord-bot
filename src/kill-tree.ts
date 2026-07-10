import { readdirSync, readFileSync } from 'node:fs'

// Kill a spawned process and its ENTIRE descendant tree, crossing process-group
// boundaries. Codex tools can create their own process groups, so a group signal
// alone can miss descendants. Snapshot before signalling: once a parent dies,
// its children reparent and can no longer be discovered from the original root.

function procParentMap(): Map<number, number> {
  const parents = new Map<number, number>()
  let entries: string[] = []
  try { entries = readdirSync('/proc') } catch { return parents }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8')
      const match = status.match(/^PPid:\s+(\d+)/m)
      if (match) parents.set(Number(entry), Number(match[1]))
    } catch { /* process exited during the snapshot */ }
  }
  return parents
}

/** Return descendants in leaves-first order from one atomic-ish /proc snapshot. */
export function descendantPidsFromParentMap(rootPid: number, parents: Map<number, number>): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, parent] of parents) {
    const siblings = children.get(parent) ?? []
    siblings.push(pid)
    children.set(parent, siblings)
  }
  const ordered: number[] = []
  const visited = new Set<number>()
  const walk = (pid: number) => {
    if (visited.has(pid)) return
    visited.add(pid)
    for (const child of children.get(pid) ?? []) walk(child)
    if (pid !== rootPid) ordered.push(pid)
  }
  walk(rootPid)
  return ordered
}

/**
 * SIGKILL `rootPid` and every descendant. Best-effort and idempotent: already-dead
 * pids are ignored. Also fires a process-group kill as belt-and-suspenders for any
 * child that forked into rootPid's group after we snapshotted the tree.
 */
export function killProcessTree(rootPid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  // Snapshot the entire host process table once. The old recursive `pgrep -P`
  // launched one synchronous subprocess per descendant and could freeze Node for
  // seconds precisely when the bot was trying to recover from a hang.
  const tree = [...descendantPidsFromParentMap(rootPid, procParentMap()), rootPid]
  for (const pid of tree) {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
  // Belt-and-suspenders: also nuke rootPid's own process group.
  try { process.kill(-rootPid, signal) } catch { /* group already empty */ }
}
