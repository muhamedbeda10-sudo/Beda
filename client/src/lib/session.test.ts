import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserProfile } from '@qc/shared/types'
import { getAccessToken, setAccessToken, setSignedInUser } from './api'
import { endSessionOnDevice, rememberProfile, rememberedProfile, resumeSession } from './session'

const amal: UserProfile = { id: 'u-amal', username: 'amal', name: 'Amal', role: 'inspector', isActive: true, permissions: ['view-inspections'], adminPlus: false }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function store() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

/** A device: its cookies (the session marker or not), its storage, and a server answering /auth/refresh and /auth/me. */
function device({ marker, refresh, me }: { marker: boolean; refresh?: () => Response | Promise<Response>; me?: () => Response | Promise<Response> }) {
  vi.stubGlobal('document', { cookie: marker ? 'qc_session=1' : '' })
  vi.stubGlobal('localStorage', store())
  vi.stubGlobal('navigator', {})
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/refresh' && refresh) return refresh()
    if (url === '/api/auth/me' && me) return me()
    throw new Error(`unexpected ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const offline = () => Promise.reject(new TypeError('Failed to fetch'))

beforeEach(() => setAccessToken(null))
afterEach(() => {
  vi.unstubAllGlobals()
  setAccessToken(null)
  setSignedInUser(null)
})

describe('opening the app', () => {
  it('signs in from the refresh cookie, and remembers who for opening offline later', async () => {
    device({ marker: true, refresh: () => json(200, { accessToken: 't1', user: amal }), me: () => json(200, amal) })
    expect(await resumeSession()).toEqual({ profile: amal, unreachable: false })
    expect(rememberedProfile()).toEqual(amal)
  })

  it('opens as the person last signed in here when the server cannot be reached, not on the sign-in screen', async () => {
    for (const refresh of [offline, () => json(503, {})]) {
      device({ marker: true, refresh })
      rememberProfile(amal)
      expect(await resumeSession()).toEqual({ profile: amal, unreachable: true })
      expect(getAccessToken()).toBeNull()
      // Kept for the next time.
      expect(rememberedProfile()).toEqual(amal)
    }
  })

  it('says the server could not be reached when nobody is remembered, so the sign-in screen can say why', async () => {
    device({ marker: true, refresh: offline })
    expect(await resumeSession()).toEqual({ profile: null, unreachable: true })
  })

  it('opens as the remembered person when /auth/me cannot be reached after the refresh', async () => {
    device({ marker: true, refresh: () => json(200, { accessToken: 't1', user: amal }), me: offline })
    rememberProfile(amal)
    expect(await resumeSession()).toEqual({ profile: amal, unreachable: true })
  })

  it('signs out, and forgets the person, when the server refuses the session or there is none', async () => {
    device({ marker: true, refresh: () => json(401, { error: { code: 'unauthenticated', message: 'Expired.' } }) })
    rememberProfile(amal)
    expect(await resumeSession()).toEqual({ profile: null, unreachable: false })
    expect(rememberedProfile()).toBeNull()

    const fetchMock = device({ marker: false })
    rememberProfile(amal)
    expect(await resumeSession()).toEqual({ profile: null, unreachable: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rememberedProfile()).toBeNull()
  })
})

describe('the session ending on this device', () => {
  it('lets go of the token, the remembered person, the push subscription and the cached photos', async () => {
    const unsubscribe = vi.fn(async () => true)
    const deleted: string[] = []
    vi.stubGlobal('localStorage', store())
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('window', { PushManager: {}, Notification: {}, dispatchEvent: vi.fn() })
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }) } })
    vi.stubGlobal('caches', { delete: async (name: string) => deleted.push(name) > 0 })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    rememberProfile(amal)
    setAccessToken('t1')

    endSessionOnDevice()
    await new Promise((r) => setTimeout(r, 0))

    expect(getAccessToken()).toBeNull()
    expect(rememberedProfile()).toBeNull()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(deleted).toEqual(['qc-media-v1'])
    // The session is gone: the server is not asked anything with it.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
