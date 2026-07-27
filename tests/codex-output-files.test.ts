import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

import {
  generatedImageDataUrlsFromRollout,
  materializeGeneratedImages,
} from '../src/codex-chat.ts'

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`

test('generatedImageDataUrlsFromRollout keeps current imagegen outputs only', () => {
  const startedAt = Date.parse('2026-07-27T20:00:00.000Z')
  const rows = [
    {
      timestamp: '2026-07-27T19:59:59.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'old', name: 'imagegen', namespace: 'image_gen' },
    },
    {
      timestamp: '2026-07-27T20:00:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'view', name: 'view_image' },
    },
    {
      timestamp: '2026-07-27T20:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'new', name: 'imagegen', namespace: 'image_gen' },
    },
    {
      timestamp: '2026-07-27T20:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'view',
        output: [{ type: 'input_image', image_url: PNG_DATA_URL }],
      },
    },
    {
      timestamp: '2026-07-27T20:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'new',
        output: [{ type: 'input_image', image_url: PNG_DATA_URL }],
      },
    },
  ]

  assert.deepEqual(
    generatedImageDataUrlsFromRollout(rows.map(row => JSON.stringify(row)).join('\n'), startedAt),
    [PNG_DATA_URL],
  )
})

test('materializeGeneratedImages writes attachable temporary files', async () => {
  const files = await materializeGeneratedImages([PNG_DATA_URL])
  try {
    assert.equal(files.length, 1)
    assert.equal(await fs.readFile(files[0], 'utf8'), 'fake-png')
    assert.match(files[0], /generated-1\.png$/)
  } finally {
    await fs.rm(files[0], { force: true })
    await fs.rm(new URL('.', `file://${files[0]}`).pathname, { recursive: true, force: true })
  }
})
