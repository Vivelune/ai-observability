# apps/ingest

The ingest API. It authenticates, validates, publishes to Redpanda and answers `202`. It never
writes to ClickHouse.

```
SDK -> POST /v1/events -> auth (Postgres) -> rate limit -> validate -> Redpanda topic "events"
```

## Run it (Windows PowerShell, from the repo root)

```
pnpm install
pnpm build
pnpm infra:up                                            # Redpanda, Postgres, ...
pnpm db:migrate                                          # creates the tenants and api_keys tables
pnpm --filter @ai-observability/ingest db:create-key acme   # prints an API key ONCE
pnpm ingest:start                                        # listens on http://localhost:3001
```

The API creates the `events` topic (6 partitions) on startup if it does not exist.
Settings come from `.env` (see `.env.example`); every one has a default.

## Troubleshooting

- **`port is already allocated` for Postgres (5432) or Redis (6379):** another program or container
  already uses the port. Find it with `docker ps` and `Get-NetTCPConnection -LocalPort 5432`.
  Either stop it, or move ours: set `POSTGRES_PORT=5433` in `.env`, change `DATABASE_URL` to use
  `:5433`, and run `pnpm infra:down` then `pnpm infra:up`.
- **kafkajs `Connection timeout` or `CreateTopics timed out`:** Redpanda is slow to answer. Wait for
  it to be `healthy` in `pnpm infra:ps`, then raise `KAFKA_CONNECTION_TIMEOUT_MS` and
  `KAFKA_REQUEST_TIMEOUT_MS` in `.env`. The `TimeoutNegativeWarning` lines are harmless.

## Try it

```
curl.exe -i -X POST http://localhost:3001/v1/events -H "Authorization: Bearer <your key>" -H "Content-Type: application/json" --data-binary "@docs/examples/01-rag-trace.json"
curl.exe -i -X POST http://localhost:3001/v1/events -H "Authorization: Bearer wrong" --data-binary "@docs/examples/01-rag-trace.json"
```

The first returns `202 {"accepted":3,"rejected":[]}`, the second `401`. See the messages in the topic:

```
docker exec ai-observability-redpanda rpk topic consume events -o start -n 3 -f "key=%k value=%v\n"
```

Or use the helper: `node apps/ingest/scripts/send-sample.mjs <your key>`.

## API

`POST /v1/events` with `Authorization: Bearer <key>` and body `{"events": [...]}` (see
`docs/sdk-contract.md`).

| Status | When                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| 202    | Batch received. `accepted` events are in the broker. Check `rejected` for the rest. |
| 400    | Body is not JSON, has no `events`, is empty, or has more than 500 events.           |
| 401    | Missing, malformed, unknown or revoked key.                                         |
| 413    | Body over 5 MB.                                                                     |
| 429    | Tenant over its rate limit. Retry after the `Retry-After` seconds.                  |
| 503    | Redpanda or Postgres unavailable. Nothing was stored. Retry the whole batch.        |

Per-event rejection codes: `invalid_event`, `unknown_event_type`, `unsupported_schema_version`.
Errors always look like `{"error": {"code": "...", "message": "..."}}`.

`GET /health` returns `200` or `503` with `{"status", "checks": {"postgres", "kafka"}}`.

## What gets published

One message per accepted event on topic `events`:

- **key:** the event's `trace_id` (all events of a trace share a partition and stay ordered, see ADR 0006)
- **value:** the validated event plus `tenant_id` (from the API key) and `received_at`
- **headers:** `tenant_id`, `event_type`

## Behavior to know

- The tenant always comes from the API key. A `tenant_id` sent by a client is discarded.
- Only the SHA-256 hash of a key is stored. Key lookups are cached for 60 s, so a revoked key can
  keep working for up to a minute.
- Rate limiting is a per-tenant token bucket charged per event (default 500 events/s, burst 5,000).
  It is in memory, so with several API instances the effective limit is multiplied.
- `202` is sent only after Redpanda confirms the write (`acks=all`). Large batches are produced in
  chunks, so a failure part-way can lead to the SDK resending events. Duplicates are removed
  downstream by `event_id`.
- Logs are one JSON line per request. Keys and event contents are never logged.

## Keys

```
pnpm --filter @ai-observability/ingest db:create-key <tenant name>   # new key for a tenant
pnpm --filter @ai-observability/ingest db:revoke-key <key prefix>    # e.g. aiobs_AbCd12
```

## Tests

`pnpm test` runs everything with fakes, including real HTTP through the production pipeline and
the real SDK talking to the API. To also run the Postgres tests:
`$env:TEST_DATABASE_URL="postgres://aiobs:aiobs_dev@localhost:5432/aiobs"; pnpm test`.
