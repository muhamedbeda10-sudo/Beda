import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEPTH_KEY, readDepth, writeDepth } from './depth'

function stubStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
  return stored
}

afterEach(() => vi.unstubAllGlobals())

describe('§20 the depth picked, remembered on this device', () => {
  it('starts at Standard, and remembers Quick', () => {
    const stored = stubStorage()
    expect(readDepth()).toBe('standard')
    writeDepth('quick')
    expect(readDepth()).toBe('quick')
    writeDepth('standard')
    expect(stored.has(DEPTH_KEY)).toBe(false)
  })

  it('never remembers Deep: opened again, the page starts from the last Quick or Standard', () => {
    stubStorage()
    writeDepth('quick')
    writeDepth('deep')
    expect(readDepth()).toBe('quick')
    // Stored by an earlier version, or by hand: not taken either.
    stubStorage({ [DEPTH_KEY]: 'deep' })
    expect(readDepth()).toBe('standard')
  })

  it('takes anything else stored as Standard, and blocked storage as Standard too', () => {
    stubStorage({ [DEPTH_KEY]: 'max' })
    expect(readDepth()).toBe('standard')
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(readDepth()).toBe('standard')
    expect(() => writeDepth('quick')).not.toThrow()
  })
})
