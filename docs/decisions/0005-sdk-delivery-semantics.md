# 0005. SDK delivery semantics: bounded buffer, drop oldest, at-least-once

Status: accepted (draft: rewrite in your own words)
Date: 2026-11-17

## Context

The SDK runs inside other people's applications. It must never slow them down, crash them or grow their memory without limit, even when our ingest API or the network is down for a long time. Events still matter, so short outages should not lose data.

## Decision

- Events are appended to an in-memory buffer capped at 10,000 events. Sending happens in the background.
- When the buffer is full, drop the oldest events, keep the newest, and count the drops in `stats().dropped`.
- Retry network errors, timeouts, 5xx and 429 with exponential backoff and jitter. Failed batches return to the front of the buffer. Do not retry other 4xx responses.
- Delivery is at-least-once. The server dedupes on `event_id`.
- Shutdown flushes for a bounded time. Exit hooks cover `beforeExit`, `SIGINT` and `SIGTERM`.
- Every public method catches its own errors. Problems reach the host only through an optional `onError` hook.

## Alternatives considered

- Unbounded buffer: never loses data, but a long outage can exhaust the host's memory.
- Drop newest when full: simpler, but keeps stale data and loses the most recent, most useful events.
- Persist to disk: survives crashes, but adds file-system access, permissions and cleanup to every host app.
- Retry a fixed number of times: simpler, but loses everything after one long outage.
- Exactly-once from the client: not achievable without server coordination. Idempotent `event_id` gives the same result.

## Consequences

Host apps stay safe under any failure, and recovery after an outage is automatic. The cost is bounded loss: events are lost if the outage outlasts the buffer, if the process dies hard, or after a 4xx. The drop and discard counters make that loss visible. A disk-backed queue could be added later behind the same interface.
