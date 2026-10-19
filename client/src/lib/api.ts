// ============================================================================
// HTTP client for the QC API.
//
// The access token lives in memory only (never localStorage — an XSS could
// read it there). When it expires the client asks /api/auth/refresh, which is
// authenticated by the httpOnly refresh cookie, and retries the request once.
// Concurrent 401s share one refresh, so ten parallel queries after a long idle
// do not trigger ten refreshes — and so do the app's other tabs: the refresh
// cookie is rotated on every use, so two tabs presenting the same one at once
// would have the second refused and its person signed out. A lock held across
// the tabs (navigator.locks) lets one refresh at a time, and the tab that
// refreshed hands the new token to the others over a BroadcastChannel (in
// memory, never stored), so a tab that waited uses it instead of rotating
// again. Where the browser has no locks, the in-tab sharing is what remains.
//
// A refresh ends one of three ways, and only one of them signs anybody out:
// the server refused the session (401/403) — signed out; the server could not
// be reached (no network, a 5xx) — the request fails as a network error and
// the session is kept for when it is back; or it answered for a different
// person than the one this tab is signed in as (someone else signed in from
// another tab of a shared tablet) — this tab must not act for them, so the
// app starts over.
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

/** How asking for a new access token ended: see the head of this file. */
export type RefreshResult = 'ok' | 'rejected' | 'unreachable' | 'other-user'

let accessToken: string | null = null
let refreshing: Promise<RefreshResult> | null = null
let onSessionLost: (() => void) | null = null
let onSessionChanged: (() => void) | null = null
let onProfile: ((user: AuthResponse['user']) => void) | null = null
/** The person this tab is signed in as: a token for anyone else is never used here. */
let signedInAs: string | null = null

/** Held by the tab that is refreshing; the others wait for it. */
export const REFRESH_LOCK = 'qc-refresh'
/** Carries a fresh token from the tab that refreshed to the others. */
const AUTH_CHANNEL = 'qc-auth'
/** A lock not granted in this long (a frozen tab holding it) is done without. */
const LOCK_WAIT_MS = 10_000

/** §14 — told the account as each refresh returns it: a change to the person's permissions reaches the app within one token's life. */
export function setProfileHandler(handler: ((user: AuthResponse['user']) => void) | null): void {
  onProfile = handler
}

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** Called once when a refresh is refused — the auth context signs the user out. */
export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler
}

/** Called when the session on this device turned out to be another person's — the auth context starts the app over. */
export function setSessionChangedHandler(handler: (() => void) | null): void {
  onSessionChanged = handler
}

/** Who this tab is signed in as (null when signed out): set by the auth context as the profile changes. */
export function setSignedInUser(userId: string | null): void {
  signedInAs = userId
  if (userId) authChannel()
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

/**
 * Forgets the marker on this device (signing out). The API clears it when it
 * hears of the sign-out; signed out with no network, it would not, and the app
 * opened next would resume the session of the person who just signed out.
 */
export function clearSessionMarker(): void {
  try {
    document.cookie = 'qc_session=; Max-Age=0; path=/'
  } catch {
    /* no cookies here: there was no marker either */
  }
}

// ---- Tokens between tabs ---------------------------------------------------

interface TokenMessage {
  type: 'token'
  accessToken: string
  userId: string
}

let channel: BroadcastChannel | null = null

function authChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel
  try {
    const opened = new BroadcastChannel(AUTH_CHANNEL)
    opened.onmessage = (e: MessageEvent<TokenMessage>) => takeFromOtherTab(e.data)
    // Never what keeps a process alive (Node, where the tests run, has the channel too).
    ;(opened as unknown as { unref?: () => void }).unref?.()
    channel = opened
  } catch {
    channel = null
  }
  return channel
}

/** A token another tab got: used here when it is this tab's person's; someone else's means this tab's session is over. */
export function takeFromOtherTab(msg: TokenMessage | null | undefined): void {
  if (msg?.type !== 'token' || !signedInAs) return
  if (msg.userId === signedInAs) accessToken = msg.accessToken
  else onSessionChanged?.()
}

/** Tells the app's other tabs the token this one now holds, and whose it is (after a refresh, or on signing in). */
export function shareToken(token: string, userId: string): void {
  try {
    authChannel()?.postMessage({ type: 'token', accessToken: token, userId } satisfies TokenMessage)
  } catch {
    /* the other tabs refresh for themselves */
  }
}

// ---- Refreshing ------------------------------------------------------------

/**
 * Ask the API for a new access token using the refresh cookie — one tab at a
 * time. A tab that waited for another's refresh and was handed its token
 * meanwhile uses that one and does not refresh again.
 */
export async function refreshAccessToken(): Promise<RefreshResult> {
  if (!refreshing) {
    const held = accessToken
    refreshing = acrossTabs(() => (accessToken !== null && accessToken !== held ? Promise.resolve<RefreshResult>('ok') : askForToken())).finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

/** The work under the lock the app's tabs share; where the browser has none, or it is not granted in time, without it. */
async function acrossTabs<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined
  if (!locks?.request) return work()
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(LOCK_WAIT_MS) : undefined
  try {
    return await locks.request(REFRESH_LOCK, signal ? { signal } : {}, work)
  } catch (e) {
    // Waited too long: a tab holding the lock is frozen in the background. Refresh without it rather than hang.
    const name = (e as Error | null)?.name
    if (name === 'AbortError' || name === 'TimeoutError') return work()
    throw e
  }
}

async function askForToken(): Promise<RefreshResult> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' })
  } catch {
    return 'unreachable'
  }
  if (res.status === 401 || res.status === 403) return 'rejected'
  if (!res.ok) return 'unreachable'
  let body: AuthResponse
  try {
    body = (await res.json()) as AuthResponse
  } catch {
    return 'unreachable'
  }
  if (signedInAs && body.user && body.user.id !== signedInAs) {
    // The cookie is someone else's now: their token is never used for what this tab's person is doing.
    accessToken = null
    onSessionChanged?.()
    return 'other-user'
  }
  accessToken = body.accessToken
  if (body.user) {
    shareToken(body.accessToken, body.user.id)
    onProfile?.(body.user)
  }
  return 'ok'
}

const networkError = () => new ApiError(0, 'internal', 'Network error — check your connection.')

/**
 * After a 401: true with a new token to send again with; false when the
 * session is over (the person is signed out, and the 401 stands). A server
 * that could not be asked is a network error, the session kept; a session
 * that is now another person's is refused outright.
 */
async function renewed(): Promise<boolean> {
  const result = await refreshAccessToken()
  if (result === 'ok') return true
  if (result === 'rejected') {
    onSessionLost?.()
    return false
  }
  if (result === 'other-user') throw new ApiError(401, 'unauthenticated', 'Someone else signed in on this device. The app is starting over.')
  throw networkError()
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
  /**
   * Send the JSON body gzipped (a batch of an ERP export: its repeated column
   * names shrink it about tenfold, so a slow factory line uploads it in a
   * fraction of the time). The server inflates it; a browser without
   * CompressionStream sends it as it is.
   */
  gzip?: boolean
}

/** Text gzipped by the browser, or null where it cannot. */
async function gzipped(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined') return null
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).blob()
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {}
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    const json = JSON.stringify(opts.body)
    const packed = opts.gzip ? await gzipped(json) : null
    if (packed) {
      headers['content-encoding'] = 'gzip'
      body = packed
    } else {
      body = json
    }
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
  let res = await attempt(path, opts)
  if (res.status === 401 && !opts.noRetry && (await renewed())) res = await attempt(path, opts)
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
  let res = await attempt(path, request)
  if (res.status === 401 && !opts.noRetry && (await renewed())) res = await attempt(path, request)
  if (!res.ok) throw await parseError(res)
  if (!res.body) throw new ApiError(0, 'internal', 'This browser cannot read a streamed answer.')
  return res.body
}

/** Binary GET (image bytes). Same refresh behaviour as `api`. */
export async function apiBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  let res = await attempt(path, { signal })
  if (res.status === 401 && (await renewed())) res = await attempt(path, { signal })
  if (!res.ok) throw await parseError(res)
  return res.blob()
}

/** The request sent; a dead network as an ApiError, an abort as it is. */
async function attempt(path: string, opts: RequestOptions): Promise<Response> {
  try {
    return await send(path, opts)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw networkError()
  }
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
