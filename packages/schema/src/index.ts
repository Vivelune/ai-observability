import { z } from "zod";

export const SCHEMA_VERSION = "0.1" as const;

export const SpanKind = z.enum(["llm", "retrieval", "tool", "chain", "other"]);

// tenant_id is NOT in the event: the API derives it from the API key.
export const SpanEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().optional(),
  name: z.string().min(1),
  kind: SpanKind.default("other"),
  status: z.enum(["ok", "error"]).default("ok"),
  startTime: z.string().datetime(), // ISO 8601 UTC
  durationMs: z.number().int().nonnegative(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  prompt: z.string().optional(),
  completion: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const IngestBatchSchema = z.object({
  events: z.array(SpanEventSchema).min(1).max(500),
});

export type SpanEvent = z.infer<typeof SpanEventSchema>;
export type IngestBatch = z.infer<typeof IngestBatchSchema>;
