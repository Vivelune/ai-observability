# AI Observability

> Multi-tenant LLM/AI observability platform. Instrument any AI app with a 3-line SDK, ingest traces at 1k+ events/sec, and inspect prompts, completions, token cost, and eval scores in a trace-tree UI.

[![CI](https://github.com/OWNER/ai-observability/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/ai-observability/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## What this is

A **thin, production-shaped slice** of an AI observability platform — the "Datadog for LLM apps" category, scoped to what a small team can build and defend in a code review in 3 weeks.

It is **not** a general APM tool. It does not monitor servers, databases, or HTTP latency. It monitors **AI workloads**: every prompt, completion, tool call, agent step, token cost, and quality score — with tenant isolation and async evals.

The first real consumer is a sibling project: a **field-service ERP** whose AI line-item extraction feature is instrumented with this SDK. That integration is a first-class requirement, not a nice-to-have.

---

## Architecture

```mermaid
flowchart LR
    SDK[SDK<br/>TS / Python] -->|batched events| ING[Ingestion API<br/>Go / Fastify]
    ING -->|produce| K[(Redpanda / Kafka)]
    K -->|consume| W[Writer service]
    W --> CH[(ClickHouse<br/>traces + spans)]
    W --> PG[(Postgres<br/>orgs, projects, keys)]
    K -->|fan-out| EV[Eval workers<br/>BullMQ + LLM-as-judge]
    EV --> CH
    UI[Next.js dashboard] -->|query| API[Query API]
    API --> CH
    API --> PG
