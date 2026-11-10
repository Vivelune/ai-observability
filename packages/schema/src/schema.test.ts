import { describe, expect, it } from "vitest";
import { SpanEventSchema } from "./index";

const valid = {
  schemaVersion: "0.1",
  traceId: "t1",
  spanId: "s1",
  name: "call llm",
  startTime: "2026-11-04T10:00:00.000Z",
  durationMs: 120,
};

describe("SpanEventSchema", () => {
  it("accepts a minimal valid span and applies defaults", () => {
    const parsed = SpanEventSchema.parse(valid);
    expect(parsed.kind).toBe("other");
    expect(parsed.status).toBe("ok");
  });

  it("rejects a span with no traceId", () => {
    expect(SpanEventSchema.safeParse({ ...valid, traceId: "" }).success).toBe(false);
  });
});
