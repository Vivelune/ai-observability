import type { ClientEvent } from "@ai-observability/schema";
import { IngestBatchSchema } from "@ai-observability/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBuffer } from "./buffer";
import { Observe, wrapOpenAI, type FetchLike, type ObserveOptions } from "./index";
import { backoffDelay, parseRetryAfter } from "./retry";

/* ---------- helpers ---------- */

type Init = Parameters<FetchLike>[1];

/** A fake ingest API. It validates every batch against the real contract schema. */
function fakeIngest() {
  const events: ClientEvent[] = [];
  const attempts: number[] = [];
  const state = { down: false, status: 202, headers: {} as Record<string, string> };
  const fetch = vi.fn(async (_url: string, init: Init) => {
    attempts.push(Date.now());
    if (state.down) throw new TypeError("fetch failed");
    if (state.status !== 202) {
      return {
        ok: false,
        status: state.status,
        headers: { get: (name: string) => state.headers[name.toLowerCase()] ?? null },
        json: async () => ({}),
      };
    }
    const batch = IngestBatchSchema.parse(JSON.parse(init.body));
    events.push(...batch.events);
    return {
      ok: true,
      status: 202,
      headers: { get: () => null },
      json: async () => ({ accepted: batch.events.length, rejected: [] }),
    };
  });
  return { fetch, events, attempts, state };
}

type Ingest = ReturnType<typeof fakeIngest>;

function make(ingest: Ingest, overrides: Partial<ObserveOptions> = {}) {
  return new Observe({
    apiKey: "test-key",
    endpoint: "http://ingest.test/",
    fetch: ingest.fetch,
    exitHooks: false,
    random: () => 1,
    ...overrides,
  });
}

const spansOf = (events: ClientEvent[]) =>
  events.flatMap((event) => (event.event_type === "span" ? [event.data] : []));
const tracesOf = (events: ClientEvent[]) =>
  events.flatMap((event) => (event.event_type === "trace" ? [event.data] : []));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ---------- pure pieces ---------- */

describe("backoffDelay", () => {
  it("doubles per failure and respects the cap", () => {
    expect(backoffDelay(1, 100, 10_000, () => 1)).toBe(100);
    expect(backoffDelay(2, 100, 10_000, () => 1)).toBe(200);
    expect(backoffDelay(3, 100, 10_000, () => 1)).toBe(400);
    expect(backoffDelay(20, 100, 10_000, () => 1)).toBe(10_000);
  });

  it("jitters between half and the full ceiling", () => {
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(200);
    expect(backoffDelay(3, 100, 10_000, () => 1)).toBe(400);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("2", 0)).toBe(2000);
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter(new Date(5000).toUTCString(), 1000)).toBe(4000);
  });
});

describe("EventBuffer", () => {
  const item = (n: number) => ({ json: String(n), bytes: 1 });

  it("drops the oldest events when full and counts them", () => {
    const buffer = new EventBuffer(3);
    [1, 2, 3, 4, 5].forEach((n) => buffer.push(item(n)));
    expect(buffer.dropped).toBe(2);
    expect(buffer.take(10, 100).map((e) => e.json)).toEqual(["3", "4", "5"]);
  });

  it("requeues failed batches at the front in order", () => {
    const buffer = new EventBuffer(10);
    buffer.push(item(3));
    buffer.requeueFront([item(1), item(2)]);
    expect(buffer.take(10, 100).map((e) => e.json)).toEqual(["1", "2", "3"]);
  });

  it("limits a batch by bytes but always takes at least one event", () => {
    const buffer = new EventBuffer(10);
    buffer.push({ json: "a", bytes: 50 });
    buffer.push({ json: "b", bytes: 50 });
    expect(buffer.take(10, 10)).toHaveLength(1);
    expect(buffer.take(10, 60)).toHaveLength(1);
  });
});

/* ---------- batching ---------- */

describe("batching", () => {
  it("flushes when flushAt events are buffered", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest, { flushAt: 3, flushIntervalMs: 1_000_000 });
    await obs.trace("a", async () => {});
    await obs.trace("b", async () => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(ingest.fetch).not.toHaveBeenCalled();
    await obs.trace("c", async () => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(ingest.fetch).toHaveBeenCalledTimes(1);
    expect(ingest.events).toHaveLength(3);
  });

  it("flushes on the interval when the batch is not full", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest, { flushAt: 100, flushIntervalMs: 2000 });
    await obs.trace("a", async () => {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(ingest.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(ingest.events).toHaveLength(1);
  });

  it("posts to /v1/events with the API key", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    await obs.trace("a", async () => {});
    await obs.flush();
    expect(ingest.fetch.mock.calls[0][0]).toBe("http://ingest.test/v1/events");
    expect(ingest.fetch.mock.calls[0][1].headers.authorization).toBe("Bearer test-key");
  });
});

/* ---------- trace and span API ---------- */

describe("nesting", () => {
  it("links nested spans to their parent automatically", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    await obs.trace("outer", async () => {
      await obs.span("a", async () => {
        await obs.span("b", async () => {});
      });
      await obs.span("c", async () => {});
    });
    await obs.flush();

    const [trace] = tracesOf(ingest.events);
    const byName = Object.fromEntries(spansOf(ingest.events).map((s) => [s.name, s]));
    expect(byName.b.parent_span_id).toBe(byName.a.span_id);
    expect(byName.a.parent_span_id).toBeUndefined();
    expect(byName.c.parent_span_id).toBeUndefined();
    for (const span of Object.values(byName)) expect(span.trace_id).toBe(trace.trace_id);
  });

  it("keeps concurrent traces separate", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    await Promise.all(
      ["x", "y"].map((name) =>
        obs.trace(name, async () => {
          await Promise.resolve();
          await obs.span(`${name}-child`, async () => {
            await Promise.resolve();
          });
        }),
      ),
    );
    await obs.flush();
    const traces = Object.fromEntries(tracesOf(ingest.events).map((t) => [t.name, t.trace_id]));
    const spans = Object.fromEntries(spansOf(ingest.events).map((s) => [s.name, s.trace_id]));
    expect(spans["x-child"]).toBe(traces.x);
    expect(spans["y-child"]).toBe(traces.y);
    expect(traces.x).not.toBe(traces.y);
  });

  it("supports explicit handles, trace options and llm fields", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    await obs.trace(
      "invoice-extract",
      async (t) => {
        t.setSession("sess-1");
        t.addTags("beta");
        await t.span(
          "call",
          async (s) => {
            s.setLlm({ model: "m", provider: "p", input: "hi" });
            s.setLlm({ output: "yo", inputTokens: 3, outputTokens: 2 });
          },
          { type: "llm" },
        );
      },
      { userId: "u1", tags: ["prod"], metadata: { app: "demo" } },
    );
    await obs.flush();
    const [trace] = tracesOf(ingest.events);
    expect(trace).toMatchObject({ user_id: "u1", session_id: "sess-1", tags: ["prod", "beta"] });
    expect(trace.metadata).toEqual({ app: "demo" });
    expect(spansOf(ingest.events)[0].llm).toMatchObject({
      model: "m",
      provider: "p",
      input: "hi",
      output: "yo",
      input_tokens: 3,
      output_tokens: 2,
    });
  });

  it("starts an implicit trace when span() is called outside one", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    expect(await obs.span("solo", async () => "done")).toBe("done");
    await obs.flush();
    expect(tracesOf(ingest.events)).toHaveLength(1);
    expect(spansOf(ingest.events)[0].trace_id).toBe(tracesOf(ingest.events)[0].trace_id);
  });

  it("records errors and rethrows the original error", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    const boom = new Error("boom");
    await expect(
      obs.trace("fail", async (t) => {
        await t.span("inner", async () => {
          throw boom;
        });
      }),
    ).rejects.toBe(boom);
    await obs.flush();
    expect(spansOf(ingest.events)[0]).toMatchObject({
      status: "error",
      error: { type: "Error", message: "boom" },
    });
    expect(tracesOf(ingest.events)[0].metadata).toMatchObject({ error: { message: "boom" } });
  });

  it("truncates large llm input and flags it", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    await obs.span(
      "big",
      async (s) => {
        s.setLlm({ model: "m", provider: "p", input: "x".repeat(200 * 1024) });
      },
      { type: "llm" },
    );
    await obs.flush();
    const llm = spansOf(ingest.events)[0].llm!;
    expect((llm.input as string).length).toBeLessThanOrEqual(100 * 1024);
    expect(llm.io_truncated).toBe(true);
  });
});

/* ---------- never crash the host ---------- */

describe("non-blocking and safe", () => {
  it("returns your result even when the network is down", async () => {
    const ingest = fakeIngest();
    ingest.state.down = true;
    const obs = make(ingest, { flushAt: 1 });
    expect(await obs.trace("x", async () => 42)).toBe(42);
  });

  it("survives an onError hook that throws", async () => {
    const ingest = fakeIngest();
    ingest.state.down = true;
    const obs = make(ingest, {
      flushAt: 1,
      onError: () => {
        throw new Error("bad hook");
      },
    });
    expect(await obs.trace("x", async () => "ok")).toBe("ok");
    await vi.advanceTimersByTimeAsync(10);
  });

  it("handles circular and BigInt metadata", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    const circular: Record<string, unknown> = { big: BigInt(5) };
    circular.self = circular;
    await obs.trace("c", async (t) => {
      t.setMetadata(circular);
    });
    await obs.flush();
    expect(ingest.events).toHaveLength(1);
  });

  it("is a harmless no-op when misconfigured", async () => {
    const ingest = fakeIngest();
    const errors: string[] = [];
    const obs = new Observe({
      endpoint: "http://x",
      fetch: ingest.fetch,
      onError: (e) => errors.push(e.message),
    } as ObserveOptions);
    expect(await obs.trace("x", async () => 7)).toBe(7);
    await obs.flush();
    expect(ingest.fetch).not.toHaveBeenCalled();
    expect(errors[0]).toContain("disabled");
  });
});

/* ---------- retry ---------- */

describe("retry", () => {
  it("backs off exponentially on 5xx and then delivers", async () => {
    const ingest = fakeIngest();
    ingest.state.status = 500;
    const obs = make(ingest, {
      flushAt: 1,
      flushIntervalMs: 1_000_000,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 10_000,
    });
    await obs.trace("t", async () => {});
    await vi.advanceTimersByTimeAsync(1000);
    const gaps = ingest.attempts.slice(1).map((time, i) => time - ingest.attempts[i]);
    expect(gaps).toEqual([100, 200, 400]);
    expect(obs.stats().retries).toBe(4);

    ingest.state.status = 202;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ingest.events).toHaveLength(1);
    expect(obs.stats()).toMatchObject({ buffered: 0, sent: 1 });
  });

  it("retries network errors", async () => {
    const ingest = fakeIngest();
    ingest.state.down = true;
    const obs = make(ingest, { flushAt: 1, retryBaseDelayMs: 100 });
    await obs.trace("t", async () => {});
    await vi.advanceTimersByTimeAsync(300);
    ingest.state.down = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ingest.events).toHaveLength(1);
  });

  it("does not retry other 4xx and counts the discarded events", async () => {
    const ingest = fakeIngest();
    ingest.state.status = 400;
    const errors: string[] = [];
    const obs = make(ingest, { flushAt: 1, onError: (e) => errors.push(e.message) });
    await obs.trace("t", async () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingest.attempts).toHaveLength(1);
    expect(obs.stats()).toMatchObject({ buffered: 0, discarded: 1, sent: 0 });
    expect(errors.join(" ")).toContain("400");
  });

  it("retries 429 and honors Retry-After", async () => {
    const ingest = fakeIngest();
    ingest.state.status = 429;
    ingest.state.headers["retry-after"] = "2";
    const obs = make(ingest, { flushAt: 1, flushIntervalMs: 1_000_000, retryBaseDelayMs: 100 });
    await obs.trace("t", async () => {});
    await vi.advanceTimersByTimeAsync(1500);
    expect(ingest.attempts).toHaveLength(1);
    ingest.state.status = 202;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ingest.events).toHaveLength(1);
  });
});

/* ---------- backpressure ---------- */

describe("buffer overflow", () => {
  it("drops the oldest events, counts them, and delivers the newest", async () => {
    const ingest = fakeIngest();
    ingest.state.down = true;
    const obs = make(ingest, { flushAt: 1, maxBufferSize: 5, retryBaseDelayMs: 100 });
    for (let i = 0; i < 8; i++) await obs.trace(`t${i}`, async () => {});
    expect(obs.stats()).toMatchObject({ buffered: 5, dropped: 3 });

    ingest.state.down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tracesOf(ingest.events).map((t) => t.name)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
    expect(obs.stats()).toMatchObject({ buffered: 0, dropped: 3, sent: 5 });
  });
});

/* ---------- the acceptance scenario ---------- */

describe("network down then recovered", () => {
  it("delivers all 50 events after the network comes back", async () => {
    const ingest = fakeIngest();
    ingest.state.down = true;
    const obs = make(ingest, { flushAt: 10, retryBaseDelayMs: 100, retryMaxDelayMs: 5000 });

    for (let i = 1; i <= 50; i++) {
      await obs.trace(`call-${i}`, async () => {});
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(ingest.events).toHaveLength(0);
    expect(obs.stats().buffered).toBe(50);

    ingest.state.down = false;
    await vi.advanceTimersByTimeAsync(30_000);

    const names = tracesOf(ingest.events).map((t) => t.name);
    expect(names).toHaveLength(50);
    expect(new Set(names).size).toBe(50);
    expect(new Set(ingest.events.map((e) => e.event_id)).size).toBe(50);
    expect(obs.stats()).toMatchObject({ buffered: 0, dropped: 0, sent: 50 });
  });
});

/* ---------- shutdown ---------- */

describe("shutdown", () => {
  it("flushes what is buffered", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest, { flushAt: 100, flushIntervalMs: 1_000_000 });
    for (let i = 0; i < 3; i++) await obs.trace(`t${i}`, async () => {});
    const stats = await obs.shutdown();
    expect(ingest.events).toHaveLength(3);
    expect(stats).toMatchObject({ buffered: 0, sent: 3 });
  });

  it("gives up after the timeout when the network stays down", async () => {
    const ingest = fakeIngest();
    ingest.state.down = true;
    const obs = make(ingest, { flushAt: 100 });
    await obs.trace("t", async () => {});
    const pending = obs.shutdown(1000);
    await vi.advanceTimersByTimeAsync(1500);
    const stats = await pending;
    expect(stats.buffered).toBe(1);
  });

  it("delivers during shutdown if the network recovers in time", async () => {
    const ingest = fakeIngest();
    ingest.state.down = true;
    const obs = make(ingest, { flushAt: 100 });
    await obs.trace("t", async () => {});
    const pending = obs.shutdown(5000);
    await vi.advanceTimersByTimeAsync(600);
    ingest.state.down = false;
    await vi.advanceTimersByTimeAsync(600);
    expect((await pending).sent).toBe(1);
  });

  it("stops recording after shutdown but still runs your code", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    await obs.shutdown();
    expect(await obs.trace("late", async () => "fine")).toBe("fine");
    expect(obs.stats().buffered).toBe(0);
  });

  it("installs exit hooks and removes them on shutdown", async () => {
    const ingest = fakeIngest();
    const before = process.listenerCount("beforeExit");
    const obs = new Observe({ apiKey: "k", endpoint: "http://x", fetch: ingest.fetch });
    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    await obs.shutdown();
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});

/* ---------- OpenAI wrapper ---------- */

describe("wrapOpenAI", () => {
  const response = {
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ message: { role: "assistant", content: "Paris" } }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  };

  function fakeClient(create = vi.fn(async (_params: unknown) => response)) {
    return { chat: { completions: { create } }, models: { list: () => "models" } };
  }

  it("captures model, input, output, tokens and timing, and returns the response untouched", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    const client = fakeClient();
    const wrapped = wrapOpenAI(client, obs);

    const result = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Capital of France?" },
      ],
    });
    await obs.flush();

    expect(result).toBe(response);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    const [span] = spansOf(ingest.events);
    expect(span.type).toBe("llm");
    expect(span.llm).toMatchObject({
      model: "gpt-4o-mini-2024-07-18",
      provider: "openai",
      output: "Paris",
      input_tokens: 12,
      output_tokens: 3,
      parameters: { temperature: 0.2 },
    });
    expect(span.llm?.input).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Capital of France?" },
    ]);
    expect(Date.parse(span.end_time!)).toBeGreaterThanOrEqual(Date.parse(span.start_time));
  });

  it("nests inside the active trace", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    const wrapped = wrapOpenAI(fakeClient(), obs);
    await obs.trace("rag", async () => {
      await wrapped.chat.completions.create({ model: "m", messages: [] });
    });
    await obs.flush();
    expect(spansOf(ingest.events)[0].trace_id).toBe(tracesOf(ingest.events)[0].trace_id);
  });

  it("records a valid llm span and rethrows when the API call fails", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    const failure = new Error("rate limited");
    const wrapped = wrapOpenAI(fakeClient(vi.fn(async () => Promise.reject(failure))), obs);
    await expect(wrapped.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
      failure,
    );
    await obs.flush();
    const [span] = spansOf(ingest.events);
    expect(span).toMatchObject({ status: "error", error: { message: "rate limited" } });
    expect(span.llm).toMatchObject({ model: "gpt-4o", provider: "openai" });
  });

  it("passes streaming calls through untouched", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    const stream = { async *[Symbol.asyncIterator]() {} };
    const wrapped = wrapOpenAI(fakeClient(vi.fn(async () => stream as never)), obs);
    expect(await wrapped.chat.completions.create({ model: "m", stream: true })).toBe(stream);
    await obs.flush();
    expect(ingest.events).toHaveLength(0);
  });

  it("leaves the rest of the client working and tolerates odd responses", async () => {
    const ingest = fakeIngest();
    const obs = make(ingest);
    const wrapped = wrapOpenAI(fakeClient(vi.fn(async () => null as never)), obs);
    expect(wrapped.models.list()).toBe("models");
    expect(await wrapped.chat.completions.create({ model: "m", messages: [] })).toBeNull();
    await obs.flush();
    expect(spansOf(ingest.events)[0].llm?.model).toBe("m");
  });
});
