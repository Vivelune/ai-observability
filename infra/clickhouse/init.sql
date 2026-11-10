-- Runs automatically only when the ClickHouse volume is empty (first start).
CREATE TABLE IF NOT EXISTS aiobs.spans
(
    tenant_id      String,
    trace_id       String,
    span_id        String,
    parent_span_id String,
    name           String,
    kind           LowCardinality(String),
    status         LowCardinality(String),
    model          LowCardinality(String),
    input_tokens   UInt32,
    output_tokens  UInt32,
    start_time     DateTime64(3),
    duration_ms    UInt32,
    prompt         String,
    completion     String,
    error          String,
    metadata       String,
    ingested_at    DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(start_time)
ORDER BY (tenant_id, trace_id, span_id)
TTL toDateTime(start_time) + INTERVAL 30 DAY;
