import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { hashApiKey, looksLikeApiKey } from "./keys";
import type { JsonLogger } from "./logger";
import type { ApiKeyStore } from "./types";

export type AuthedRequest = Request & { id: string; tenantId: string };

/** Give every request an id (or keep the caller's) and log one structured line when it ends. */
export function accessLog(logger: JsonLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    const incoming = req.headers["x-request-id"];
    const id =
      typeof incoming === "string" && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    (req as AuthedRequest).id = id;
    res.setHeader("x-request-id", id);

    res.on("finish", () => {
      if (req.path === "/health") return;
      const ingest = res.locals.ingest as { accepted: number; rejected: number } | undefined;
      logger.info("request", {
        request_id: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
        tenant_id: (req as AuthedRequest).tenantId,
        accepted: ingest?.accepted,
        rejected: ingest?.rejected,
        bytes_in: Number(req.headers["content-length"] ?? 0),
      });
    });
    next();
  };
}

function unauthorized(res: Response, message: string): void {
  res
    .status(401)
    .set("WWW-Authenticate", "Bearer")
    .json({ error: { code: "unauthorized", message } });
}

/**
 * Runs before the body is parsed, so an unauthenticated caller can never make us read or parse a
 * 5 MB JSON body. Sets req.tenantId from the API key. The tenant is never taken from the payload.
 */
export function authenticate(store: ApiKeyStore, logger: JsonLogger) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!match) return unauthorized(res, "Send your API key as 'Authorization: Bearer <key>'");
    if (!looksLikeApiKey(match[1])) return unauthorized(res, "Invalid API key");

    try {
      const tenant = await store.findByHash(hashApiKey(match[1]));
      if (!tenant) return unauthorized(res, "Invalid API key");
      (req as AuthedRequest).tenantId = tenant.tenantId;
      next();
    } catch (error) {
      logger.error("api key lookup failed", {
        request_id: (req as AuthedRequest).id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        error: { code: "unavailable", message: "Authentication is temporarily unavailable" },
      });
    }
  };
}
