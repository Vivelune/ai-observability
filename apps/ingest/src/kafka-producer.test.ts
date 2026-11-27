import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A scripted stand-in for kafkajs, so we can test connect behavior without a broker.
const state = vi.hoisted(() => ({
  kafkaOptions: undefined as Record<string, unknown> | undefined,
  createTopics: undefined as (() => Promise<boolean>) | undefined,
  sent: [] as unknown[],
}));

vi.mock("kafkajs", () => {
  class Kafka {
    constructor(options: Record<string, unknown>) {
      state.kafkaOptions = options;
    }
    admin() {
      return {
        connect: async () => undefined,
        disconnect: async () => undefined,
        createTopics: () => state.createTopics!(),
      };
    }
    producer() {
      return {
        events: { CONNECT: "connect", DISCONNECT: "disconnect" },
        on: () => undefined,
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async (request: unknown) => void state.sent.push(request),
      };
    }
  }
  return {
    Kafka,
    logLevel: { WARN: 2 },
    Partitioners: { DefaultPartitioner: () => () => 0 },
  };
});

import { loadConfig } from "./config";
import { KafkaEventProducer } from "./kafka-producer";
import { JsonLogger } from "./logger";

const message = { key: "trace-1", value: "{}", headers: { tenant_id: "t" } };

describe("KafkaEventProducer", () => {
  let logs: string[];
  const make = () =>
    new KafkaEventProducer(
      loadConfig({ KAFKA_REQUEST_TIMEOUT_MS: "20000" }),
      new JsonLogger("debug", (l) => logs.push(l)),
    );

  beforeEach(() => {
    logs = [];
    state.sent.length = 0;
    state.createTopics = async () => true;
  });

  it("uses the configured connection and request timeouts", () => {
    make();
    expect(state.kafkaOptions).toMatchObject({ connectionTimeout: 10_000, requestTimeout: 20_000 });
  });

  it("connects and sends even when creating the topic times out", async () => {
    state.createTopics = async () => {
      throw new Error("Request CreateTopics(key: 19, version: 3) timed out");
    };
    const producer = make();
    await producer.send([message]);
    expect(state.sent).toHaveLength(1);
    expect(logs.join("\n")).toContain("could not verify or create the topic");
    expect(await producer.ping()).toBe(true);
  });

  it("keys messages and publishes them to the configured topic with acks=all", async () => {
    await make().send([message]);
    expect(state.sent[0]).toMatchObject({
      topic: "events",
      acks: -1,
      messages: [{ key: "trace-1", headers: { tenant_id: "t" } }],
    });
  });
});
