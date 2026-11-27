import { Module } from "@nestjs/common";
import { CachedApiKeyStore } from "./cached-key-store";
import { loadConfig, type Config } from "./config";
import { EventsController } from "./events.controller";
import { HealthController } from "./health.controller";
import { KafkaEventProducer } from "./kafka-producer";
import { JsonLogger } from "./logger";
import { PgApiKeyStore } from "./pg-key-store";
import { TokenBucketLimiter } from "./token-bucket";
import { API_KEY_STORE, CONFIG, EVENT_PRODUCER, LOGGER, RATE_LIMITER } from "./tokens";

@Module({
  controllers: [EventsController, HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    {
      provide: LOGGER,
      useFactory: (config: Config) => new JsonLogger(config.logLevel),
      inject: [CONFIG],
    },
    {
      provide: API_KEY_STORE,
      useFactory: (config: Config, logger: JsonLogger) =>
        new CachedApiKeyStore(
          PgApiKeyStore.fromUrl(config.databaseUrl, (error) =>
            logger.error("postgres pool error", { error: error.message }),
          ),
          config.keyCacheTtlMs,
        ),
      inject: [CONFIG, LOGGER],
    },
    { provide: EVENT_PRODUCER, useClass: KafkaEventProducer },
    {
      provide: RATE_LIMITER,
      useFactory: (config: Config) =>
        new TokenBucketLimiter(config.rateLimitPerSec, config.rateLimitBurst),
      inject: [CONFIG],
    },
  ],
})
export class AppModule {}
