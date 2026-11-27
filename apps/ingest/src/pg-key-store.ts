import { Pool } from "pg";
import type { ApiKeyStore, TenantInfo } from "./types";

export class PgApiKeyStore implements ApiKeyStore {
  constructor(private readonly pool: Pool) {}

  static fromUrl(databaseUrl: string, onError: (error: Error) => void): PgApiKeyStore {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", onError); // an idle client dying must not crash the process
    return new PgApiKeyStore(pool);
  }

  async findByHash(hash: string): Promise<TenantInfo | null> {
    const result = await this.pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
      [hash],
    );
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id } : null;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
