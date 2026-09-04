import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EXISTING_KEYS_MAX } from '@qc/shared/api'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: apiMock }))

const { existingKeys } = await import('./mutations')

describe('existingKeys', () => {
  beforeEach(() => apiMock.mockClear())

  it('asks the API in slices no larger than it accepts and merges the answers', async () => {
    const keys = Array.from({ length: EXISTING_KEYS_MAX * 2 + 7 }, (_, i) => `C${i}`)
    // Pretend every 1000th coil already exists. (vitest also probes the mocked
    // export with argument-less calls that are not recorded, hence the guard.)
    apiMock.mockImplementation(async (_path?: string, init?: { body: { keys: string[] } }) => ({
      existing: (init?.body.keys ?? []).filter((k) => Number(k.slice(1)) % 1000 === 0).map((k) => k.toLowerCase()),
    }))

    const found = await existingKeys('coils', keys)

    expect(apiMock.mock.calls).toHaveLength(3)
    const sizes = apiMock.mock.calls.map(([, init]) => (init as { body: { keys: string[] } }).body.keys.length)
    expect(sizes).toEqual([EXISTING_KEYS_MAX, EXISTING_KEYS_MAX, 7])
    for (const [path] of apiMock.mock.calls) expect(path).toBe('/coils/existing-keys')
    expect([...found].sort()).toEqual(['c0', 'c1000', 'c10000', 'c2000', 'c3000', 'c4000', 'c5000', 'c6000', 'c7000', 'c8000', 'c9000'])
  })

  it('makes no request when the file has no keys', async () => {
    expect((await existingKeys('orders', [])).size).toBe(0)
    expect(apiMock.mock.calls).toHaveLength(0)
  })
})
