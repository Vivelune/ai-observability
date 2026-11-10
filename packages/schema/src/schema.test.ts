import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EventSchema,
  IngestBatchSchema,
  LIMITS,
  SCHEMA_VERSION,
  byteLength,
  isSupportedVersion,
  truncateIo,
} from "./index";

const ids = {
  event: "0192f3a4-7b1c-7d2e-8a3f-4b5c6d7e8f01",
  trace: "0192f3a4-7b1c-7d2e-8a3f-4b5c6d7e8f90",
  span: "0192f3a4-7b1d-7a10-9c11-1a2b3c4d5e01",
};
const envelope = {
  schema_version: SCHEMA_VERSION,
  event_id: ids.event,
  sent_at: "2026-11-10T09:15:02.000Z",
};

function spanEvent(data: Record<string, unknown> = {}) {
  return {
    ...envelope,
    event_type: "span",
    data: {
      span_id: ids.span,
      trace_id: ids.trace,
      type: "generic",
      name: "step",
      start_time: "2026-11-10T09:15:00.000Z",
      end_time: "2026-11-10T09:15:01.000Z",
      status: "ok",
      ...data,
    },
  };
}

describe("example payloads", () => {
  const dir = join(process.cwd(), "docs", "examples");
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));

  it("finds the example files", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    it(`${file} is a valid batch`, () => {
      const result = IngestBatchSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    });
  }
});

describe("envelope", () => {
  it("strips tenant_id sent by a client", () => {
    const parsed = EventSchema.parse({ ...spanEvent(), tenant_id: "evil-tenant" });
    expect(parsed).not.toHaveProperty("tenant_id");
  });

  it("rejects an unknown event_type", () => {
    expect(EventSchema.safeParse({ ...envelope, event_type: "nope", data: {} }).success).toBe(
      false,
    );
  });

  it("rejects non-UTC timestamps", () => {
    const event = spanEvent({ start_time: "2026-11-10T11:15:00.000+02:00" });
    expect(EventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an event_id that is not a UUID", () => {
    expect(EventSchema.safeParse({ ...spanEvent(), event_id: "abc" }).success).toBe(false);
  });

  it("rejects batches over the event limit", () => {
    const events = Array.from({ length: LIMITS.maxBatchEvents + 1 }, () => spanEvent());
    expect(IngestBatchSchema.safeParse({ events }).success).toBe(false);
  });
});

describe("span rules", () => {
  it("accepts a running span without end_time", () => {
    const event = spanEvent({ status: "running", end_time: undefined });
    expect(EventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects a running span with end_time", () => {
    expect(EventSchema.safeParse(spanEvent({ status: "running" })).success).toBe(false);
  });

  it("rejects a finished span without end_time", () => {
    expect(EventSchema.safeParse(spanEvent({ end_time: undefined })).success).toBe(false);
  });

  it("rejects end_time before start_time", () => {
    const event = spanEvent({ end_time: "2026-11-10T09:14:00.000Z" });
    expect(EventSchema.safeParse(event).success).toBe(false);
  });

  it("requires llm fields on llm spans", () => {
    expect(EventSchema.safeParse(spanEvent({ type: "llm" })).success).toBe(false);
    const ok = spanEvent({ type: "llm", llm: { model: "gpt-4o", provider: "openai" } });
    expect(EventSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects llm fields on non-llm spans", () => {
    const event = spanEvent({ llm: { model: "gpt-4o", provider: "openai" } });
    expect(EventSchema.safeParse(event).success).toBe(false);
  });

  it("only allows error when status is error", () => {
    const error = { type: "TimeoutError", message: "timed out" };
    expect(EventSchema.safeParse(spanEvent({ error })).success).toBe(false);
    expect(EventSchema.safeParse(spanEvent({ status: "error", error })).success).toBe(true);
  });
});

describe("truncateIo", () => {
  it("leaves small values untouched", () => {
    expect(truncateIo("hello", 100)).toEqual({ value: "hello", truncated: false });
  });

  it("truncates long strings to the byte limit", () => {
    const result = truncateIo("a".repeat(500), 100);
    expect(result.truncated).toBe(true);
    expect(byteLength(result.value as string)).toBeLessThanOrEqual(100);
  });

  it("does not leave a broken multi-byte character", () => {
    const result = truncateIo("é".repeat(100), 51); // 2 bytes each, cut mid-character
    expect(result.truncated).toBe(true);
    expect(result.value).not.toContain("\uFFFD");
  });

  it("turns an oversized messages array into a truncated string", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(500) }];
    const result = truncateIo(messages, 100);
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe("string");
  });
});

describe("versioning", () => {
  it("supports any 0.x and rejects other majors", () => {
    expect(isSupportedVersion("0.1")).toBe(true);
    expect(isSupportedVersion("0.7")).toBe(true);
    expect(isSupportedVersion("1.0")).toBe(false);
  });
});
