import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { animationContactSheet } from '../src/animation-frames.ts'

const execFileAsync = promisify(execFile)

test('samples an animated GIF into a PNG contact sheet', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'animation-test-'))
  try {
    const gif = path.join(dir, 'input.gif')
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=6:duration=2', gif,
    ])
    const sampled = await animationContactSheet(await readFile(gif), '.gif')
    assert.ok(sampled.bytes.subarray(1, 4).equals(Buffer.from('PNG')))
    assert.ok(sampled.bytes.length > 100)
    await rm(sampled.directory, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
