import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyBytes, pushState, pushSupported } from './push'

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
