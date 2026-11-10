# SDK contract v0.1

Status: **draft, waiting for Team B sign-off** · Version: `0.1` · Owner: Team A · Reviewer: Team B

This is the agreement between the SDK (and any emitter Team B writes) and the ingest API. The source of truth is the zod schema in `packages/schema/src/index.ts`. A JSON Schema copy is in `docs/sdk-contract.schema.json`, and runnable examples are in `docs/examples/`. All field names are `snake_case`.

## 1. Transport

`POST {ingest_url}/v1/events` with headers `Authorization: Bearer <api_key>` and `Content-Type: application/json`.

Body: `{ "events": [ ... ] }` with 1 to 500 events and at most 5 MB.

| Status | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| 202    | Batch received. Check `rejected` in the body, because some events may be bad. |
| 400    | Body is not JSON, has no `events`, or has more than 500 events.               |
| 401    | Missing or invalid API key.                                                   |
| 413    | Body over 5 MB.                                                               |
| 429    | Rate limited. Retry after the `Retry-After` header.                           |
| 5xx    | Server problem. Retry with backoff (same `event_id`s).                        |

202 response: `{ "accepted": 2, "rejected": [ { "index": 1, "event_id": "...", "code": "invalid_event", "message": "..." } ] }`. Codes: `invalid_event`, `unknown_event_type`, `unsupported_schema_version`. Each event is validated on its own, so one bad event never rejects the rest.

## 2. Event envelope

Every event has these fields, plus `data` holding the entity.

| Field            | Type      | Notes                                                                        |
| ---------------- | --------- | ---------------------------------------------------------------------------- |
| `schema_version` | string    | `"MAJOR.MINOR"`, currently `"0.1"`.                                          |
| `event_id`       | UUID      | Client-generated. Idempotency key: the server ignores a repeated `event_id`. |
| `event_type`     | string    | `trace`, `span` or `eval_result`.                                            |
| `sent_at`        | timestamp | When the SDK sent it (UTC).                                                  |
| `data`           | object    | The entity below, matching `event_type`.                                     |
| `tenant_id`      | not sent  | Derived server-side from the API key. If a client sends it, it is dropped.   |

## 3. Entities

### trace (`event_type: "trace"`)

| Field        | Type          | Required | Notes                              |
| ------------ | ------------- | -------- | ---------------------------------- |
| `trace_id`   | UUID          | yes      | Client-generated.                  |
| `name`       | string, 1-256 | yes      |                                    |
| `start_time` | timestamp     | yes      |                                    |
| `end_time`   | timestamp     | no       | Not before `start_time`.           |
| `user_id`    | string        | no       | Your end user.                     |
| `session_id` | string        | no       | Groups traces in one conversation. |
| `metadata`   | object        | no       | At most 16 KB of JSON.             |
| `tags`       | string[]      | no       | Up to 20 tags, 64 characters each. |

### span (`event_type: "span"`)

| Field            | Type                                  | Required | Notes                                                           |
| ---------------- | ------------------------------------- | -------- | --------------------------------------------------------------- |
| `span_id`        | UUID                                  | yes      | Client-generated.                                               |
| `trace_id`       | UUID                                  | yes      | The trace may not exist yet or may arrive later.                |
| `parent_span_id` | UUID                                  | no       | Absent means a root span.                                       |
| `type`           | `llm`, `retrieval`, `tool`, `generic` | yes      |                                                                 |
| `name`           | string, 1-256                         | yes      |                                                                 |
| `start_time`     | timestamp                             | yes      |                                                                 |
| `end_time`       | timestamp                             | see rule | Required unless `status` is `running`. Not before `start_time`. |
| `status`         | `running`, `ok`, `error`              | yes      | `running` must not have `end_time`.                             |
| `error`          | `{ type, message, stack? }`           | no       | Only when `status` is `error`.                                  |
| `llm`            | object                                | see rule | Required when `type` is `llm`, forbidden otherwise.             |
| `metadata`       | object                                | no       | At most 16 KB of JSON.                                          |

`llm` fields: `model` and `provider` (required strings), `input` and `output` (a string or an array of `{ role, content }` messages, where role is `system`, `user`, `assistant` or `tool`), `input_tokens`, `output_tokens` (non-negative integers), `parameters` (object), `io_truncated` (boolean, true if the SDK truncated input or output).

### eval_result (`event_type: "eval_result"`)

| Field         | Type       | Required | Notes                              |
| ------------- | ---------- | -------- | ---------------------------------- |
| `eval_id`     | UUID       | yes      | Client-generated.                  |
| `trace_id`    | UUID       | yes      |                                    |
| `span_id`     | UUID       | no       | Set when the eval scores one span. |
| `name`        | string     | yes      | For example `answer-relevance`.    |
| `score`       | number 0-1 | yes      | Normalized, 1 is best.             |
| `reasoning`   | string     | no       | The judge's explanation.           |
| `judge_model` | string     | no       |                                    |

## 4. Rules

1. **Timestamps:** ISO-8601 in UTC with a `Z` suffix and millisecond precision, such as `2026-11-10T09:15:00.000Z`. Offsets like `+02:00` and epoch numbers are rejected.
2. **IDs:** all IDs are UUIDs generated by the client (v4 or v7). Because the client creates them, a span can be sent before its parent trace or parent span has finished, in any order.
3. **Idempotency and updates:** a repeated `event_id` is ignored. To update a span, for example from `running` to `ok` or `error`, send a new event with the same `span_id` and a new `event_id`. The version with the latest `sent_at` wins. Traces and eval results work the same way with `trace_id` and `eval_id`.
4. **Tenant:** `tenant_id` comes from the API key and is never trusted from the client.
5. **Cost:** the SDK never sends cost. The server computes it from a pricing table keyed by `provider`, `model` and a validity date, applied to `input_tokens` and `output_tokens`. The worker stores the cost with the pricing version used, and a recompute job fixes history when a price is wrong, so no SDK release is needed.
6. **Size limits:**

   | Item                            | Limit                                                                                                                                                           |
   | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Events per batch                | 500                                                                                                                                                             |
   | Request body                    | 5 MB                                                                                                                                                            |
   | `llm.input`, `llm.output`       | 100 KB each. Longer values are truncated, never rejected, and `io_truncated` is set to true. The SDK truncates before sending and the server enforces it again. |
   | `metadata`                      | 16 KB of JSON                                                                                                                                                   |
   | `name`, `user_id`, `session_id` | 256 characters                                                                                                                                                  |
   | `tags`                          | 20 tags, 64 characters each                                                                                                                                     |

7. **Delivery:** at-least-once. The SDK retries network errors, 429 and 5xx with the same `event_id`s, and the server dedupes.

## 5. Versioning

- `schema_version` is `MAJOR.MINOR`.
- **Minor bump (0.1 to 0.2):** additive only, meaning new optional fields or new event types. Servers ignore unknown fields (tolerant reader), so an old SDK keeps working against a newer server, and a newer SDK keeps working against an older server for the fields it knows.
- **Major bump:** anything breaking, such as removing or renaming a field, changing a type, or making an optional field required. The server accepts the current and the previous major version for at least 8 weeks after a new major ships.
- While the major version is 0, the server accepts any `0.x`. Breaking changes are still announced to Team B first and recorded in this file's changelog.
- An unsupported major version is rejected per event with `unsupported_schema_version`. An unknown `event_type` is rejected with `unknown_event_type`.
- Fields are never removed or repurposed within a major version. Deprecations are announced here first.

## 6. Examples

- `docs/examples/01-rag-trace.json`: a retrieval span, an llm span with messages and tokens, and the trace.
- `docs/examples/02-running-then-error.json`: one tool span sent as `running`, then updated to `error`.
- `docs/examples/03-eval-result.json`: an eval score for an llm span.

## 7. Questions for Team B

1. Can you generate UUIDs on the client (v4 or v7)?
2. Can you send spans at start (`status: running`) and update them at the end, or only at the end?
3. Are your LLM inputs strings, message arrays, or both? Both are supported.
4. Do you need span types beyond `llm`, `retrieval`, `tool` and `generic`?
5. Can you emit `user_id` and `session_id`, and is 256 characters enough?
6. Any field you need that is missing here?

## 8. Sign-off

| Reviewer    | Date | Decision (yes / yes with changes / no) | Comments |
| ----------- | ---- | -------------------------------------- | -------- |
| Team B lead |      |                                        |          |

## Changelog

- 0.1: first draft.
