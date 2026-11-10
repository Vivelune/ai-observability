# 0003. Why BullMQ over Temporal for eval jobs

Status: accepted (draft: rewrite in your own words)
Date: 2026-11-04

## Context
Evals are short background jobs per span or trace: retry on failure, limited concurrency, simple scheduling. Redis is already in the stack.

## Decision
Use BullMQ on Redis.

## Alternatives considered
- Temporal: durable multi-step workflows and strong visibility, but needs its own server and database and a bigger learning curve than the problem needs.

## Consequences
Minimal new infrastructure and fast to build. Redis durability and long multi-step workflows are weaker; if evals become long workflows, revisit this.
