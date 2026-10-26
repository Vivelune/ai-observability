# ai-observability
Multi-tenant AI/LLM observability platform. TypeScript SDK instruments LLM calls; ingestion pipeline (Redpanda/Kafka → ClickHouse) stores traces at 1k+ events/sec; React UI shows trace trees, prompts/completions, token cost, and async LLM-as-judge eval scores. Built as the first consumer of a field-service ERP's AI features.
