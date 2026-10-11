import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
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

  it('asks the production record (§24) about its composite keys at its own address, as the API answers them', async () => {
    apiMock.mockResolvedValueOnce({ existing: ['490226||113290'] })
    const found = await existingKeys('production-records', ['490226||113290', '490226||113291'])
    expect(apiMock.mock.calls).toHaveLength(1)
    expect(apiMock.mock.calls[0][0]).toBe('/production-records/existing-keys')
    expect([...found]).toEqual(['490226||113290'])
  })
})

describe('the production record (§24)', () => {
  beforeEach(() => apiMock.mockClear())

  it('removes every record with one request and refreshes what the import page says about it', async () => {
    const { clearProductionRecords } = await import('./mutations')
    const qc = new QueryClient()
    const invalidate = vi.fn().mockResolvedValue(undefined)
    qc.invalidateQueries = invalidate as unknown as QueryClient['invalidateQueries']
    apiMock.mockResolvedValueOnce({ removed: 42_143 })

    const result = await clearProductionRecords(qc)

    expect(result).toEqual({ removed: 42_143 })
    expect(apiMock.mock.calls).toEqual([['/production-records', { method: 'DELETE' }]])
    expect(invalidate.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey)).toEqual([['production-records']])
  })
})
