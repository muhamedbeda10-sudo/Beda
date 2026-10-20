import { describe, expect, it } from 'vitest'
import { lookForNewerVersion } from './unknownRoute'

const registration = (found: 'installing' | 'waiting' | null, fails = false) => ({
  installing: null as unknown,
  waiting: null as unknown,
  async update() {
    if (fails) throw new Error('offline')
    if (found) this[found] = {}
  },
})

describe('an address this version does not know', () => {
  it('waits for a newer version when the update check finds one, installing or waiting', async () => {
    expect(await lookForNewerVersion(registration('installing'))).toBe('newer')
    expect(await lookForNewerVersion(registration('waiting'))).toBe('newer')
  })

  it('goes home when there is none, no service worker, or the check cannot be made', async () => {
    expect(await lookForNewerVersion(registration(null))).toBe('none')
    expect(await lookForNewerVersion(undefined)).toBe('none')
    expect(await lookForNewerVersion(registration('installing', true))).toBe('none')
  })
})
