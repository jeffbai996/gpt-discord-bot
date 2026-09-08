#!/usr/bin/env node
import readline from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const threadId = 'provider-failure-test-thread'
const turnId = 'provider-failure-test-turn'
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === 'initialize') send({ id: request.id, result: {} })
  else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: threadId } } })
  else if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: turnId } } })
    setTimeout(() => {
      const mode = process.env.TEST_PROVIDER_CASE
      const error = mode === 'silence' ? null : mode === 'rate'
        ? { message: 'Too many requests', codexErrorInfo: 'rate_limit_exceeded' }
        : { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'server_overloaded' }
      send({ method: 'turn/completed', params: { threadId, turn: {
        id: turnId, status: error ? 'failed' : 'completed', error,
      } } })
    }, 10)
  } else send({ id: request.id, result: {} })
})
