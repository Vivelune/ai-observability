# @ai-observability/sdk

Trace your LLM app in three lines. Node 18+.

```ts
import { Observe } from "@ai-observability/sdk";

const obs = new Observe({ apiKey: "...", endpoint: "http://localhost:3001" });
const result = await obs.trace("invoice-extract", async (t) => {
  return obs.span("parse", async () => parse(invoice)); // nests automatically
});
```

## API

```ts
// A trace groups spans. Your return value (or thrown error) always comes back unchanged.
await obs.trace("name", async (t) => { ... }, { userId, sessionId, metadata, tags });

// Spans find their parent automatically (AsyncLocalStorage). t.span() works too.
await obs.span("retrieve docs", async (s) => { s.setMetadata({ top_k: 5 }); }, { type: "retrieval" });

// LLM spans: set the fields before and/or after the call. They merge.
await obs.span("answer", async (s) => {
  s.setLlm({ model: "gpt-4o-mini", provider: "openai", input: messages });
  const res = await callModel();
  s.setLlm({ output: res.text, inputTokens: res.in, outputTokens: res.out });
}, { type: "llm" });

obs.stats();            // { buffered, sent, retries, dropped, discarded, rejected }
await obs.flush();      // send now
await obs.shutdown();   // flush and stop (default 5 s)
```

Calling `obs.span()` outside a trace starts an implicit trace with the same name.

### OpenAI helper

```ts
import OpenAI from "openai";
import { wrapOpenAI } from "@ai-observability/sdk";

const openai = wrapOpenAI(new OpenAI(), obs);
await openai.chat.completions.create({ model: "gpt-4o-mini", messages }); // traced as an llm span
```

It captures model, messages, output, token usage, selected parameters and latency, and nests under
the active trace. v0 limits: streaming calls pass through **untraced**, and the wrapped call returns
a plain Promise (no `.withResponse()`).

## Options

| Option               | Default  | Meaning                                                   |
| -------------------- | -------- | --------------------------------------------------------- |
| `apiKey`, `endpoint` | required | Without both, the SDK is a harmless no-op.                |
| `flushAt`            | 100      | Flush when this many events are buffered.                 |
| `flushIntervalMs`    | 2000     | Flush at least this often.                                |
| `maxBufferSize`      | 10000    | Buffer cap (see backpressure).                            |
| `retryBaseDelayMs`   | 500      | First retry delay, doubles per consecutive failure.       |
| `retryMaxDelayMs`    | 30000    | Retry delay ceiling.                                      |
| `requestTimeoutMs`   | 10000    | Abort a request after this long.                          |
| `exitHooks`          | true     | Flush on `beforeExit`, `SIGINT`, `SIGTERM`.               |
| `enabled`            | true     | `false` turns everything into a no-op.                    |
| `onError(error)`     | none     | Hear about internal problems. Your hook may throw safely. |

## Behavior you can rely on

- **Never blocks or crashes your app.** Recording an event only appends to memory. Sending happens in
  the background. Every internal step is wrapped in try/catch, errors only reach `onError`, and your
  own errors pass through unchanged.
- **Batching.** A batch goes out when `flushAt` events are buffered or `flushIntervalMs` passes. A
  request holds at most 500 events and about 4 MB.
- **Retry.** Network errors, timeouts, `5xx` and `429` are retried with exponential backoff and jitter
  (`Retry-After` is honored). Failed batches go back to the front of the buffer, so order is kept and
  nothing is lost while the buffer has room. Other `4xx` responses (bad data or a bad key) are **not**
  retried: those events are discarded and counted in `stats().discarded`.
- **Backpressure.** The buffer holds at most `maxBufferSize` events. When it is full, the **oldest**
  events are dropped to make room for new ones, and the number is counted in `stats().dropped`. This
  keeps memory bounded when the network is down for a long time. Raise `maxBufferSize` if you need more
  headroom.
- **Delivery is at-least-once.** A retry may resend events the server already stored. Every event has
  an `event_id`, and the server ignores duplicates.
- **Shutdown.** `await obs.shutdown()` stops accepting events and tries to deliver the buffer for up to
  the timeout. Anything still buffered after that is lost. Exit hooks call it on `beforeExit` and on
  `SIGINT`/`SIGTERM` (after which the default signal behavior is restored). A hard `process.exit()` or
  a crash skips the hooks. Call `await obs.shutdown()` yourself before exiting in serverless code.
- **Size limits.** LLM `input` and `output` over 100 KB are truncated and flagged `io_truncated`.
  Metadata over 16 KB is replaced by a marker. A single event over 1 MB is discarded.

## Try the unplug test

You need two terminals in the repo root (after `pnpm install` and `pnpm build`).

```
# terminal 1: stand-in ingest API
node packages/sdk/examples/mock-ingest.mjs

# terminal 2: 50 traced calls, one every ~0.4 s
node packages/sdk/examples/demo.mjs
```

While the demo runs, type `down` and Enter in terminal 1. The demo keeps making calls and the SDK
keeps buffering and retrying. When the demo says it is waiting for delivery, type `up` and Enter.
Terminal 1 should end at `traces 50` (and `spans 50`), and the demo prints its final stats.
