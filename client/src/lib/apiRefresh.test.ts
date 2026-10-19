import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  REFRESH_LOCK,
  api,
  getAccessToken,
  refreshAccessToken,
  setAccessToken,
  setSessionChangedHandler,
  setSessionLostHandler,
  setSignedInUser,
  takeFromOtherTab,
} from './api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const expired = () => json(401, { error: { code: 'unauthenticated', message: 'Expired.' } })
const user = (id: string) => ({ id, username: id, name: id, role: 'inspector', permissions: [] })

/** fetch answering /auth/refresh with `refresh` and anything else with `other`, one after another. */
function server(refresh: () => Response | Promise<Response>, ...others: Array<() => Response>) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url)
    if (url === '/api/auth/refresh') return refresh()
    const next = others.shift()
    return next ? next() : json(200, { ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  setAccessToken(null)
  setSignedInUser(null)
  setSessionLostHandler(null)
  setSessionChangedHandler(null)
})

describe('a refresh ends one of three ways, and only a refusal signs out', () => {
  it('signs out when the server refuses the session', async () => {
    const lost = vi.fn()
    setSessionLostHandler(lost)
    server(() => json(401, { error: { code: 'unauthenticated', message: 'Your session has expired.' } }), expired)
    setAccessToken('t1')
    await expect(api('/sessions')).rejects.toMatchObject({ status: 401 })
    expect(lost).toHaveBeenCalledOnce()
    server(() => json(403, {}))
    expect(await refreshAccessToken()).toBe('rejected')
  })

  it('keeps the session when the server cannot be reached — a network error, nobody signed out', async () => {
    const lost = vi.fn()
    setSessionLostHandler(lost)
    for (const refresh of [() => json(503, { error: { code: 'internal', message: 'Down.' } }), () => Promise.reject(new TypeError('Failed to fetch'))]) {
      server(refresh, expired)
      setAccessToken('t1')
      const err = await api('/sessions').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status: 0, message: 'Network error — check your connection.' })
      // The token is not thrown away: once the server answers again, the session goes on.
      expect(getAccessToken()).toBe('t1')
    }
    expect(lost).not.toHaveBeenCalled()
    server(() => json(502, {}))
    expect(await refreshAccessToken()).toBe('unreachable')
  })

  it('refreshes and sends again on success', async () => {
    const calls = server(() => json(200, { accessToken: 't2', user: user('u1') }), expired, () => json(200, { rows: [] }))
    setSignedInUser('u1')
    setAccessToken('t1')
    expect(await api('/sessions')).toEqual({ rows: [] })
    expect(calls).toEqual(['/api/sessions', '/api/auth/refresh', '/api/sessions'])
    expect(getAccessToken()).toBe('t2')
  })
})

describe('a session that turned out to be another person’s', () => {
  it('is never used: the request is not sent again, and the app is told to start over', async () => {
    const changed = vi.fn()
    const lost = vi.fn()
    setSessionChangedHandler(changed)
    setSessionLostHandler(lost)
    // Someone else signed in from another tab: the refresh cookie is theirs now.
    const calls = server(() => json(200, { accessToken: 't-omar', user: user('u-omar') }), expired)
    setSignedInUser('u-amal')
    setAccessToken('t-amal')
    await expect(api('/sessions/s1/samples', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401 })
    expect(calls).toEqual(['/api/sessions/s1/samples', '/api/auth/refresh'])
    expect(getAccessToken()).toBeNull()
    expect(changed).toHaveBeenCalledOnce()
    expect(lost).not.toHaveBeenCalled()
  })

  it('is noticed from another tab’s token too, and that tab’s token is taken when it is this person’s', () => {
    const changed = vi.fn()
    setSessionChangedHandler(changed)
    setSignedInUser('u-amal')
    setAccessToken('t-old')
    takeFromOtherTab({ type: 'token', accessToken: 't-new', userId: 'u-amal' })
    expect(getAccessToken()).toBe('t-new')
    expect(changed).not.toHaveBeenCalled()
    takeFromOtherTab({ type: 'token', accessToken: 't-omar', userId: 'u-omar' })
    expect(getAccessToken()).toBe('t-new')
    expect(changed).toHaveBeenCalledOnce()
  })
})

describe('one refresh at a time across the app’s tabs', () => {
  /** navigator.locks with the lock held by "another tab" until `release`. */
  function heldLock() {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const names: string[] = []
    const request = vi.fn(async (name: string, _opts: unknown, work: () => Promise<unknown>) => {
      names.push(name)
      await held
      return work()
    })
    vi.stubGlobal('navigator', { locks: { request } })
    return { release, names }
  }

  it('waits for the lock, and uses the token the other tab got meanwhile instead of rotating the cookie again', async () => {
    const lock = heldLock()
    const calls = server(() => json(200, { accessToken: 'never', user: user('u-amal') }))
    setSignedInUser('u-amal')
    setAccessToken('t-old')
    const result = refreshAccessToken()
    // The tab holding the lock refreshed and handed its token over.
    takeFromOtherTab({ type: 'token', accessToken: 't-from-other-tab', userId: 'u-amal' })
    lock.release()
    expect(await result).toBe('ok')
    expect(lock.names).toEqual([REFRESH_LOCK])
    expect(calls).toEqual([])
    expect(getAccessToken()).toBe('t-from-other-tab')
  })

  it('refreshes itself under the lock when no other tab did', async () => {
    const lock = heldLock()
    const calls = server(() => json(200, { accessToken: 't2', user: user('u-amal') }))
    setSignedInUser('u-amal')
    setAccessToken('t-old')
    const result = refreshAccessToken()
    lock.release()
    expect(await result).toBe('ok')
    expect(calls).toEqual(['/api/auth/refresh'])
  })

  it('shares one refresh among the requests of a tab where the browser has no locks', async () => {
    vi.stubGlobal('navigator', {})
    const calls = server(() => json(200, { accessToken: 't2' }))
    const all = await Promise.all([refreshAccessToken(), refreshAccessToken(), refreshAccessToken()])
    expect(all).toEqual(['ok', 'ok', 'ok'])
    expect(calls).toEqual(['/api/auth/refresh'])
  })
})
