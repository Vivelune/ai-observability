// Applies every file in apps/ingest/sql in name order. The SQL is idempotent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = fileURLToPath(new URL("../sql/", import.meta.url));
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL || "postgres://aiobs:aiobs_dev@localhost:5432/aiobs",
});

await client.connect();
try {
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await client.query(readFileSync(join(dir, file), "utf8"));
    console.log("applied", file);
  }
} finally {
  await client.end();
}
