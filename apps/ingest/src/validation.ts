import { EventSchema, isSupportedVersion, type ClientEvent } from "@ai-observability/schema";
import type { Rejection } from "./types";

const EVENT_TYPES = new Set(["trace", "span", "eval_result"]);

export interface ValidatedEvent {
  index: number;
  event: ClientEvent;
}

/** Validate each event on its own, so one bad event never sinks the rest of the batch. */
export function validateEvents(raw: unknown[]): {
  valid: ValidatedEvent[];
  rejected: Rejection[];
} {
  const valid: ValidatedEvent[] = [];
  const rejected: Rejection[] = [];

  raw.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      rejected.push({ index, code: "invalid_event", message: "Each event must be a JSON object" });
      return;
    }
    const record = item as Record<string, unknown>;
    const eventId = typeof record.event_id === "string" ? record.event_id : undefined;
    const reject = (code: Rejection["code"], message: string) =>
      rejected.push({ index, event_id: eventId, code, message });

    const version = record.schema_version;
    if (typeof version === "string" && /^\d+\.\d+$/.test(version) && !isSupportedVersion(version)) {
      return reject("unsupported_schema_version", `schema_version ${version} is not supported`);
    }
    if (typeof record.event_type === "string" && !EVENT_TYPES.has(record.event_type)) {
      return reject(
        "unknown_event_type",
        `event_type must be one of: ${[...EVENT_TYPES].join(", ")}`,
      );
    }

    const parsed = EventSchema.safeParse(item);
    if (!parsed.success) {
      const message = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(event)"}: ${issue.message}`)
        .join("; ");
      return reject("invalid_event", message);
    }
    valid.push({ index, event: parsed.data });
  });

  return { valid, rejected };
}
