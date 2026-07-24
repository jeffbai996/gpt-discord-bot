import assert from 'node:assert/strict'
import test from 'node:test'

import { gptCommand } from '../src/commands.ts'

test('/gpt thinking exposes distinct live and collapse modes', () => {
  const command = gptCommand.toJSON()
  const thinking = command.options?.find(option => option.name === 'thinking') as any
  const value = thinking?.options?.find((option: any) => option.name === 'value')

  assert.deepEqual(
    value?.choices?.map((choice: any) => choice.value),
    ['off', 'on', 'live', 'collapse'],
  )
  assert.match(value?.choices?.find((choice: any) => choice.value === 'live')?.name ?? '', /current thought/)
  assert.match(value?.choices?.find((choice: any) => choice.value === 'collapse')?.name ?? '', /full trace/)
})
