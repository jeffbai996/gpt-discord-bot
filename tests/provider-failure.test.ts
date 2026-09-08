import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderFailure, codexCompletionFailure, providerFailureNotice } from '../src/provider-failure.ts'
import { normalizeAppServerNotification } from '../src/codex-chat.ts'

test('capacity and generic receipts use concise copy and advertise the wired reaction', () => {
  for (const detail of [{ codexErrorInfo: 'server_overloaded' }, {}]) {
    const notice = providerFailureNotice(new ProviderFailure(detail))!
    assert.doesNotMatch(notice, /OpenAI|this turn did not complete/)
    assert.match(notice, /🔁/)
  }
})

test('failed app-server completion exposes capacity failure despite empty answer', () => {
  const event = normalizeAppServerNotification({ method: 'turn/completed', params: {
    turn: { status: 'failed', error: {
      message: 'Selected model is at capacity. Please try a different model.',
      codexErrorInfo: 'server_overloaded',
    } },
  } })
  const failure = codexCompletionFailure(event)
  assert.ok(failure instanceof ProviderFailure)
  assert.match(providerFailureNotice(failure)!, /🛑.*capacity/)
})

test('completed turn with an error cannot be intentional silence', () => {
  assert.ok(codexCompletionFailure({ status: 'completed', error: { codex_error_info: 'server_overloaded' } }))
  assert.equal(codexCompletionFailure({ status: 'completed' }), null)
})

test('rate limits and exhausted quota have distinct retry guidance', () => {
  assert.match(providerFailureNotice({ status: 429, code: 'rate_limit_exceeded' })!, /429.*Retry/)
  assert.match(providerFailureNotice({ status: 429, code: 'insufficient_quota' })!, /quota.*billing/i)
  assert.match(providerFailureNotice({ reason: 'rate_limited (429)', details: { status: 429 } })!, /429/)
})

test('unknown failed completion is visible without leaking provider payload', () => {
  const failure = codexCompletionFailure({ status: 'failed', error: { message: 'secret provider payload' } })
  assert.ok(failure)
  assert.match(providerFailureNotice(failure)!, /🛑.*failed/)
  assert.doesNotMatch(providerFailureNotice(failure)!, /secret/)
  assert.equal(providerFailureNotice(new Error('unrelated local failure')), null)
})

test('HTTP server and authentication errors get explicit notices', () => {
  assert.match(providerFailureNotice({ status: 503 })!, /503/)
  assert.match(providerFailureNotice({ status: 401 })!, /401.*authentication/)
})
