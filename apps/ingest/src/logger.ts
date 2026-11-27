import type { LoggerService } from "@nestjs/common";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One JSON object per line on stdout. Never pass secrets or event bodies to it. */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly level: Level = "info",
    private readonly write: (line: string) => void = (line) =>
      void process.stdout.write(line + "\n"),
  ) {}

  info(msg: string, fields: Record<string, unknown> = {}): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields: Record<string, unknown> = {}): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields: Record<string, unknown> = {}): void {
    this.emit("error", msg, fields);
  }
  debug(msg: string, fields: Record<string, unknown> = {}): void {
    this.emit("debug", msg, fields);
  }

  // NestJS LoggerService methods, so framework logs share the same format.
  log(message: unknown, ...rest: unknown[]): void {
    this.emit("info", String(message), this.context(rest));
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit("debug", String(message), this.context(rest));
  }

  private context(rest: unknown[]): Record<string, unknown> {
    const last = rest[rest.length - 1];
    return typeof last === "string" ? { context: last } : {};
  }

  private emit(level: Level, msg: string, fields: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    try {
      this.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
    } catch {
      // Logging must never throw into request handling.
    }
  }
}
