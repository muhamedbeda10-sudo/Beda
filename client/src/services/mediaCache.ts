// ============================================================================
// On-device cache for photo and document bytes.
//
// A stored photo or PDF never changes — the API keys it by its SHA-256 and
// serves it as immutable — so once a device has fetched it there is no reason
// to fetch it again. Browsers do not reliably keep authenticated fetches in
// their HTTP cache (Safari in particular), so the bytes are kept explicitly in
// Cache Storage, which survives reloads and app restarts and is private to
// this origin. On a plan with a daily outbound-data quota this is what keeps
// a busy History page from spending it.
//
// The cache is bounded: when it grows past MAX_ENTRIES the oldest entries go.
// Where Cache Storage is unavailable (private browsing, an insecure origin)
// every call simply fetches.
// ============================================================================

export const MEDIA_CACHE_NAME = 'qc-media-v1'
/** Photos are ~200–400 KB after on-device compression, documents a few MB. */
export const MAX_ENTRIES = 400
/** How many puts between prunes — pruning walks every entry's headers. */
const PRUNE_EVERY = 25
const STORED_AT = 'x-qc-cached-at'

let putsSincePrune = 0

/** Cache Storage, or null where the browser does not offer it here. */
function storage(): CacheStorage | null {
  try {
    return typeof caches !== 'undefined' && caches ? caches : null
  } catch {
    return null
  }
}

/** The cache key: an absolute URL under this origin, so entries never collide with anything else. */
function keyFor(path: string): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost'
  return `${origin}/__media${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * The bytes at `path`: from the device when they are here, otherwise through
 * `fetcher` (which carries the sign-in) and then kept for next time. A fetch
 * that fails is not cached, so a missing or forbidden file is asked for again.
 */
export async function cachedBlob(path: string, fetcher: () => Promise<Blob>): Promise<Blob> {
  const store = storage()
  const key = keyFor(path)
  if (store) {
    try {
      const cache = await store.open(MEDIA_CACHE_NAME)
      const hit = await cache.match(key)
      if (hit) return await hit.blob()
    } catch {
      // A broken cache must never break the page; fall through to the network.
    }
  }
  const blob = await fetcher()
  if (store && blob.size > 0) {
    void remember(store, key, blob)
  }
  return blob
}

async function remember(store: CacheStorage, key: string, blob: Blob): Promise<void> {
  try {
    const cache = await store.open(MEDIA_CACHE_NAME)
    await cache.put(
      key,
      new Response(blob, {
        headers: { 'content-type': blob.type || 'application/octet-stream', 'content-length': String(blob.size), [STORED_AT]: String(Date.now()) },
      }),
    )
    if (++putsSincePrune >= PRUNE_EVERY) {
      putsSincePrune = 0
      await prune(cache)
    }
  } catch {
    // Quota exceeded or storage disabled: the bytes were still delivered.
  }
}

/** Drop the oldest entries until the cache is back under MAX_ENTRIES. */
export async function prune(cache: Cache, max = MAX_ENTRIES): Promise<number> {
  const keys = await cache.keys()
  if (keys.length <= max) return 0
  const dated = await Promise.all(
    keys.map(async (req) => {
      const res = await cache.match(req)
      const at = Number(res?.headers.get(STORED_AT) ?? 0)
      return { req, at }
    }),
  )
  dated.sort((a, b) => a.at - b.at)
  const doomed = dated.slice(0, keys.length - max)
  await Promise.all(doomed.map((d) => cache.delete(d.req)))
  return doomed.length
}

/** Forget every cached photo and document on this device. */
export async function clearMediaCache(): Promise<void> {
  const store = storage()
  if (!store) return
  try {
    await store.delete(MEDIA_CACHE_NAME)
  } catch {
    // Nothing to do: the cache is best-effort.
  }
}
