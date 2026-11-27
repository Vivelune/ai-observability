import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { RawBatchSchema } from "@ai-observability/schema";
import type { Response } from "express";
import { ApiError } from "./errors";
import type { JsonLogger } from "./logger";
import type { AuthedRequest } from "./middleware";
import { EVENT_PRODUCER, LOGGER, RATE_LIMITER } from "./tokens";
import type { EventProducer, OutgoingMessage, RateLimiter, Rejection } from "./types";
import { validateEvents } from "./validation";

const MAX_MESSAGE_BYTES = 900 * 1024; // stay under the broker's ~1 MiB limit

@Controller("v1")
export class EventsController {
  constructor(
    @Inject(EVENT_PRODUCER) private readonly producer: EventProducer,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(LOGGER) private readonly logger: JsonLogger,
  ) {}

  @Post("events")
  @HttpCode(202)
  async ingest(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const batch = RawBatchSchema.safeParse(body);
    if (!batch.success) {
      throw new ApiError(
        400,
        "invalid_request",
        'Body must be {"events": [...]} with 1 to 500 events',
      );
    }
    const events = batch.data.events;

    // Rate limit per tenant, charged per event. The SDK retries 429 using Retry-After.
    const decision = this.limiter.consume(req.tenantId, events.length);
    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      throw new ApiError(429, "rate_limited", "Rate limit exceeded for this tenant", {
        "Retry-After": String(retryAfter),
      });
    }

    const { valid, rejected } = validateEvents(events);
    const receivedAt = new Date().toISOString();
    const messages: OutgoingMessage[] = [];
    const tooLarge: Rejection[] = [];

    for (const { index, event } of valid) {
      // tenant_id comes from the API key. It is attached here, after validation, and always wins.
      const value = JSON.stringify({ ...event, tenant_id: req.tenantId, received_at: receivedAt });
      if (Buffer.byteLength(value) > MAX_MESSAGE_BYTES) {
        tooLarge.push({
          index,
          event_id: event.event_id,
          code: "invalid_event",
          message: "Event is larger than 900 KB",
        });
        continue;
      }
      messages.push({
        // Partition key: trace_id keeps all events of one trace on one partition, in order.
        key: event.data.trace_id,
        value,
        headers: { tenant_id: req.tenantId, event_type: event.event_type },
      });
    }

    if (messages.length > 0) {
      try {
        await this.producer.send(messages);
      } catch (error) {
        this.logger.error("produce failed", {
          request_id: req.id,
          tenant_id: req.tenantId,
          events: messages.length,
          error: error instanceof Error ? error.message : String(error),
        });
        // Nothing was acknowledged, so the client must retry the whole batch.
        throw new ApiError(503, "unavailable", "Could not store events right now, retry later");
      }
    }

    const allRejected = [...rejected, ...tooLarge].sort((a, b) => a.index - b.index);
    res.locals.ingest = { accepted: messages.length, rejected: allRejected.length };
    return { accepted: messages.length, rejected: allRejected };
  }
}
