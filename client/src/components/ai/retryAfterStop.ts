// ============================================================================
// §20 — a question asked just after a stop. Stop asks the server to end the
// answer at its next step — stopped while a query runs, only when that query
// ends (its time limit is 10 seconds) — and a question sent to the same
// conversation before then is refused as "still answering", though this side
// may already show that answer as stopped, or the conversation as free (a
// copy of it fetched a moment before). For a while after a stop, such a
// refusal is sent again after a pause, with Stop on offer meanwhile.
// ============================================================================

import { ApiError } from '@/lib/api'

/** How long after a stop a "still answering" refusal is taken for that stop winding down. */
export const STOP_SETTLE_MS = 12_000
/** The pause before asking again. */
export const RETRY_AFTER_STOP_MS = 1_500

/** Waits, or rejects as a fetch would the moment the signal aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('The answer was stopped.', 'AbortError'))
    if (signal.aborted) return aborted()
    const onAbort = () => {
      clearTimeout(timer)
      aborted()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * `attempt`, made again after a pause for as long as it is refused as a
 * conflict (409) while `settling()` holds — a stop in this conversation is
 * recent. Anything else, and a refusal once the stop has settled, is thrown.
 */
export async function retryAfterStop<T>(attempt: () => Promise<T>, settling: () => boolean, signal: AbortSignal, waitMs = RETRY_AFTER_STOP_MS): Promise<T> {
  for (;;) {
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409 && err.code === 'conflict' && settling())) throw err
      await pause(waitMs, signal)
    }
  }
}
