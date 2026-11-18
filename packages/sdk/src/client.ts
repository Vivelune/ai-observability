import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  SCHEMA_VERSION,
  truncateIo,
  truncateString,
  type ClientEvent,
} from "@ai-observability/schema";
import { EventBuffer, type BufferedEvent } from "./buffer";
import { backoffDelay, parseRetryAfter } from "./retry";
import type {
  FetchLike,
  LlmInfo,
  ObserveOptions,
  ObserveStats,
  SpanHandle,
  SpanOptions,
  SpanType,
  TraceHandle,
  TraceOptions,
} from "./types";

const MAX_EVENTS_PER_REQUEST = LIMITS.maxBatchEvents;
const MAX_BYTES_PER_REQUEST = 4 * 1024 * 1024; // stay under the 5 MB contract limit
const MAX_EVENT_BYTES = 1024 * 1024; // a single event bigger than this is discarded
const MAX_STACK_BYTES = 8 * 1024;

/* ---------- small helpers ---------- */

const number = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const clip = (value: string | undefined, max = LIMITS.maxNameLength): string | undefined =>
  value === undefined || value === "" ? undefined : value.slice(0, max);

/** A cancellable wait. It keeps the process alive while pending, so shutdown can finish. */
function wait(ms: number): { done: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return { done, cancel: () => clearTimeout(timer) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
  }
}

function clampMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.keys(metadata).length === 0) return undefined;
  return safeStringify(metadata).length > LIMITS.maxMetadataBytes
    ? { _dropped: "metadata exceeded 16 KB" }
    : metadata;
}

function describeError(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: clip(error.name) ?? "Error",
      message: error.message,
      stack: error.stack ? truncateString(error.stack, MAX_STACK_BYTES) : undefined,
    };
  }
  return { type: "NonError", message: String(error) };
}

function mapLlm(llm: Partial<LlmInfo>) {
  const input = llm.input === undefined ? undefined : truncateIo(llm.input);
  const output = llm.output === undefined ? undefined : truncateIo(llm.output);
  return {
    model: llm.model ?? "unknown",
    provider: llm.provider ?? "unknown",
    input: input?.value,
    output: output?.value,
    input_tokens: llm.inputTokens,
    output_tokens: llm.outputTokens,
    parameters: llm.parameters,
    io_truncated: input?.truncated || output?.truncated || undefined,
  };
}

/* ---------- no-op handles (used when the SDK is disabled or fails to set up) ---------- */

const NOOP_SPAN: SpanHandle = {
  traceId: "",
  spanId: "",
  async span<T>(_name: string, fn: (span: SpanHandle) => T | Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
  setMetadata() {},
  setLlm() {},
};

const NOOP_TRACE: TraceHandle = {
  traceId: "",
  async span<T>(_name: string, fn: (span: SpanHandle) => T | Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
  setUser() {},
  setSession() {},
  setMetadata() {},
  addTags() {},
};

/* ---------- internal state ---------- */

interface TraceState {
  traceId: string;
  name: string;
  start: Date;
  userId?: string;
  sessionId?: string;
  metadata: Record<string, unknown>;
  tags: string[];
}

interface Active {
  trace: TraceState;
  spanId?: string;
}

type SendOutcome = { kind: "ok" } | { kind: "discard" } | { kind: "retry"; retryAfterMs?: number };

export class Observe {
  private readonly cfg: {
    apiKey: string;
    endpoint: string;
    flushAt: number;
    flushIntervalMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    requestTimeoutMs: number;
  };
  private readonly buffer: EventBuffer;
  private readonly als = new AsyncLocalStorage<Active>();
  private readonly fetchFn?: FetchLike;
  private readonly random: () => number;
  private readonly onError?: (error: Error) => void;
  private enabled: boolean;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private failures = 0;
  private nextAttemptAt = 0;
  private counters = { sent: 0, retries: 0, discarded: 0, rejected: 0 };
  private removeHooks: Array<() => void> = [];

  constructor(options: ObserveOptions) {
    const o = options ?? ({} as ObserveOptions);
    this.onError = o.onError;
    this.random = o.random ?? Math.random;
    this.cfg = {
      apiKey: o.apiKey,
      endpoint: String(o.endpoint ?? "").replace(/\/+$/, ""),
      flushAt: number(o.flushAt, 100),
      flushIntervalMs: number(o.flushIntervalMs, 2000),
      retryBaseDelayMs: number(o.retryBaseDelayMs, 500),
      retryMaxDelayMs: number(o.retryMaxDelayMs, 30_000),
      requestTimeoutMs: number(o.requestTimeoutMs, 10_000),
    };
    this.buffer = new EventBuffer(number(o.maxBufferSize, 10_000));
    this.fetchFn = o.fetch ?? (typeof fetch === "function" ? (fetch as FetchLike) : undefined);
    this.enabled = o.enabled !== false && Boolean(o.apiKey && this.cfg.endpoint && this.fetchFn);
    if (o.enabled !== false && !this.enabled) {
      this.report(new Error("Observe is disabled: apiKey, endpoint and fetch are required"));
    }
    if (this.enabled) {
      try {
        this.timer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
        this.timer.unref();
        if (o.exitHooks !== false) this.installExitHooks();
      } catch (error) {
        this.report(error);
      }
    }
  }

  /* ---------- public API ---------- */

  /** Run fn inside a new trace. Your result (or your error) always comes back unchanged. */
  async trace<T>(
    name: string,
    fn: (trace: TraceHandle) => T | Promise<T>,
    options: TraceOptions = {},
  ): Promise<T> {
    if (!this.enabled || this.closed) return fn(NOOP_TRACE);
    let state: TraceState;
    try {
      state = {
        traceId: randomUUID(),
        name: clip(name) ?? "unnamed",
        start: new Date(),
        userId: clip(options.userId),
        sessionId: clip(options.sessionId),
        metadata: { ...options.metadata },
        tags: this.cleanTags(options.tags ?? []),
      };
    } catch (error) {
      this.report(error);
      return fn(NOOP_TRACE);
    }
    const handle = this.traceHandle(state);
    return this.als.run({ trace: state }, async () => {
      try {
        const result = await fn(handle);
        this.safe(() => this.endTrace(state));
        return result;
      } catch (error) {
        this.safe(() => {
          const { type, message } = describeError(error);
          state.metadata.error = { type, message };
          this.endTrace(state);
        });
        throw error;
      }
    });
  }

  /**
   * Run fn inside a span. Finds its parent automatically (AsyncLocalStorage). Called outside a
   * trace, it starts an implicit trace with the same name.
   */
  span<T>(
    name: string,
    fn: (span: SpanHandle) => T | Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const active = this.als.getStore();
    if (!active) return this.trace(name, (trace) => trace.span(name, fn, options));
    return this.runSpan(active, name, fn, options);
  }

  /** Send everything buffered now (ignoring any retry delay). Never throws. */
  flush(options: { force?: boolean } = {}): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.flushing) return this.flushing;
    const run: Promise<void> = this.drain(options.force === true)
      .catch((error) => this.report(error))
      .finally(() => {
        this.flushing = undefined;
      });
    this.flushing = run;
    return run;
  }

  /**
   * Stop accepting events and try to deliver what is buffered, for at most timeoutMs.
   * Events still buffered after that are lost. Returns the final counters.
   */
  async shutdown(timeoutMs = 5000): Promise<ObserveStats> {
    if (this.closed) return this.stats();
    this.closed = true;
    try {
      if (this.timer) clearInterval(this.timer);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.removeHooks.forEach((remove) => remove());
      this.removeHooks = [];
      if (this.enabled) {
        const deadline = Date.now() + timeoutMs;
        while (this.buffer.length > 0 && Date.now() < deadline) {
          const timeout = wait(deadline - Date.now());
          try {
            await Promise.race([this.flush({ force: true }), timeout.done]);
          } finally {
            timeout.cancel();
          }
          if (this.buffer.length > 0 && Date.now() < deadline) {
            await wait(Math.min(250, deadline - Date.now())).done;
          }
        }
      }
    } catch (error) {
      this.report(error);
    }
    return this.stats();
  }

  stats(): ObserveStats {
    return {
      buffered: this.buffer.length,
      sent: this.counters.sent,
      retries: this.counters.retries,
      dropped: this.buffer.dropped,
      discarded: this.counters.discarded,
      rejected: this.counters.rejected,
    };
  }

  /* ---------- trace and span plumbing ---------- */

  private traceHandle(state: TraceState): TraceHandle {
    const active: Active = { trace: state };
    return {
      traceId: state.traceId,
      span: (name, fn, options = {}) => this.runSpan(active, name, fn, options),
      setUser: (userId) => this.safe(() => void (state.userId = clip(userId))),
      setSession: (sessionId) => this.safe(() => void (state.sessionId = clip(sessionId))),
      setMetadata: (metadata) => this.safe(() => void Object.assign(state.metadata, metadata)),
      addTags: (...tags) => this.safe(() => void state.tags.push(...this.cleanTags(tags))),
    };
  }

  private async runSpan<T>(
    active: Active,
    name: string,
    fn: (span: SpanHandle) => T | Promise<T>,
    options: SpanOptions,
  ): Promise<T> {
    let run: { handle: SpanHandle; next: Active; finish: (error?: unknown) => void };
    try {
      run = this.startSpan(active, name, options);
    } catch (error) {
      this.report(error);
      return fn(NOOP_SPAN);
    }
    return this.als.run(run.next, async () => {
      try {
        const result = await fn(run.handle);
        this.safe(() => run.finish());
        return result;
      } catch (error) {
        this.safe(() => run.finish(error));
        throw error;
      }
    });
  }

  private startSpan(active: Active, name: string, options: SpanOptions) {
    const spanId = randomUUID();
    const start = new Date();
    const type: SpanType = options.type ?? "generic";
    const metadata: Record<string, unknown> = { ...options.metadata };
    let llm: Partial<LlmInfo> | undefined;
    const next: Active = { trace: active.trace, spanId };

    const handle: SpanHandle = {
      traceId: active.trace.traceId,
      spanId,
      span: (childName, fn, childOptions = {}) => this.runSpan(next, childName, fn, childOptions),
      setMetadata: (extra) => this.safe(() => void Object.assign(metadata, extra)),
      setLlm: (info) =>
        this.safe(() => {
          const defined = Object.fromEntries(
            Object.entries(info).filter(([, value]) => value !== undefined),
          );
          llm = { ...llm, ...defined };
        }),
    };

    const finish = (error?: unknown) => {
      const failed = error !== undefined;
      const needsLlm = type === "llm";
      this.emit("span", {
        span_id: spanId,
        trace_id: active.trace.traceId,
        parent_span_id: active.spanId,
        type,
        name: clip(name) ?? "unnamed",
        start_time: start.toISOString(),
        end_time: new Date().toISOString(),
        status: failed ? "error" : "ok",
        error: failed ? describeError(error) : undefined,
        llm: llm || needsLlm ? mapLlm(llm ?? {}) : undefined,
        metadata: clampMetadata(metadata),
      });
    };

    return { handle, next, finish };
  }

  private endTrace(state: TraceState): void {
    this.emit("trace", {
      trace_id: state.traceId,
      name: state.name,
      start_time: state.start.toISOString(),
      end_time: new Date().toISOString(),
      user_id: state.userId,
      session_id: state.sessionId,
      metadata: clampMetadata(state.metadata),
      tags: state.tags.length > 0 ? state.tags : undefined,
    });
  }

  private cleanTags(tags: string[]): string[] {
    return tags
      .filter((tag) => typeof tag === "string" && tag.length > 0)
      .map((tag) => tag.slice(0, LIMITS.maxTagLength))
      .slice(0, LIMITS.maxTags);
  }

  /* ---------- buffering and delivery ---------- */

  private emit(eventType: ClientEvent["event_type"], data: unknown): void {
    if (!this.enabled || this.closed) return;
    const json = safeStringify({
      schema_version: SCHEMA_VERSION,
      event_id: randomUUID(),
      event_type: eventType,
      sent_at: new Date().toISOString(), // when the SDK emitted the event
      data,
    });
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_EVENT_BYTES) {
      this.counters.discarded++;
      this.report(new Error(`event of ${bytes} bytes exceeds the ${MAX_EVENT_BYTES} byte limit`));
      return;
    }
    this.buffer.push({ json, bytes });
    if (this.buffer.length >= this.cfg.flushAt) void this.flush();
  }

  private async drain(force: boolean): Promise<void> {
    while (this.buffer.length > 0) {
      const wait = this.nextAttemptAt - Date.now();
      if (!force && wait > 0) {
        if (!this.retryTimer) this.scheduleRetry(wait);
        return;
      }
      const batch = this.buffer.take(MAX_EVENTS_PER_REQUEST, MAX_BYTES_PER_REQUEST);
      const outcome = await this.send(batch);
      if (outcome.kind === "retry") {
        this.buffer.requeueFront(batch);
        this.failures++;
        this.counters.retries++;
        const delay = Math.max(
          backoffDelay(
            this.failures,
            this.cfg.retryBaseDelayMs,
            this.cfg.retryMaxDelayMs,
            this.random,
          ),
          outcome.retryAfterMs ?? 0,
        );
        this.nextAttemptAt = Date.now() + delay;
        this.scheduleRetry(delay);
        return;
      }
      this.failures = 0;
      this.nextAttemptAt = 0;
    }
  }

  private async send(batch: BufferedEvent[]): Promise<SendOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const response = await this.fetchFn!(`${this.cfg.endpoint}/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: `{"events":[${batch.map((item) => item.json).join(",")}]}`,
        signal: controller.signal,
      });
      if (response.ok) {
        this.counters.sent += batch.length;
        await this.countRejected(response);
        return { kind: "ok" };
      }
      if (response.status === 429 || response.status >= 500) {
        this.report(new Error(`ingest answered ${response.status}, will retry`));
        return {
          kind: "retry",
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), Date.now()),
        };
      }
      // Other 4xx means the data or the key is wrong. Retrying cannot fix it.
      this.counters.discarded += batch.length;
      this.report(new Error(`ingest rejected ${batch.length} events with ${response.status}`));
      return { kind: "discard" };
    } catch (error) {
      this.report(error);
      return { kind: "retry" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async countRejected(response: { json(): Promise<unknown> }): Promise<void> {
    try {
      const body = (await response.json()) as { rejected?: unknown[] };
      if (Array.isArray(body?.rejected) && body.rejected.length > 0) {
        this.counters.rejected += body.rejected.length;
        this.report(new Error(`ingest rejected ${body.rejected.length} events individually`));
      }
    } catch {
      // The body is optional. Ignore anything unreadable.
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.flush();
      },
      Math.max(1, delayMs),
    );
    this.retryTimer.unref();
  }

  /* ---------- process hooks ---------- */

  private installExitHooks(): void {
    if (typeof process === "undefined" || typeof process.once !== "function") return;
    const onBeforeExit = () => void this.shutdown();
    process.once("beforeExit", onBeforeExit);
    this.removeHooks.push(() => process.removeListener("beforeExit", onBeforeExit));

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const onSignal = () => {
        void this.shutdown().finally(() => {
          process.removeListener(signal, onSignal);
          // If nobody else handles the signal, restore the default behavior (exit).
          if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
        });
      };
      process.on(signal, onSignal);
      this.removeHooks.push(() => process.removeListener(signal, onSignal));
    }
  }

  /* ---------- never throw into the host app ---------- */

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A failing error hook must never break the host app.
    }
  }
}
