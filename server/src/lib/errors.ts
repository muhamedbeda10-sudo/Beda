// ============================================================================
// Errors the API raises deliberately. Anything else is a bug and becomes a 500
// with its details kept in the server log, never sent to the browser.
// ============================================================================

import type { ApiErrorCode } from '@qc/shared/api'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'validation', message, details)
export const unauthenticated = (message = 'Sign in to continue.') => new HttpError(401, 'unauthenticated', message)
export const forbidden = (message = 'Your role cannot do that.') => new HttpError(403, 'forbidden', message)
export const notFound = (what = 'That record') => new HttpError(404, 'not_found', `${what} was not found.`)
export const duplicate = (message: string) => new HttpError(409, 'duplicate', message)

/** Raised when someone else changed the record since it was loaded (§9.4). */
export class ConflictError extends HttpError {
  constructor(current: object) {
    super(
      409,
      'conflict',
      'Someone else changed this record while you were editing it. Review their values before saving again.',
      current,
    )
    this.name = 'ConflictError'
  }
}
