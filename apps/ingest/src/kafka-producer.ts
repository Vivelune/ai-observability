import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Kafka, logLevel, Partitioners, type Producer } from "kafkajs";
import type { Config } from "./config";
import type { JsonLogger } from "./logger";
import { CONFIG, LOGGER } from "./tokens";
import type { EventProducer, OutgoingMessage } from "./types";

// Redpanda/Kafka reject a produce request bigger than ~1 MiB, so send in chunks below that.
const MAX_CHUNK_BYTES = 800 * 1024;

export function chunkByBytes(messages: OutgoingMessage[], maxBytes: number): OutgoingMessage[][] {
  const chunks: OutgoingMessage[][] = [];
  let current: OutgoingMessage[] = [];
  let size = 0;
  for (const message of messages) {
    const bytes = Buffer.byteLength(message.value) + Buffer.byteLength(message.key) + 100;
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

@Injectable()
export class KafkaEventProducer implements EventProducer, OnModuleInit, OnModuleDestroy {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private connected = false;
  private connecting?: Promise<void>;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: JsonLogger,
  ) {
    this.kafka = new Kafka({
      clientId: "ai-observability-ingest",
      brokers: config.kafkaBrokers,
      connectionTimeout: config.kafkaConnectionTimeoutMs,
      requestTimeout: config.kafkaRequestTimeoutMs,
      retry: { retries: 3, initialRetryTime: 100 },
      logLevel: logLevel.WARN,
      logCreator: () => (entry) =>
        this.logger.warn("kafkajs", { kafka_level: entry.level, message: entry.log.message }),
    });
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    this.producer.on(this.producer.events.CONNECT, () => (this.connected = true));
    this.producer.on(this.producer.events.DISCONNECT, () => (this.connected = false));
  }

  onModuleInit(): void {
    // Do not block startup: if Redpanda is down, /health reports it and sends fail with 503.
    void this.connect().catch((error: Error) =>
      this.logger.error("kafka connect failed, will retry on demand", { error: error.message }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect().catch(() => undefined);
  }

  private connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    // Creating the topic is best effort. If it already exists, or the broker is slow, we still
    // connect the producer: a missing topic then shows up as a clear 503 on the first send.
    await this.ensureTopic().catch((error: Error) =>
      this.logger.warn("could not verify or create the topic, continuing", {
        topic: this.config.eventsTopic,
        error: error.message,
      }),
    );
    await this.producer.connect();
    this.logger.info("kafka producer connected", { topic: this.config.eventsTopic });
  }

  private async ensureTopic(): Promise<void> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const created = await admin.createTopics({
        waitForLeaders: true,
        topics: [
          {
            topic: this.config.eventsTopic,
            numPartitions: this.config.partitions,
            replicationFactor: this.config.replicationFactor,
          },
        ],
      });
      if (created) this.logger.info("created topic", { topic: this.config.eventsTopic });
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }

  async send(messages: OutgoingMessage[]): Promise<void> {
    await this.connect();
    for (const chunk of chunkByBytes(messages, MAX_CHUNK_BYTES)) {
      await this.producer.send({
        topic: this.config.eventsTopic,
        acks: -1, // wait for all in-sync replicas, so a 202 means the event is durable
        timeout: 5000,
        messages: chunk.map((m) => ({ key: m.key, value: m.value, headers: m.headers })),
      });
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }
}
