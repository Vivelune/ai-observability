// Creates a tenant (if needed) and a new API key for it. The key is printed once and only its
// hash is stored.   Usage: pnpm --filter @ai-observability/ingest db:create-key <tenant name>
import pg from "pg";
import keys from "../dist/keys.js";

const { generateApiKey, hashApiKey, keyPrefix } = keys;
const tenantName = process.argv[2];
if (!tenantName) {
  console.error("Usage: pnpm --filter @ai-observability/ingest db:create-key <tenant name>");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL || "postgres://aiobs:aiobs_dev@localhost:5432/aiobs",
});

await client.connect();
try {
  const tenant = await client.query(
    `INSERT INTO tenants (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tenantName],
  );
  const tenantId = tenant.rows[0].id;
  const key = generateApiKey();
  await client.query("INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3)", [
    tenantId,
    hashApiKey(key),
    keyPrefix(key),
  ]);
  console.log(`tenant: ${tenantName} (${tenantId})`);
  console.log(`api key: ${key}`);
  console.log("Save this key now. It is not stored and cannot be shown again.");
} finally {
  await client.end();
}
