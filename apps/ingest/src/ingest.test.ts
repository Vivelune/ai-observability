import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "./keys";
import {
  createTestApp,
  evalEvent,
  spanEvent,
  traceEvent,
  uuid,
  type FakeProducer,
  type FakeStore,
} from "./testing/harness";

let app: INestApplication;
let store: FakeStore;
let producer: FakeProducer;
let logs: string[];
let keys: { acme: string; globex: string };

const post = (key: string | undefined, body: unknown) => {
  const req = request(app.getHttpServer()).post("/v1/events");
  if (key) req.set("Authorization", `Bearer ${key}`);
  return req.send(body as object);
};

beforeEach(async () => {
  ({ app, store, producer, logs, keys } = await createTestApp());
});
afterEach(async () => {
  await app.close();
});

describe("authentication", () => {
  const body = () => ({ events: [spanEvent(uuid())] });

  it("rejects a missing key with 401", async () => {
    const res = await post(undefined, body());
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects other schemes, malformed keys, unknown keys and revoked keys", async () => {
    const wrongScheme = await request(app.getHttpServer())
      .post("/v1/events")
      .set("Authorization", "Basic abc")
      .send(body());
    expect(wrongScheme.status).toBe(401);
    expect((await post("not-a-key", body())).status).toBe(401);
    expect((await post(generateApiKey(), body())).status).toBe(401);

    const [hash] = [...store.tenants.keys()];
    store.revoked.add(hash);
    expect((await post(keys.acme, body())).status).toBe(401);
    expect(producer.calls).toBe(0);
  });

  it("does not hit the database for malformed keys", async () => {
    await post("garbage", body());
    expect(store.lookups).toBe(0);
  });

  it("answers 503 when the key lookup fails, never 202", async () => {
    store.fail = true;
    const res = await post(keys.acme, body());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("unavailable");
    expect(producer.calls).toBe(0);
  });

  it("rejects unauthenticated requests before parsing the body", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/events")
      .set("Content-Type", "application/json")
      .send("{this is not json");
    expect(res.status).toBe(401);
  });
});

describe("accepting events", () => {
  it("returns 202 and publishes each event keyed by trace_id", async () => {
    const t1 = uuid();
    const t2 = uuid();
    const events = [spanEvent(t1), spanEvent(t1), traceEvent(t1), evalEvent(t1), spanEvent(t2)];
    const res = await post(keys.acme, { events });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 5, rejected: [] });
    expect(producer.sent.map((m) => m.key)).toEqual([t1, t1, t1, t1, t2]);
  });

  it("derives tenant_id from the API key and ignores any tenant_id from the client", async () => {
    const t = uuid();
    const event = { ...spanEvent(t), tenant_id: "evil-tenant" };
    (event.data as Record<string, unknown>).tenant_id = "evil-tenant";
    await post(keys.acme, { events: [event] });
    await post(keys.globex, { events: [spanEvent(t)] });

    const [first, second] = producer.sent.map((m) => JSON.parse(m.value));
    expect(first.tenant_id).toBe("tenant-acme");
    expect(first.data).not.toHaveProperty("tenant_id");
    expect(second.tenant_id).toBe("tenant-globex");
    expect(producer.sent[0].headers).toEqual({ tenant_id: "tenant-acme", event_type: "span" });
  });

  it("publishes the validated event plus tenant_id and received_at", async () => {
    const t = uuid();
    const event = spanEvent(t);
    await post(keys.acme, { events: [event] });
    const message = JSON.parse(producer.sent[0].value);
    expect(message).toMatchObject({ ...event, tenant_id: "tenant-acme" });
    expect(typeof message.received_at).toBe("string");
  });

  it("returns partial success with a clear reason per bad event", async () => {
    const t = uuid();
    const good = spanEvent(t);
    const badOrder = spanEvent(t, { end_time: "2020-01-01T00:00:00.000Z" });
    const events = [
      good,
      { ...spanEvent(t), event_type: "banana" },
      { ...spanEvent(t), schema_version: "9.0" },
      "just a string",
      badOrder,
      { event_id: uuid(), schema_version: "0.1", event_type: "span", sent_at: "x", data: {} },
    ];
    const res = await post(keys.acme, { events });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
    expect(
      res.body.rejected.map((r: { index: number; code: string }) => [r.index, r.code]),
    ).toEqual([
      [1, "unknown_event_type"],
      [2, "unsupported_schema_version"],
      [3, "invalid_event"],
      [4, "invalid_event"],
      [5, "invalid_event"],
    ]);
    expect(res.body.rejected[3].message).toContain("end_time");
    expect(res.body.rejected[4].message).toContain("data.");
    expect(producer.sent).toHaveLength(1);
  });

  it("still answers 202 and publishes nothing when every event is invalid", async () => {
    const res = await post(keys.acme, { events: [{ nope: true }, 42] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(0);
    expect(producer.calls).toBe(0);
  });

  it("rejects an event too large for the broker without failing the batch", async () => {
    const t = uuid();
    const huge = spanEvent(t, {
      type: "llm",
      llm: { model: "m", provider: "p", input: "x".repeat(950 * 1024) },
    });
    const res = await post(keys.acme, { events: [spanEvent(t), huge] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected[0]).toMatchObject({ index: 1, code: "invalid_event" });
    expect(res.body.rejected[0].message).toContain("900 KB");
  });

  it("returns 503 when the broker is down, so the SDK retries the whole batch", async () => {
    producer.fail = true;
    const res = await post(keys.acme, { events: [spanEvent(uuid())] });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("unavailable");
  });
});

describe("bad requests", () => {
  it("returns 400 for malformed JSON", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/events")
      .set("Authorization", `Bearer ${keys.acme}`)
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });

  it("returns 400 when events is missing, empty or over 500", async () => {
    expect((await post(keys.acme, {})).status).toBe(400);
    expect((await post(keys.acme, { events: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, () => spanEvent(uuid()));
    const res = await post(keys.acme, { events: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("returns 413 for a body over 5 MB", async () => {
    const res = await post(keys.acme, { events: [{ pad: "x".repeat(6 * 1024 * 1024) }] });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app.getHttpServer()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("health", () => {
  it("reports ok without authentication", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", checks: { postgres: "up", kafka: "up" } });
  });

  it("reports 503 and which dependency is down", async () => {
    store.up = false;
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "degraded",
      checks: { postgres: "down", kafka: "up" },
    });
    store.up = true;
    producer.up = false;
    expect((await request(app.getHttpServer()).get("/health")).body.checks.kafka).toBe("down");
  });
});

describe("structured logs", () => {
  it("writes one JSON line per request without secrets", async () => {
    const t = uuid();
    const res = await request(app.getHttpServer())
      .post("/v1/events")
      .set("Authorization", `Bearer ${keys.acme}`)
      .set("x-request-id", "req-123")
      .send({ events: [spanEvent(t), { bad: true }] });

    expect(res.headers["x-request-id"]).toBe("req-123");
    const lines = logs.map((line) => JSON.parse(line));
    const entry = lines.find((l) => l.msg === "request");
    expect(entry).toMatchObject({
      level: "info",
      request_id: "req-123",
      method: "POST",
      path: "/v1/events",
      status: 202,
      tenant_id: "tenant-acme",
      accepted: 1,
      rejected: 1,
    });
    expect(typeof entry.duration_ms).toBe("number");

    const everything = logs.join("\n");
    expect(everything).not.toContain(keys.acme);
    expect(everything).not.toContain("Bearer");
    expect(everything).not.toContain("start_time"); // no event bodies
  });

  it("generates a request id when none is sent", async () => {
    const res = await request(app.getHttpServer()).get("/nope");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
