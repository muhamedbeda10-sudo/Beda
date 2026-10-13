// ============================================================================
// HTTP client for the QC API.
//
// The access token lives in memory only (never localStorage — an XSS could
// read it there). When it expires the client asks /api/auth/refresh, which is
// authenticated by the httpOnly refresh cookie, and retries the request once.
// Concurrent 401s share one refresh, so ten parallel queries after a long idle
// do not trigger ten refreshes.
// ============================================================================

import type { ApiErrorBody, ApiErrorCode, AuthResponse } from '@qc/shared/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const API_BASE = '/api'

let accessToken: string | null = null
let refreshing: Promise<boolean> | null = null
let onSessionLost: (() => void) | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** Called once when a refresh fails — the auth context signs the user out. */
export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler
}

/** Whether the API left its session marker, i.e. a refresh cookie may exist.
 *  Saves a doomed /refresh call (and a 401 in the console) on a fresh browser. */
export function hasSessionMarker(): boolean {
  try {
    return document.cookie.split(';').some((c) => c.trim().startsWith('qc_session='))
  } catch {
    return true
  }
}

/** Ask the API for a new access token using the refresh cookie. */
export async function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' })
        if (!res.ok) return false
        const body = (await res.json()) as AuthResponse
        accessToken = body.accessToken
        return true
      } catch {
        return false
      } finally {
        refreshing = null
      }
    })()
  }
  return refreshing
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null
  try {
    body = (await res.json()) as ApiErrorBody
  } catch {
    /* not JSON */
  }
  const code = body?.error?.code ?? (res.status === 401 ? 'unauthenticated' : 'internal')
  const message = body?.error?.message ?? (res.status >= 500 ? 'The server had a problem. Nothing was saved.' : `Request failed (${res.status}).`)
  return new ApiError(res.status, code, message, body?.error?.details)
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Multipart body; takes precedence over `body`. */
  form?: FormData
  signal?: AbortSignal
  /** Skip the refresh-and-retry on 401 (used by the auth endpoints). */
  noRetry?: boolean
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {}
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  return fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: opts.signal,
    credentials: 'same-origin',
  })
}

/** JSON request. Throws ApiError on any non-2xx. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response
  try {
    res = await send(path, opts)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'internal', 'Network error — check your connection.')
  }
  if (res.status === 401 && !opts.noRetry) {
    const ok = await refreshAccessToken()
    if (ok) {
      res = await send(path, opts)
    } else {
      onSessionLost?.()
    }
  }
  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * POST whose answer is a stream of Server-Sent Events (§20, the AI assistant).
 * The same refresh-and-retry as `api`: a 401 comes from the middleware before
 * the route runs, so sending again is safe. A refusal (no key, the monthly
 * cap, a bad request) is an ordinary JSON error, thrown as ApiError before any
 * of the body is read; once the headers are OK the caller reads the stream.
 * Aborting `signal` closes the connection, which lets go of an answer the
 * server has begun rather than stopping it.
 */
export async function apiStream(path: string, opts: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
  const request: RequestOptions = { method: 'POST', ...opts }
  const attempt = async (): Promise<Response> => {
    try {
      return await send(path, request)
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      throw new ApiError(0, 'internal', 'Network error — check your connection.')
    }
  }
  let res = await attempt()
  if (res.status === 401 && !opts.noRetry) {
    const ok = await refreshAccessToken()
    if (ok) res = await attempt()
    else onSessionLost?.()
  }
  if (!res.ok) throw await parseError(res)
  if (!res.body) throw new ApiError(0, 'internal', 'This browser cannot read a streamed answer.')
  return res.body
}

/** Binary GET (image bytes). Same refresh behaviour as `api`. */
export async function apiBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  let res = await send(path, { signal })
  if (res.status === 401) {
    const ok = await refreshAccessToken()
    if (ok) res = await send(path, { signal })
    else onSessionLost?.()
  }
  if (!res.ok) throw await parseError(res)
  return res.blob()
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    u.set(k, String(v))
  }
  const s = u.toString()
  return s ? `?${s}` : ''
}
