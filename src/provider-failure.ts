// Provider refusals can end a CLI process successfully while the turn failed.
// Keep their terminal state separate from both process death and model silence.
export class ProviderFailure extends Error {
  constructor(public readonly detail: unknown) {
    super('OpenAI turn failed', { cause: detail })
    this.name = 'ProviderFailure'
  }
}

export function codexCompletionFailure(event: { status?: string; error?: unknown }): ProviderFailure | null {
  return event.error || event.status === 'failed'
    ? new ProviderFailure(event.error ?? { message: 'Turn failed without error details' })
    : null
}

export function providerFailureNotice(error: unknown): string | null {
  const value: any = error instanceof ProviderFailure ? error.detail : error
  const detail = value?.details ?? value
  const status = Number(detail?.status ?? detail?.statusCode ?? detail?.httpStatusCode)
  const info = detail?.codexErrorInfo ?? detail?.codex_error_info
  const text = [detail?.code, detail?.type, detail?.message, value?.reason,
    typeof info === 'string' ? info : JSON.stringify(info ?? {})].join(' ').toLowerCase()
  let label: string
  let action = 'Tap 🔁 or Retry to try again.'
  if (/insufficient_quota|quota.*exceed|usage.?limit/.test(text)) {
    label = 'OpenAI quota exhausted'
    action = 'Check quota/billing or wait for the usage limit to reset before retrying.'
  } else if (status === 429 || /rate.?limit|too many requests/.test(text)) {
    label = 'OpenAI rate-limited (429)'
    action = 'Wait a little, then tap 🔁 or Retry.'
  } else if (/server.?overload|at capacity|overloaded/.test(text)) {
    label = 'Model at capacity (server_overloaded)'
    action = 'Wait a little or select another model, then tap 🔁 or Retry.'
  } else if (status >= 500 && status < 600) {
    label = `OpenAI service error (${status})`
  } else if (status === 401 || status === 403) {
    label = `OpenAI authentication/access error (${status})`
    action = 'Check model access and authentication before retrying.'
  } else if (error instanceof ProviderFailure) {
    label = 'Turn failed'
  } else {
    return null
  }
  // Never publish raw provider payloads: they can contain request data or tokens.
  return `🛑 **${label}.** ${action}`
}
