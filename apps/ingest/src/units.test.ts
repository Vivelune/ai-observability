import { describe, expect, it } from "vitest";
import { CachedApiKeyStore } from "./cached-key-store";
import { loadConfig } from "./config";
import { chunkByBytes } from "./kafka-producer";
import { generateApiKey, hashApiKey, keyPrefix, looksLikeApiKey } from "./keys";
import { JsonLogger } from "./logger";
import type { ApiKeyStore, TenantInfo } from "./types";

describe("API keys", () => {
  it("generates unique, well-formed keys", () => {
    const a = generateApiKey();
    expect(looksLikeApiKey(a)).toBe(true);
    expect(a).not.toBe(generateApiKey());
    expect(looksLikeApiKey("aiobs_short")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });

  it("stores a hash that does not contain the key", () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).not.toContain(key.slice(6, 20));
    expect(keyPrefix(key)).toHaveLength(12);
  });
});

describe("CachedApiKeyStore", () => {
  function counting(map: Record<string, string>) {
    const inner = {
      calls: 0,
      async findByHash(hash: string): Promise<TenantInfo | null> {
        inner.calls++;
        return map[hash] ? { tenantId: map[hash] } : null;
      },
      async ping() {
        return true;
      },
    };
    return inner satisfies ApiKeyStore;
  }

  it("serves repeat lookups from memory until the TTL expires", async () => {
    let now = 0;
    const inner = counting({ h1: "t1" });
    const store = new CachedApiKeyStore(inner, 60_000, 10_000, () => now);
    await store.findByHash("h1");
    await store.findByHash("h1");
    expect(inner.calls).toBe(1);
    now = 60_001;
    await store.findByHash("h1");
    expect(inner.calls).toBe(2);
  });

  it("caches unknown keys only briefly", async () => {
    let now = 0;
    const inner = counting({});
    const store = new CachedApiKeyStore(inner, 60_000, 10_000, () => now);
    expect(await store.findByHash("nope")).toBeNull();
    await store.findByHash("nope");
    expect(inner.calls).toBe(1);
    now = 10_001;
    await store.findByHash("nope");
    expect(inner.calls).toBe(2);
  });

  it("does not cache lookup errors", async () => {
    let fail = true;
    const inner: ApiKeyStore = {
      async findByHash() {
        if (fail) throw new Error("db down");
        return { tenantId: "t1" };
      },
      async ping() {
        return true;
      },
    };
    const store = new CachedApiKeyStore(inner, 60_000);
    await expect(store.findByHash("h")).rejects.toThrow("db down");
    fail = false;
    expect(await store.findByHash("h")).toEqual({ tenantId: "t1" });
  });
});

describe("chunkByBytes", () => {
  const message = (size: number) => ({ key: "k", value: "x".repeat(size), headers: {} });

  it("splits a batch so no chunk exceeds the limit, preserving order", () => {
    const messages = [message(400), message(400), message(400), message(400)];
    const chunks = chunkByBytes(messages, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(messages);
  });

  it("keeps a single oversized message in its own chunk", () => {
    expect(chunkByBytes([message(5000)], 1000)).toHaveLength(1);
  });
});

describe("config", () => {
  it("has working defaults and parses overrides", () => {
    expect(loadConfig({}).eventsTopic).toBe("events");
    const config = loadConfig({ KAFKA_BROKERS: "a:1, b:2", RATE_LIMIT_BURST: "10" });
    expect(config.kafkaBrokers).toEqual(["a:1", "b:2"]);
    expect(config.rateLimitBurst).toBe(10);
  });

  it("has generous Kafka timeouts by default", () => {
    const config = loadConfig({});
    expect(config.kafkaConnectionTimeoutMs).toBe(10_000);
    expect(config.kafkaRequestTimeoutMs).toBe(15_000);
  });

  it("rejects an invalid value", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow();
  });
});

describe("JsonLogger", () => {
  it("writes JSON lines and respects the level", () => {
    const lines: string[] = [];
    const logger = new JsonLogger("warn", (line) => lines.push(line));
    logger.info("hidden");
    logger.error("boom", { code: 7 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", msg: "boom", code: 7 });
  });
});
