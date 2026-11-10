# 0002. Why TypeScript across the stack

Status: accepted (draft: rewrite in your own words)
Date: 2026-11-04

## Context
We build an SDK, an API, a worker and a UI in three weeks, and the event schema is shared by all of them.

## Decision
Use TypeScript everywhere, with one zod schema package shared by the SDK, ingest and worker.

## Alternatives considered
- Python or Go for backend services: stronger for some data work, but a second language and no shared types with the SDK and UI.

## Consequences
One language and shared types remove a whole class of schema drift. We accept Node's weaker raw throughput and must watch event-loop blocking in ingest.
