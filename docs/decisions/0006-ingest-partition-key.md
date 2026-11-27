# 0006. Kafka partition key for events: trace_id

Status: accepted (draft: rewrite in your own words)
Date: 2026-11-23

## Context

The ingest API publishes every event to one topic (`events`, 6 partitions). Kafka orders messages only within a partition, and a message's key decides its partition. Three things matter: all events of one trace should stay together and in order (a span is often sent twice, first as running and then as ok or error), load should spread evenly, and one huge tenant must not overload a single partition.

## Decision

Use `trace_id` as the message key for every event type (trace, span, eval_result all carry it).

## Alternatives considered

- `tenant_id`: gives per-tenant ordering, which we do not need, and creates hot partitions. One large tenant would push all its traffic through a single partition and a single consumer, while the others sit idle.
- `span_id` or `event_id`: the most even spread, but the spans of a trace land on different partitions with no ordering between them. The worker would have to cope with a span's "ok" update arriving before its "running" event.
- No key (round robin): even, but loses ordering for the same reason.
- `tenant_id` plus `trace_id`: behaves the same as `trace_id` alone, because trace ids are random UUIDs.

## Consequences

Trace ids are random, so traffic spreads evenly across partitions, and every trace is read in order by one consumer. Consumers can scale up to the partition count. The risks are a mild hotspot if a single trace is enormous, and that the partition count cannot be changed later without remapping keys, so we picked it up front. Ordering is by arrival at the broker, not by emission time, so the worker still uses `sent_at` to decide which version of an updated span wins. Fairness between tenants comes from the per-tenant rate limit (ADR 0007), not from partitioning.
