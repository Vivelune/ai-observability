// Revokes keys by their visible prefix (the first 12 characters, for example aiobs_AbCd12).
// Usage: pnpm --filter @ai-observability/ingest db:revoke-key <key prefix>
import pg from "pg";

const prefix = process.argv[2];
if (!prefix) {
  console.error("Usage: pnpm --filter @ai-observability/ingest db:revoke-key <key prefix>");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL || "postgres://aiobs:aiobs_dev@localhost:5432/aiobs",
});

await client.connect();
try {
  const result = await client.query(
    "UPDATE api_keys SET revoked_at = now() WHERE key_prefix = $1 AND revoked_at IS NULL",
    [prefix],
  );
  console.log(
    `revoked ${result.rowCount} key(s). Servers pick this up within the cache TTL (60 s).`,
  );
} finally {
  await client.end();
}
