export type DeadlineResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'timed-out' }

/** Bound optional housekeeping without cancelling the underlying operation. */
export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<DeadlineResult<T>>(resolve => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([
      promise.then(value => ({ status: 'fulfilled', value }) as const),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
