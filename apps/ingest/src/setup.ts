import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { json } from "express";
import { AllExceptionsFilter, bodyErrorHandler } from "./errors";
import type { JsonLogger } from "./logger";
import { accessLog, authenticate } from "./middleware";
import { API_KEY_STORE, LOGGER } from "./tokens";
import type { ApiKeyStore } from "./types";

/** Shared by main.ts and the tests, so tests exercise the exact production pipeline. */
export function configureApp(app: INestApplication): void {
  const logger = app.get<JsonLogger>(LOGGER);
  const store = app.get<ApiKeyStore>(API_KEY_STORE);
  (app as NestExpressApplication).disable("x-powered-by");

  app.use(accessLog(logger)); // 1. request id and access log
  app.use("/v1", authenticate(store, logger)); // 2. API key, before reading any body
  app.use(json({ limit: "5mb" })); // 3. parse the body (413 above 5 MB)
  app.use(bodyErrorHandler); // 4. JSON errors for body parser failures
  app.useGlobalFilters(new AllExceptionsFilter(logger));
}
