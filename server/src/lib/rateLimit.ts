// ============================================================================
// A small fixed-window limiter for the sign-in endpoint. In-memory is the
// right scope: a single App Service instance sees all of a device's attempts,
// and the goal is to slow password guessing, not to meter traffic.
// ============================================================================

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns seconds to wait when the key is over the limit, else 0. */
  hit(key: string, now = Date.now()): number {
    this.sweep(now)
    const b = this.buckets.get(key)
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return 0
    }
    b.count += 1
    return b.count > this.max ? Math.ceil((b.resetAt - now) / 1000) : 0
  }

  reset(key: string): void {
    this.buckets.delete(key)
  }

  private sweep(now: number): void {
    if (this.buckets.size < 5000) return
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k)
  }
}
