// Sends docs/examples/01-rag-trace.json to the ingest API with the given key.
// Usage: node apps/ingest/scripts/send-sample.mjs <api key>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const key = process.argv[2] || "";
const endpoint = process.env.ENDPOINT || "http://localhost:3001";
const file = fileURLToPath(new URL("../../../docs/examples/01-rag-trace.json", import.meta.url));

const response = await fetch(`${endpoint}/v1/events`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: readFileSync(file, "utf8"),
});
console.log("status:", response.status);
console.log(await response.text());
