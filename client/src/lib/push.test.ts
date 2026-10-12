import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askOnFirstTap, keyBytes, pushState, pushSupported, shouldAskOnTap } from './push'

/** A store like localStorage / sessionStorage. */
const store = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

/** A browser with push, its listeners kept so a test can tap. */
function browser(permission: NotificationPermission, answer: NotificationPermission = 'default') {
  const listeners = new Map<string, Set<(e: Event) => void>>()
  const requestPermission = vi.fn(async () => answer)
  vi.stubGlobal('Notification', { permission, requestPermission })
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome', platform: 'Linux', maxTouchPoints: 0, serviceWorker: {} })
  vi.stubGlobal('window', { PushManager: {}, Notification: {}, matchMedia: () => ({ matches: false }), dispatchEvent: vi.fn() })
  vi.stubGlobal('localStorage', store())
  vi.stubGlobal('sessionStorage', store())
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('document', {
    addEventListener: (t: string, f: (e: Event) => void) => listeners.set(t, (listeners.get(t) ?? new Set()).add(f)),
    removeEventListener: (t: string, f: (e: Event) => void) => listeners.get(t)?.delete(f),
  })
  const fire = (type: string, target: unknown = {}) => [...(listeners.get(type) ?? [])].forEach((f) => f({ type, target } as unknown as Event))
  const listening = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
  return { requestPermission, fire, listening }
}

describe('§24 push on this device', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the server’s key as the browser takes it', () => {
    // "AQID" is base64url for the bytes 1, 2, 3; padding and the url-safe letters are handled.
    expect([...keyBytes('AQID')]).toEqual([1, 2, 3])
    expect([...keyBytes('-_8')]).toEqual([251, 255])
  })

  it('says an iPhone in the browser must add the app to the Home Screen first', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 })
    expect(pushSupported()).toBe(false)
    expect(await pushState('u1')).toBe('install-first')
  })

  it('says a browser without push cannot', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux', maxTouchPoints: 0 })
    expect(await pushState('u1')).toBe('unsupported')
  })
})

describe('§24 the browser asks at the first tap', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('asks once, at the first tap anywhere, then stops listening', () => {
    const b = browser('default')
    expect(shouldAskOnTap('u1')).toBe(true)
    askOnFirstTap('u1')
    expect(b.listening()).toBe(2)
    expect(b.requestPermission).not.toHaveBeenCalled()
    b.fire('click')
    expect(b.requestPermission).toHaveBeenCalledTimes(1)
    expect(b.listening()).toBe(0)
    b.fire('click')
    expect(b.requestPermission).toHaveBeenCalledTimes(1)
    // Dismissed: not asked again until the app opens anew.
    expect(shouldAskOnTap('u1')).toBe(false)
  })

  it('does not interrupt typing in a field; the next tap asks', () => {
    const b = browser('default')
    askOnFirstTap('u1')
    const field = Object.assign(new (globalThis.HTMLElement as unknown as new () => object)(), { closest: () => ({}) })
    b.fire('keydown', field)
    expect(b.requestPermission).not.toHaveBeenCalled()
    b.fire('click')
    expect(b.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('never asks when already answered, or when the person turned them off here', () => {
    for (const p of ['granted', 'denied'] as const) {
      const b = browser(p)
      expect(shouldAskOnTap('u1')).toBe(false)
      askOnFirstTap('u1')
      expect(b.listening()).toBe(0)
    }
    browser('default')
    localStorage.setItem('qc-push:u1', 'off')
    expect(shouldAskOnTap('u1')).toBe(false)
    // Another person on the same device is asked.
    expect(shouldAskOnTap('u2')).toBe(true)
  })
})
