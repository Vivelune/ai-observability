import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { API_KEY_STORE, EVENT_PRODUCER } from "./tokens";
import type { ApiKeyStore, EventProducer } from "./types";

const withTimeout = (promise: Promise<boolean>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref()),
  ]);

@Controller("health")
export class HealthController {
  constructor(
    @Inject(API_KEY_STORE) private readonly store: ApiKeyStore,
    @Inject(EVENT_PRODUCER) private readonly producer: EventProducer,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const [postgres, kafka] = await Promise.all([
      withTimeout(this.store.ping(), 2000),
      withTimeout(this.producer.ping(), 2000),
    ]);
    const ok = postgres && kafka;
    res.status(ok ? 200 : 503);
    return {
      status: ok ? "ok" : "degraded",
      checks: { postgres: postgres ? "up" : "down", kafka: kafka ? "up" : "down" },
      uptime_s: Math.round(process.uptime()),
    };
  }
}
