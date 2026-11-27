import type { RateLimiter } from "./types";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * One bucket per tenant. It holds up to `capacity` tokens (the burst) and refills at
 * `ratePerSec`. A request costs one token per event, so a tenant's sustained throughput is
 * capped without affecting any other tenant.
 */
export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(tenantId: string, cost: number): { allowed: boolean; retryAfterMs: number } {
    const now = this.now();
    const bucket = this.refill(tenantId, now);
    // A batch larger than the whole burst could never pass, so cap its cost at the capacity.
    const needed = Math.min(Math.max(cost, 1), this.capacity);
    if (bucket.tokens >= needed) {
      bucket.tokens -= needed;
      return { allowed: true, retryAfterMs: 0 };
    }
    const missing = needed - bucket.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((missing / this.ratePerSec) * 1000) };
  }

  private refill(tenantId: string, now: number): Bucket {
    let bucket = this.buckets.get(tenantId);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(tenantId, bucket);
    } else {
      const elapsedSec = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.ratePerSec);
      bucket.updatedAt = now;
    }
    if (++this.calls % 1000 === 0) this.prune(now);
    return bucket;
  }

  /** Forget tenants that have been idle (and so are full again) for 10 minutes. */
  private prune(now: number): void {
    for (const [id, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 600_000) this.buckets.delete(id);
    }
  }
}
