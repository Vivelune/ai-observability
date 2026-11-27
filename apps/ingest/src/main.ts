import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { Config } from "./config";
import type { JsonLogger } from "./logger";
import { configureApp } from "./setup";
import { CONFIG, LOGGER } from "./tokens";

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true });
  const logger = app.get<JsonLogger>(LOGGER);
  app.useLogger(logger);
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get<Config>(CONFIG);
  await app.listen(config.port, "0.0.0.0");
  logger.info("ingest api listening", {
    port: config.port,
    topic: config.eventsTopic,
    rate_limit_per_sec: config.rateLimitPerSec,
    rate_limit_burst: config.rateLimitBurst,
  });
}

main().catch((error: Error) => {
  console.error(JSON.stringify({ level: "fatal", msg: error.message }));
  process.exit(1);
});
