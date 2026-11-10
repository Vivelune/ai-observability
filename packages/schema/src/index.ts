import { z } from "zod";

/** Contract version. MAJOR.MINOR. See docs/sdk-contract.md for evolution rules. */
export const SCHEMA_VERSION = "0.1" as const;
export const SUPPORTED_MAJOR = 0;

export const LIMITS = {
  maxBatchEvents: 500,
  maxBatchBytes: 5 * 1024 * 1024,
  maxIoBytes: 100 * 1024, // llm input/output are truncated beyond this
  maxMetadataBytes: 16 * 1024,
  maxNameLength: 256,
  maxTags: 20,
  maxTagLength: 64,
} as const;

/* ---------- size helpers ---------- */

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function truncateString(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // Decoding a cut multi-byte character yields U+FFFD at the end; drop it.
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD+$/, "");
}

/* ---------- primitives ---------- */

const uuid = z.string().uuid();
// ISO-8601, UTC only: must end in "Z" (e.g. 2026-11-10T09:15:00.000Z). Offsets are rejected.
const timestamp = z.string().datetime();
const name = z.string().min(1).max(LIMITS.maxNameLength);
const schemaVersion = z.string().regex(/^\d+\.\d+$/, "schema_version must look like MAJOR.MINOR");

const metadata = z
  .record(z.string(), z.unknown())
  .refine((value) => byteLength(JSON.stringify(value)) <= LIMITS.maxMetadataBytes, {
    message: `metadata must be at most ${LIMITS.maxMetadataBytes} bytes of JSON`,
  });

const tags = z.array(z.string().min(1).max(LIMITS.maxTagLength)).max(LIMITS.maxTags);

export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
});
export const IoSchema = z.union([z.string(), z.array(MessageSchema)]);

export type Message = z.infer<typeof MessageSchema>;
export type Io = z.infer<typeof IoSchema>;

/** Truncate an llm input/output to maxBytes. Over-limit message arrays become a truncated JSON string. */
export function truncateIo(
  value: Io,
  maxBytes: number = LIMITS.maxIoBytes,
): { value: Io; truncated: boolean } {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (byteLength(text) <= maxBytes) return { value, truncated: false };
  return { value: truncateString(text, maxBytes), truncated: true };
}

/* ---------- entities (the data inside an event) ---------- */

export const ErrorSchema = z.object({
  type: name,
  message: z.string(),
  stack: z.string().optional(),
});

export const LlmFieldsSchema = z.object({
  model: name,
  provider: name,
  input: IoSchema.optional(),
  output: IoSchema.optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  io_truncated: z.boolean().optional(),
});

export const TraceDataSchema = z.object({
  trace_id: uuid,
  name,
  start_time: timestamp,
  end_time: timestamp.optional(),
  user_id: z.string().min(1).max(LIMITS.maxNameLength).optional(),
  session_id: z.string().min(1).max(LIMITS.maxNameLength).optional(),
  metadata: metadata.optional(),
  tags: tags.optional(),
});

export const SpanTypeSchema = z.enum(["llm", "retrieval", "tool", "generic"]);
export const SpanStatusSchema = z.enum(["running", "ok", "error"]);

export const SpanDataSchema = z.object({
  span_id: uuid,
  trace_id: uuid,
  parent_span_id: uuid.optional(), // absent = root span of the trace
  type: SpanTypeSchema,
  name,
  start_time: timestamp,
  end_time: timestamp.optional(),
  status: SpanStatusSchema,
  error: ErrorSchema.optional(),
  llm: LlmFieldsSchema.optional(),
  metadata: metadata.optional(),
});

export const EvalResultDataSchema = z.object({
  eval_id: uuid,
  trace_id: uuid,
  span_id: uuid.optional(),
  name,
  score: z.number().min(0).max(1), // normalized: 0 = worst, 1 = best
  reasoning: z.string().optional(),
  judge_model: name.optional(),
});

/* ---------- event envelope ---------- */
// tenant_id is deliberately NOT part of the client schema. The server derives it from the
// API key and overwrites anything a client sends (unknown keys are stripped on parse).

const envelope = {
  schema_version: schemaVersion,
  event_id: uuid, // idempotency key
  sent_at: timestamp,
};

export const TraceEventSchema = z.object({
  ...envelope,
  event_type: z.literal("trace"),
  data: TraceDataSchema,
});
export const SpanEventSchema = z.object({
  ...envelope,
  event_type: z.literal("span"),
  data: SpanDataSchema,
});
export const EvalResultEventSchema = z.object({
  ...envelope,
  event_type: z.literal("eval_result"),
  data: EvalResultDataSchema,
});

const eventUnion = z.discriminatedUnion("event_type", [
  TraceEventSchema,
  SpanEventSchema,
  EvalResultEventSchema,
]);

export const EventSchema = eventUnion.superRefine((event, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  const endsBeforeStart = (start: string, end?: string) =>
    end !== undefined && Date.parse(end) < Date.parse(start);

  if (event.event_type === "trace") {
    if (endsBeforeStart(event.data.start_time, event.data.end_time)) {
      issue(["data", "end_time"], "end_time must not be before start_time");
    }
  }

  if (event.event_type === "span") {
    const span = event.data;
    if (endsBeforeStart(span.start_time, span.end_time)) {
      issue(["data", "end_time"], "end_time must not be before start_time");
    }
    if (span.status === "running" && span.end_time !== undefined) {
      issue(["data", "end_time"], 'a span with status "running" must not have end_time');
    }
    if (span.status !== "running" && span.end_time === undefined) {
      issue(["data", "end_time"], 'end_time is required unless status is "running"');
    }
    if (span.error !== undefined && span.status !== "error") {
      issue(["data", "error"], 'error is only allowed when status is "error"');
    }
    if (span.type === "llm" && span.llm === undefined) {
      issue(["data", "llm"], 'spans of type "llm" require the llm fields');
    }
    if (span.type !== "llm" && span.llm !== undefined) {
      issue(["data", "llm"], 'llm fields are only allowed on spans of type "llm"');
    }
  }
});

/* ---------- request / response ---------- */

export const IngestBatchSchema = z.object({
  events: z.array(EventSchema).min(1).max(LIMITS.maxBatchEvents),
});

/** Outer shape only. The server validates each event individually so one bad event does not sink the batch. */
export const RawBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(LIMITS.maxBatchEvents),
});

export const RejectCodeSchema = z.enum([
  "invalid_event",
  "unknown_event_type",
  "unsupported_schema_version",
]);

export const IngestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      event_id: z.string().optional(),
      code: RejectCodeSchema,
      message: z.string(),
    }),
  ),
});

/* ---------- versioning ---------- */

export function parseVersion(version: string): { major: number; minor: number } {
  const [major, minor] = version.split(".").map(Number);
  return { major, minor };
}

export function isSupportedVersion(version: string): boolean {
  return parseVersion(version).major === SUPPORTED_MAJOR;
}

/* ---------- types ---------- */

export type TraceData = z.infer<typeof TraceDataSchema>;
export type SpanData = z.infer<typeof SpanDataSchema>;
export type SpanType = z.infer<typeof SpanTypeSchema>;
export type EvalResultData = z.infer<typeof EvalResultDataSchema>;
export type ClientEvent = z.infer<typeof EventSchema>;
export type IngestBatch = z.infer<typeof IngestBatchSchema>;
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** What the server stores: the client event plus fields only the server may set. */
export type StoredEvent = ClientEvent & { tenant_id: string; received_at: string };
