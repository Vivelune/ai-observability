# ai-observability

Multi-tenant ingestion -> storage -> query slice for LLM traces.

```
SDK -> ingest -> Redpanda -> worker -> ClickHouse -> query -> web
          \-> Postgres (tenants, keys)      worker -> BullMQ/Redis (evals)
```

## Layout
| Path | Purpose |
| --- | --- |
| `packages/schema` | event schema v0.1 (zod) shared by everything |
| `packages/sdk` | `@ai-observability/sdk` TypeScript SDK |
| `apps/ingest` | NestJS ingest + query API |
| `apps/worker` | Redpanda consumer, ClickHouse writer, BullMQ evals |
| `apps/web` | Next.js UI |
| `infra` | docker-compose + ClickHouse init SQL |
| `loadtest` | k6 scripts |
| `docs` | glossary and `decisions/` (ADRs) |

## Quick start (Windows PowerShell)
Requires Docker Desktop, Node LTS and pnpm.
```
pnpm install
Copy-Item .env.example .env
pnpm infra:up
pnpm infra:ps
pnpm build
pnpm lint
pnpm test
```

## Verify each service
| Service | Check |
| --- | --- |
| Redpanda | `docker exec ai-observability-redpanda rpk cluster health` -> `Healthy: true` |
| Redpanda Console | open http://localhost:8080 |
| ClickHouse | `docker exec ai-observability-clickhouse clickhouse-client -u aiobs --password aiobs_dev -q "SHOW TABLES FROM aiobs"` -> `spans` |
| Postgres | `docker exec ai-observability-postgres pg_isready -U aiobs` -> `accepting connections` |
| Redis | `docker exec ai-observability-redis redis-cli ping` -> `PONG` |

## Generate the apps
```
cd apps
nest new ingest --package-manager pnpm --skip-git
pnpm create next-app@latest web --ts --eslint --tailwind --app --src-dir --use-pnpm --import-alias "@/*"
```
Delete any nested `.git` or `pnpm-lock.yaml`, then run `pnpm install` at the root. `apps/worker` can start as a plain TypeScript project.

## Conventions
See `CONTRIBUTING.md` (branches, commits, PRs) and `docs/decisions/` (ADRs).

## ClickHouse table
`infra/clickhouse/init.sql` runs on a fresh volume only. To apply manually:
```
Get-Content infra/clickhouse/init.sql | docker exec -i ai-observability-clickhouse clickhouse-client -u aiobs --password aiobs_dev --multiquery
```
