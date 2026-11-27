import type { ApiKeyStore, TenantInfo } from "./types";

interface Entry {
  value: TenantInfo | null;
  expiresAt: number;
}

/**
 * Keeps key lookups off the database hot path. Valid keys are cached for ttlMs, unknown keys for
 * a short time so a flood of bad keys cannot hammer Postgres. The price is that a revoked key
 * can keep working for up to ttlMs.
 */
export class CachedApiKeyStore implements ApiKeyStore {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly inner: ApiKeyStore,
    private readonly ttlMs: number,
    private readonly negativeTtlMs: number = 10_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = 10_000,
  ) {}

  async findByHash(hash: string): Promise<TenantInfo | null> {
    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const value = await this.inner.findByHash(hash); // errors are not cached
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hash, {
      value,
      expiresAt: this.now() + (value ? this.ttlMs : this.negativeTtlMs),
    });
    return value;
  }

  ping(): Promise<boolean> {
    return this.inner.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.inner.close?.();
  }
}
