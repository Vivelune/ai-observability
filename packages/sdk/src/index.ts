import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, type SpanEvent } from "@ai-observability/schema";

export interface AiObsOptions {
  apiKey: string;
  endpoint: string; // e.g. http://localhost:3001
  flushIntervalMs?: number;
  maxBatchSize?: number;
}

type EndFields = Partial<
  Pick<SpanEvent, "status" | "model" | "inputTokens" | "outputTokens" | "prompt" | "completion" | "error" | "metadata">
>;

export class Span {
  readonly spanId = randomUUID();
  private readonly start = Date.now();
  constructor(
    private readonly client: AiObs,
    readonly traceId: string,
    readonly name: string,
    readonly kind: SpanEvent["kind"],
    readonly parentSpanId?: string,
  ) {}

  child(name: string, kind: SpanEvent["kind"] = "other"): Span {
    return new Span(this.client, this.traceId, name, kind, this.spanId);
  }

  end(fields: EndFields = {}): void {
    this.client.record({
      schemaVersion: SCHEMA_VERSION,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      status: fields.status ?? "ok",
      startTime: new Date(this.start).toISOString(),
      durationMs: Date.now() - this.start,
      ...fields,
    });
  }
}

export class AiObs {
  private buffer: SpanEvent[] = [];
  private timer: NodeJS.Timeout;

  constructor(private readonly opts: AiObsOptions) {
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 2000);
    this.timer.unref();
  }

  startTrace(name: string, kind: SpanEvent["kind"] = "chain"): Span {
    return new Span(this, randomUUID(), name, kind);
  }

  record(event: SpanEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= (this.opts.maxBatchSize ?? 100)) void this.flush();
  }

  /** At-least-once: on failure events go back in the buffer; the server dedupes on spanId. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0, this.buffer.length);
    try {
      const res = await fetch(`${this.opts.endpoint}/v1/spans`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
    } catch {
      this.buffer.unshift(...events.slice(-1000)); // cap retained events
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

export type { SpanEvent } from "@ai-observability/schema";
