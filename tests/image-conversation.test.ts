import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseImageRequest, imageConversationInstruction, selectImageReference } from '../src/image-conversation.ts'

test('accepts only a complete image action and keeps contextual prompt', () => {
  assert.deepEqual(parseImageRequest('{"image_request":{"prompt":"The orange cat we discussed, in a crown","use_reference":true}}'),
    { prompt: 'The orange cat we discussed, in a crown', useReference: true })
  assert.equal(parseImageRequest('Here is an example: {"image_request":{}}'), null)
  assert.equal(parseImageRequest('normal reply'), null)
})
test('rejects malformed and oversized action payloads', () => {
  assert.throws(() => parseImageRequest('{"image_request":{}}'), /Invalid/)
  assert.throws(() => parseImageRequest(JSON.stringify({image_request:{prompt:'x'.repeat(4001)}})), /Invalid/)
})
test('instruction requires context resolution and explicit user intent', () => {
  assert.match(imageConversationInstruction, /recent conversation/)
  assert.match(imageConversationInstruction, /only when the user requests/)
})
test('references stay scoped to eligible authors and reset cutoff', () => {
  const rows = [
    { id:'20', authorId:'other', createdTimestamp:100, attachments:[{name:'other.png',contentType:'image/png'}] },
    { id:'19', authorId:'bot', createdTimestamp:100, attachments:[{name:'art.png',contentType:'image/png'}] },
  ]
  assert.equal(selectImageReference(rows, 'user', 'bot', 'make it nighttime', null, 200)?.name, 'art.png')
  assert.equal(selectImageReference(rows, 'user', 'bot', 'make it nighttime', '19', 200), undefined)
  assert.equal(selectImageReference(rows, 'user', 'bot', 'hello', null, 200), undefined)
})

