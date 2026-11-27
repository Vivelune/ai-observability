import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().default("postgres://aiobs:aiobs_dev@localhost:5432/aiobs"),
  KAFKA_BROKERS: z.string().default("localhost:19092"),
  KAFKA_EVENTS_TOPIC: z.string().default("events"),
  KAFKA_PARTITIONS: z.coerce.number().int().positive().default(6),
  KAFKA_REPLICATION_FACTOR: z.coerce.number().int().positive().default(1),
  // Generous defaults: Docker on a slow machine can take several seconds to answer.
  KAFKA_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  KAFKA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Per-tenant token bucket, measured in events (a batch of 100 events costs 100 tokens).
  RATE_LIMIT_EVENTS_PER_SEC: z.coerce.number().positive().default(500),
  RATE_LIMIT_BURST: z.coerce.number().positive().default(5000),
  KEY_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  port: number;
  databaseUrl: string;
  kafkaBrokers: string[];
  eventsTopic: string;
  partitions: number;
  replicationFactor: number;
  kafkaConnectionTimeoutMs: number;
  kafkaRequestTimeoutMs: number;
  rateLimitPerSec: number;
  rateLimitBurst: number;
  keyCacheTtlMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.parse(env);
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    kafkaBrokers: parsed.KAFKA_BROKERS.split(",").map((broker) => broker.trim()),
    eventsTopic: parsed.KAFKA_EVENTS_TOPIC,
    partitions: parsed.KAFKA_PARTITIONS,
    replicationFactor: parsed.KAFKA_REPLICATION_FACTOR,
    kafkaConnectionTimeoutMs: parsed.KAFKA_CONNECTION_TIMEOUT_MS,
    kafkaRequestTimeoutMs: parsed.KAFKA_REQUEST_TIMEOUT_MS,
    rateLimitPerSec: parsed.RATE_LIMIT_EVENTS_PER_SEC,
    rateLimitBurst: parsed.RATE_LIMIT_BURST,
    keyCacheTtlMs: parsed.KEY_CACHE_TTL_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}
