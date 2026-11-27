import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../app.module";
import { generateApiKey, hashApiKey } from "../keys";
import { JsonLogger } from "../logger";
import { TokenBucketLimiter } from "../token-bucket";
import { configureApp } from "../setup";
import { API_KEY_STORE, EVENT_PRODUCER, LOGGER, RATE_LIMITER } from "../tokens";
import type { ApiKeyStore, EventProducer, OutgoingMessage, TenantInfo } from "../types";

export class FakeStore implements ApiKeyStore {
  readonly tenants = new Map<string, string>(); // hash -> tenant id
  readonly revoked = new Set<string>();
  lookups = 0;
  up = true;
  fail = false;

  addKey(tenantId: string): string {
    const key = generateApiKey();
    this.tenants.set(hashApiKey(key), tenantId);
    return key;
  }

  async findByHash(hash: string): Promise<TenantInfo | null> {
    this.lookups++;
    if (this.fail) throw new Error("database is down");
    const tenantId = this.tenants.get(hash);
    return tenantId && !this.revoked.has(hash) ? { tenantId } : null;
  }

  async ping(): Promise<boolean> {
    return this.up;
  }
}

export class FakeProducer implements EventProducer {
  readonly sent: OutgoingMessage[] = [];
  calls = 0;
  up = true;
  fail = false;

  async send(messages: OutgoingMessage[]): Promise<void> {
    this.calls++;
    if (this.fail) throw new Error("broker unavailable");
    this.sent.push(...messages);
  }

  async ping(): Promise<boolean> {
    return this.up;
  }
}

export async function createTestApp(options: { perSec?: number; burst?: number } = {}) {
  const store = new FakeStore();
  const producer = new FakeProducer();
  const logs: string[] = [];
  const keys = { acme: store.addKey("tenant-acme"), globex: store.addKey("tenant-globex") };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_KEY_STORE)
    .useValue(store)
    .overrideProvider(EVENT_PRODUCER)
    .useValue(producer)
    .overrideProvider(RATE_LIMITER)
    .useValue(new TokenBucketLimiter(options.perSec ?? 100_000, options.burst ?? 100_000))
    .overrideProvider(LOGGER)
    .useValue(new JsonLogger("debug", (line) => logs.push(line)))
    .compile();

  const app: INestApplication = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  return { app, store, producer, logs, keys };
}

/* ---------- sample events ---------- */

let counter = 0;
export const uuid = (): string => `0192f3a4-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
const NOW = "2026-11-20T10:00:00.000Z";
const LATER = "2026-11-20T10:00:01.000Z";

const envelope = (event_type: string) => ({
  schema_version: "0.1",
  event_id: uuid(),
  event_type,
  sent_at: NOW,
});

export const spanEvent = (traceId: string, data: Record<string, unknown> = {}) => ({
  ...envelope("span"),
  data: {
    span_id: uuid(),
    trace_id: traceId,
    type: "generic",
    name: "step",
    start_time: NOW,
    end_time: LATER,
    status: "ok",
    ...data,
  },
});

export const traceEvent = (traceId: string, data: Record<string, unknown> = {}) => ({
  ...envelope("trace"),
  data: { trace_id: traceId, name: "demo", start_time: NOW, end_time: LATER, ...data },
});

export const evalEvent = (traceId: string) => ({
  ...envelope("eval_result"),
  data: { eval_id: uuid(), trace_id: traceId, name: "relevance", score: 0.9 },
});
