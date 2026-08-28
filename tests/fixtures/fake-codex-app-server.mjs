#!/usr/bin/env node

import { createInterface } from 'node:readline'

const ACTIVE_THREAD_ID = 'thread-active'
const ACTIVE_TURN_ID = 'turn-active'

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (typeof request?.id !== 'number') return

  if (request.method === 'initialize') {
    send({ id: request.id, result: {} })
    return
  }

  if (request.method === 'thread/start') {
    send({ id: request.id, result: { thread: { id: ACTIVE_THREAD_ID } } })
    return
  }

  if (request.method !== 'turn/start') return
  send({ id: request.id, result: { turn: { id: ACTIVE_TURN_ID } } })

  setTimeout(() => {
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread-foreign',
        turnId: 'turn-foreign',
        item: { type: 'agentMessage', phase: 'final_answer', text: 'FOREIGN RESULT' },
      },
    })
    send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-foreign',
        turn: { id: 'turn-foreign', status: 'completed' },
      },
    })
  }, 20)

  setTimeout(() => {
    send({
      method: 'item/completed',
      params: {
        threadId: ACTIVE_THREAD_ID,
        turnId: ACTIVE_TURN_ID,
        item: { type: 'agentMessage', phase: 'final_answer', text: 'ACTIVE RESULT' },
      },
    })
    send({
      method: 'turn/completed',
      params: {
        threadId: ACTIVE_THREAD_ID,
        turn: { id: ACTIVE_TURN_ID, status: 'completed' },
      },
    })
  }, 180)
})
