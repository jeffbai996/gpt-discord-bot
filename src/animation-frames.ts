import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Sample motion into one six-frame PNG so image-only models see the loop. */
export async function animationContactSheet(
  bytes: Buffer,
  sourceExtension: string,
  directory?: string,
): Promise<{ bytes: Buffer; path: string; directory: string }> {
  const dir = directory ?? await mkdtemp(path.join(tmpdir(), 'discord-animation-'))
  const input = path.join(dir, `animation${sourceExtension.startsWith('.') ? sourceExtension : `.${sourceExtension}`}`)
  const output = path.join(dir, 'animation-contact-sheet.png')
  await writeFile(input, bytes, { mode: 0o600 })
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', 'fps=3,scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=white@0,tile=3x2:padding=4:margin=4',
    '-frames:v', '1', output,
  ], { timeout: 20_000, maxBuffer: 1_000_000 })
  return { bytes: await readFile(output), path: output, directory: dir }
}
