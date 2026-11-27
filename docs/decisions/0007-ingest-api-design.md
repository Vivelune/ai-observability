# 0007. Ingest API design: auth, acknowledgement and rate limiting

Status: accepted (draft: rewrite in your own words)
Date: 2026-11-23

## Context

The ingest API is the only door into the platform. It must identify the tenant safely from day one, answer quickly, never claim to have stored data it has not, and stop one tenant from starving the others.

## Decision

- **Auth:** `Authorization: Bearer <key>`. Keys are random 256-bit secrets. Only their SHA-256 hash is stored in Postgres, next to the tenant id. Auth runs before the body is parsed, and lookups are cached in memory (60 s for valid keys, 10 s for unknown ones).
- **Tenant:** always taken from the key, never from the payload.
- **Validation:** per event. A batch with some bad events gets `202` with a `rejected` list (index, event_id, code, message). Only a malformed request as a whole gets `400`.
- **Acknowledgement:** the API produces to Redpanda with `acks=all` and returns `202` only after the broker confirms. If the broker is unavailable it returns `503`, so the SDK retries the whole batch. It never writes to ClickHouse.
- **Rate limit:** an in-memory token bucket per tenant, charged per event (default 500 events per second sustained, burst 5,000). Over the limit returns `429` with `Retry-After`.
- **Observability:** one structured JSON log line per request (request id, tenant, status, duration, counts) and a `/health` endpoint that checks Postgres and Redpanda.

## Alternatives considered

- bcrypt or argon2 for keys: built for human passwords, and they would add tens of milliseconds to every request, with no security gain for 256-bit random keys.
- JWT: no database lookup, but keys cannot be revoked instantly and there is no natural place to store them.
- Return `202` before producing: faster, but a crash would silently lose events that the client believes were stored.
- Reject the whole batch if any event is invalid: simpler, but one bad event would block good ones, and the SDK would discard the batch on a 4xx.
- A Redis-backed rate limiter: correct across several API instances, but an extra dependency and round trip on every request.

## Consequences

Keys can be revoked in the database, taking effect within the cache TTL. Authentication cannot be bypassed by a crafted payload. A `202` means the events are durable in the broker. The rate limit is per API instance, so running N instances multiplies the effective limit by N until it moves to Redis. Events may be produced twice if a retry follows a partial failure, so deduplication on `event_id` happens downstream in the worker.
