import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function recordCommandUsage(
  command: string,
  file = path.join(
    process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord'),
    'command-usage.jsonl',
  ),
): Promise<void> {
  const row = JSON.stringify({ ts: new Date().toISOString(), command }) + '\n'
  try {
    // O_APPEND keeps separate gpt instances from replacing each other's rows.
    await fs.appendFile(file, row, 'utf8')
  } catch {
    // Telemetry must never break an admin command.
  }
}
