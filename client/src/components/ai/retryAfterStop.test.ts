import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { pause, retryAfterStop } from './retryAfterStop'

const stillAnswering = () => new ApiError(409, 'conflict', 'Still answering the previous question. Wait for it, or stop it.')

describe('a question asked just after a stop', () => {
  afterEach(() => vi.useRealTimers())

  it('is sent again, after a pause, while the stop winds down', async () => {
    vi.useFakeTimers()
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValueOnce(stillAnswering()).mockRejectedValueOnce(stillAnswering()).mockResolvedValue('stream')
    const done = retryAfterStop(attempt, () => true, new AbortController().signal, 1500)
    await vi.advanceTimersByTimeAsync(1499)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(done).resolves.toBe('stream')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('gives the refusal back once the stop is no longer recent, and any other refusal at once', async () => {
    const refused = stillAnswering()
    await expect(retryAfterStop(() => Promise.reject(refused), () => false, new AbortController().signal, 0)).rejects.toBe(refused)
    const cap = new ApiError(402, 'ai_budget_reached', 'The monthly cap is reached.')
    const attempt = vi.fn(() => Promise.reject(cap))
    await expect(retryAfterStop(attempt, () => true, new AbortController().signal, 0)).rejects.toBe(cap)
    expect(attempt).toHaveBeenCalledTimes(1)
    const lost = new ApiError(0, 'internal', 'Network error — check your connection.')
    await expect(retryAfterStop(() => Promise.reject(lost), () => true, new AbortController().signal, 0)).rejects.toBe(lost)
  })

  it('stops waiting the moment Stop is pressed', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const attempt = vi.fn(() => Promise.reject(stillAnswering()))
    const done = retryAfterStop(attempt, () => true, ac.signal, 1500)
    const failed = expect(done).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(500)
    ac.abort()
    await failed
    await vi.advanceTimersByTimeAsync(5000)
    expect(attempt).toHaveBeenCalledTimes(1)
    // Already stopped: no wait at all.
    await expect(pause(1000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
