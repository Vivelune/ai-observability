// Generates docs/sdk-contract.schema.json from the zod schema (for non-TypeScript emitters).
import { writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import schema from "../dist/index.js";

const { IngestBatchSchema, IngestResponseSchema, SCHEMA_VERSION } = schema;

const out = {
  title: `AI Observability SDK contract v${SCHEMA_VERSION}`,
  request: zodToJsonSchema(IngestBatchSchema, { name: "IngestBatch" }),
  response: zodToJsonSchema(IngestResponseSchema, { name: "IngestResponse" }),
};

const target = fileURLToPath(new URL("../../../docs/sdk-contract.schema.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
