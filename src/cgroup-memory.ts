import fs from 'node:fs'
import path from 'node:path'

/** Read memory for this service's complete cgroup, including Codex children. */
export function readSelfCgroupMemoryBytes(
  cgroupFile = '/proc/self/cgroup',
  cgroupRoot = '/sys/fs/cgroup',
): number | null {
  try {
    const line = fs.readFileSync(cgroupFile, 'utf8')
      .split('\n')
      .find(entry => entry.startsWith('0::'))
    if (!line) return null
    const relative = line.slice(3).replace(/^\/+/, '')
    const raw = fs.readFileSync(path.join(cgroupRoot, relative, 'memory.current'), 'utf8').trim()
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}
