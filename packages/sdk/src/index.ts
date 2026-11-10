import { randomUUID } from "node:crypto";
import {
  SCHEMA_VERSION,
  truncateIo,
  type ClientEvent,
  type Io,
  type SpanType,
} from "@ai-observability/schema";

export type { ClientEvent, Io, SpanType } from "@ai-observability/schema";

export interface AiObsOptions {
  apiKey: string;
  endpoint: string; // e.g. http://localhost:3001
  flushIntervalMs?: number;
  maxBatchSize?: number;
}

export interface LlmInfo {
  model: string;
  provider: string;
  input?: Io;
  output?: Io;
  inputTokens?: number;
  outputTokens?: number;
  parameters?: Record<string, unknown>;
}

export interface EndSpanFields {
  status?: "ok" | "error";
  error?: { type: string; message: string; stack?: string };
  llm?: LlmInfo;
  metadata?: Record<string, unknown>;
}

export interface TraceOptions {
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

function mapLlm(llm: LlmInfo) {
  const input = llm.input === undefined ? undefined : truncateIo(llm.input);
  const output = llm.output === undefined ? undefined : truncateIo(llm.output);
  return {
    model: llm.model,
    provider: llm.provider,
    input: input?.value,
    output: output?.value,
    input_tokens: llm.inputTokens,
    output_tokens: llm.outputTokens,
    parameters: llm.parameters,
    io_truncated: input?.truncated || output?.truncated || undefined,
  };
}

export class SpanHandle {
  readonly spanId = randomUUID();
  private readonly start = new Date();

  constructor(
    private readonly client: AiObs,
    readonly traceId: string,
    private readonly name: string,
    private readonly type: SpanType,
    private readonly parentSpanId?: string,
  ) {}

  child(name: string, type: SpanType = "generic"): SpanHandle {
    return new SpanHandle(this.client, this.traceId, name, type, this.spanId);
  }

  end(fields: EndSpanFields = {}): void {
    this.client.enqueue("span", {
      span_id: this.spanId,
      trace_id: this.traceId,
      parent_span_id: this.parentSpanId,
      type: this.type,
      name: this.name,
      start_time: this.start.toISOString(),
      end_time: new Date().toISOString(),
      status: fields.status ?? (fields.error ? "error" : "ok"),
      error: fields.error,
      llm: fields.llm ? mapLlm(fields.llm) : undefined,
      metadata: fields.metadata,
    });
  }
}

export class TraceHandle {
  readonly traceId = randomUUID();
  private readonly start = new Date();

  constructor(
    private readonly client: AiObs,
    private readonly name: string,
    private readonly options: TraceOptions,
  ) {}

  span(name: string, type: SpanType = "generic"): SpanHandle {
    return new SpanHandle(this.client, this.traceId, name, type);
  }

  end(): void {
    this.client.enqueue("trace", {
      trace_id: this.traceId,
      name: this.name,
      start_time: this.start.toISOString(),
      end_time: new Date().toISOString(),
      user_id: this.options.userId,
      session_id: this.options.sessionId,
      metadata: this.options.metadata,
      tags: this.options.tags,
    });
  }
}

export class AiObs {
  private buffer: ClientEvent[] = [];
  private timer: NodeJS.Timeout;

  constructor(private readonly opts: AiObsOptions) {
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 2000);
    this.timer.unref();
  }

  trace(name: string, options: TraceOptions = {}): TraceHandle {
    return new TraceHandle(this, name, options);
  }

  /** @internal used by TraceHandle and SpanHandle */
  enqueue(eventType: ClientEvent["event_type"], data: unknown): void {
    this.buffer.push({
      schema_version: SCHEMA_VERSION,
      event_id: randomUUID(),
      event_type: eventType,
      sent_at: new Date().toISOString(),
      data,
    } as ClientEvent);
    if (this.buffer.length >= (this.opts.maxBatchSize ?? 100)) void this.flush();
  }

  /**
   * At-least-once: network errors, 429 and 5xx put events back in the buffer. The server
   * dedupes on event_id, so a retry never double-counts. Other 4xx responses drop the batch.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0, this.buffer.length);
    const body = JSON.stringify({
      events: events.map((event) => ({ ...event, sent_at: new Date().toISOString() })),
    });
    try {
      const res = await fetch(`${this.opts.endpoint}/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`ingest failed: ${res.status}`);
    } catch {
      this.buffer.unshift(...events.slice(-1000)); // cap retained events
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
