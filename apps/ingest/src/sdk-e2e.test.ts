import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Observe } from "../../../packages/sdk/src/index";
import { createTestApp } from "./testing/harness";

describe("SDK to ingest API", () => {
  let app: INestApplication;
  afterEach(async () => {
    await app.close();
  });

  it("delivers real SDK events over HTTP, keyed by trace and tagged with the tenant", async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;

    const obs = new Observe({
      apiKey: ctx.keys.acme,
      endpoint: `http://127.0.0.1:${port}`,
      exitHooks: false,
    });
    await obs.trace("invoice-extract", async () => {
      await obs.span("parse", async () => {});
      await obs.span("answer", async (s) => s.setLlm({ model: "m", provider: "p" }), {
        type: "llm",
      });
    });
    const stats = await obs.shutdown();

    expect(stats).toMatchObject({ sent: 3, rejected: 0, discarded: 0, buffered: 0 });
    expect(ctx.producer.sent).toHaveLength(3);
    expect(new Set(ctx.producer.sent.map((m) => m.key)).size).toBe(1); // one trace, one partition key
    for (const message of ctx.producer.sent) {
      expect(JSON.parse(message.value).tenant_id).toBe("tenant-acme");
    }
  });

  it("makes the SDK discard events when the key is wrong (401 is not retried)", async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;

    const obs = new Observe({
      apiKey: "aiobs_" + "A".repeat(43),
      endpoint: `http://127.0.0.1:${port}`,
      exitHooks: false,
    });
    await obs.trace("x", async () => {});
    const stats = await obs.shutdown();
    expect(stats).toMatchObject({ sent: 0, discarded: 1, buffered: 0 });
    expect(ctx.producer.calls).toBe(0);
  });
});
