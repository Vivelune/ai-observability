import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import type { JsonLogger } from "./logger";

/** An HTTP error with a stable machine-readable code: { "error": { "code", "message" } }. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super({ error: { code, message } }, status);
  }
}

const CODES: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  404: "not_found",
  405: "method_not_allowed",
  413: "payload_too_large",
  429: "rate_limited",
  503: "unavailable",
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ApiError) {
      res.set(exception.headers).status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json({
        error: { code: CODES[status] ?? "error", message: exception.message },
      });
      return;
    }
    this.logger.error("unhandled exception", {
      error: exception instanceof Error ? exception.message : String(exception),
      stack: exception instanceof Error ? exception.stack : undefined,
    });
    res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
  }
}

/** Express error middleware for body-parser failures (they happen before NestJS routing). */
export function bodyErrorHandler(
  err: { type?: string; status?: number } | undefined,
  _req: unknown,
  res: Response,
  next: (error?: unknown) => void,
): void {
  if (err?.type === "entity.too.large") {
    res.status(413).json({
      error: { code: "payload_too_large", message: "Request body exceeds 5 MB" },
    });
  } else if (err?.type === "entity.parse.failed" || err?.status === 400) {
    res.status(400).json({ error: { code: "invalid_json", message: "Body is not valid JSON" } });
  } else {
    next(err);
  }
}
