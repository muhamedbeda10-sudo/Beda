import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEDIA_CACHE_NAME, cachedBlob, clearMediaCache, prune } from './mediaCache'

/** A small in-memory Cache Storage, enough to exercise the cache's behaviour. */
class FakeCache {
  entries = new Map<string, Response>()
  async match(key: RequestInfo | URL) {
    return this.entries.get(String(key))?.clone() ?? undefined
  }
  async put(key: RequestInfo | URL, res: Response) {
    this.entries.set(String(key), res)
  }
  async keys() {
    return Array.from(this.entries.keys()).map((k) => new Request(k))
  }
  async delete(key: RequestInfo | URL) {
    const k = key instanceof Request ? key.url : String(key)
    return this.entries.delete(k)
  }
}
class FakeStorage {
  caches = new Map<string, FakeCache>()
  async open(name: string) {
    let c = this.caches.get(name)
    if (!c) this.caches.set(name, (c = new FakeCache()))
    return c as unknown as Cache
  }
  async delete(name: string) {
    return this.caches.delete(name)
  }
}

let storage: FakeStorage
beforeEach(() => {
  storage = new FakeStorage()
  vi.stubGlobal('caches', storage)
})
afterEach(() => vi.unstubAllGlobals())

describe('the media cache', () => {
  it('fetches once and answers from the device afterwards', async () => {
    const fetcher = vi.fn(async () => new Blob(['photo-bytes'], { type: 'image/jpeg' }))
    const first = await cachedBlob('/images/abc/content', fetcher)
    expect(await first.text()).toBe('photo-bytes')
    // The put is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 0))
    const second = await cachedBlob('/images/abc/content', fetcher)
    expect(await second.text()).toBe('photo-bytes')
    expect(second.type).toBe('image/jpeg')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not keep a failed fetch, so the file is asked for again', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('403')
    })
    await expect(cachedBlob('/images/nope/content', fetcher)).rejects.toThrow('403')
    await expect(cachedBlob('/images/nope/content', fetcher)).rejects.toThrow('403')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('still delivers the bytes where Cache Storage is missing', async () => {
    vi.stubGlobal('caches', undefined)
    const fetcher = vi.fn(async () => new Blob(['x']))
    expect(await (await cachedBlob('/images/a/content', fetcher)).text()).toBe('x')
    expect(await (await cachedBlob('/images/a/content', fetcher)).text()).toBe('x')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('prunes the oldest entries past the cap', async () => {
    const cache = await storage.open(MEDIA_CACHE_NAME)
    for (let i = 0; i < 6; i++) {
      await cache.put(`http://x/${i}`, new Response('b', { headers: { 'x-qc-cached-at': String(1000 + i) } }))
    }
    expect(await prune(cache, 4)).toBe(2)
    const left = (await cache.keys()).map((k) => k.url).sort()
    expect(left).toEqual(['http://x/2', 'http://x/3', 'http://x/4', 'http://x/5'])
  })

  it('can be emptied', async () => {
    await cachedBlob('/images/abc/content', async () => new Blob(['z']))
    await new Promise((r) => setTimeout(r, 0))
    await clearMediaCache()
    expect(storage.caches.has(MEDIA_CACHE_NAME)).toBe(false)
  })
})
