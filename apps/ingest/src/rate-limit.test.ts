import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, spanEvent, uuid } from "./testing/harness";
import { TokenBucketLimiter } from "./token-bucket";

describe("TokenBucketLimiter", () => {
  it("allows a burst up to capacity, then blocks", () => {
    const now = 0;
    const limiter = new TokenBucketLimiter(10, 20, () => now);
    expect(limiter.consume("a", 20).allowed).toBe(true);
    const blocked = limiter.consume("a", 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(500); // 5 tokens at 10 per second
  });

  it("refills over time but never above capacity", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(10, 20, () => now);
    limiter.consume("a", 20);
    now = 1000; // +10 tokens
    expect(limiter.consume("a", 10).allowed).toBe(true);
    expect(limiter.consume("a", 1).allowed).toBe(false);
    now = 3_600_000; // an hour later
    expect(limiter.consume("a", 20).allowed).toBe(true);
    expect(limiter.consume("a", 1).allowed).toBe(false);
  });

  it("keeps tenants independent", () => {
    const limiter = new TokenBucketLimiter(1, 5, () => 0);
    expect(limiter.consume("noisy", 5).allowed).toBe(true);
    expect(limiter.consume("noisy", 1).allowed).toBe(false);
    expect(limiter.consume("quiet", 5).allowed).toBe(true);
  });

  it("caps the cost of a batch bigger than the burst so it can still pass", () => {
    const limiter = new TokenBucketLimiter(1, 5, () => 0);
    expect(limiter.consume("a", 500).allowed).toBe(true);
  });
});

describe("rate limiting over HTTP", () => {
  let app: INestApplication;
  afterEach(async () => {
    await app.close();
  });

  it("answers 429 with Retry-After for the noisy tenant only", async () => {
    const ctx = await createTestApp({ perSec: 1, burst: 5 });
    app = ctx.app;
    const batch = () => ({ events: [1, 2, 3].map(() => spanEvent(uuid())) });
    const send = (key: string) =>
      request(app.getHttpServer())
        .post("/v1/events")
        .set("Authorization", `Bearer ${key}`)
        .send(batch());

    expect((await send(ctx.keys.acme)).status).toBe(202);
    const limited = await send(ctx.keys.acme);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    expect((await send(ctx.keys.globex)).status).toBe(202); // not starved by acme
    expect(ctx.producer.sent).toHaveLength(6); // the limited batch was never published
  });
});
