# 0001. Why ClickHouse for trace storage

Status: accepted (draft: rewrite in your own words)
Date: 2026-11-04

## Context
Traces are append-heavy and read mostly as aggregates (latency, tokens, cost) and by trace_id. Volume will grow quickly and data is only useful for a limited time.

## Decision
Store spans in ClickHouse (MergeTree family), ordered by (tenant_id, trace_id, span_id), partitioned by month, with a TTL.

## Alternatives considered
- Postgres: simple, but slows on large aggregate scans and wide rows.
- Elasticsearch: strong text search, heavier to run, weaker for analytical aggregates.
- Parquet in object storage: cheap, but no low-latency queries.

## Consequences
Fast aggregates and cheap retention via TTL and partition drops. Inserts must be batched, there are no row-level updates (dedupe via ReplacingMergeTree), and the team must learn the ORDER BY trade-offs.
