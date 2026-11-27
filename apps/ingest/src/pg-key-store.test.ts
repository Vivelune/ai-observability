import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, keyPrefix } from "./keys";
import { PgApiKeyStore } from "./pg-key-store";

// Runs only when a real Postgres is available:  TEST_DATABASE_URL=postgres://... pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgApiKeyStore (real Postgres)", () => {
  const pool = new pg.Pool({ connectionString: url });
  const store = new PgApiKeyStore(pool);
  const tenantName = `test-${Date.now()}`;
  let tenantId = "";

  beforeAll(async () => {
    const sql = readFileSync(join(process.cwd(), "apps/ingest/sql/001_init.sql"), "utf8");
    await pool.query(sql);
    const tenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [
      tenantName,
    ]);
    tenantId = tenant.rows[0].id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM api_keys WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await pool.end();
  });

  it("finds a key by hash and never stores the key itself", async () => {
    const key = generateApiKey();
    await pool.query("INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1,$2,$3)", [
      tenantId,
      hashApiKey(key),
      keyPrefix(key),
    ]);
    expect(await store.findByHash(hashApiKey(key))).toEqual({ tenantId });
    expect(await store.findByHash(hashApiKey(generateApiKey()))).toBeNull();

    const stored = await pool.query("SELECT * FROM api_keys WHERE tenant_id = $1", [tenantId]);
    expect(JSON.stringify(stored.rows)).not.toContain(key);
  });

  it("stops returning a key once it is revoked", async () => {
    const key = generateApiKey();
    await pool.query("INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1,$2,$3)", [
      tenantId,
      hashApiKey(key),
      keyPrefix(key),
    ]);
    await pool.query("UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1", [
      hashApiKey(key),
    ]);
    expect(await store.findByHash(hashApiKey(key))).toBeNull();
  });

  it("pings", async () => {
    expect(await store.ping()).toBe(true);
  });
});
