import assert from 'node:assert/strict'
import test from 'node:test'
import { steeredMarker } from '../src/steering.ts'

test('formats steered duration as Discord subtext', () => {
  assert.equal(steeredMarker(125_000), '-# Steered after 2m 5s')
})
