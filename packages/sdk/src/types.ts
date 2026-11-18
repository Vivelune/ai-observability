import type { Io, SpanType } from "@ai-observability/schema";

// Core types come straight from the contract schema, so SDK and server can never drift apart.
export type {
  ClientEvent,
  EvalResultData,
  IngestResponse,
  Io,
  Message,
  SpanData,
  SpanType,
  TraceData,
} from "@ai-observability/schema";

/** The slice of `fetch` the SDK needs. Global `fetch` satisfies it; tests pass a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface ObserveOptions {
  apiKey: string;
  /** Base URL of the ingest API, e.g. http://localhost:3001 */
  endpoint: string;
  /** Flush when this many events are buffered. Default 100. */
  flushAt?: number;
  /** Flush at least this often. Default 2000 ms. */
  flushIntervalMs?: number;
  /** Max buffered events. When full, the oldest are dropped and counted. Default 10000. */
  maxBufferSize?: number;
  /** First retry delay. Doubles per consecutive failure. Default 500 ms. */
  retryBaseDelayMs?: number;
  /** Upper bound for the retry delay. Default 30000 ms. */
  retryMaxDelayMs?: number;
  /** Abort a request after this long. Default 10000 ms. */
  requestTimeoutMs?: number;
  /** Flush on beforeExit and on SIGINT/SIGTERM. Default true. */
  exitHooks?: boolean;
  /** Set false to turn the SDK into a no-op (for example in tests). Default true. */
  enabled?: boolean;
  /** Called with internal problems. Never throws into your app, even if this hook throws. */
  onError?: (error: Error) => void;
  /** Testing hook: replace the HTTP client. */
  fetch?: FetchLike;
  /** Testing hook: replace Math.random (used for retry jitter). */
  random?: () => number;
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

export interface SpanOptions {
  type?: SpanType;
  metadata?: Record<string, unknown>;
}

export interface TraceOptions {
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  /** Start a child span. Nesting also happens automatically through obs.span(). */
  span<T>(
    name: string,
    fn: (span: SpanHandle) => T | Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
  setMetadata(metadata: Record<string, unknown>): void;
  /** Merge LLM fields. Can be called more than once (before and after the call). */
  setLlm(llm: Partial<LlmInfo>): void;
}

export interface TraceHandle {
  readonly traceId: string;
  span<T>(
    name: string,
    fn: (span: SpanHandle) => T | Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
  setUser(userId: string): void;
  setSession(sessionId: string): void;
  setMetadata(metadata: Record<string, unknown>): void;
  addTags(...tags: string[]): void;
}

export interface ObserveStats {
  /** Events waiting to be sent. */
  buffered: number;
  /** Events the server accepted (HTTP 2xx). */
  sent: number;
  /** Failed send attempts that were put back for retry. */
  retries: number;
  /** Events dropped because the buffer was full (oldest first). */
  dropped: number;
  /** Events discarded because the server answered with a non-retryable 4xx. */
  discarded: number;
  /** Events the server accepted the request for but rejected individually. */
  rejected: number;
}
