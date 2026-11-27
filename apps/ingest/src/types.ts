export interface TenantInfo {
  tenantId: string;
}

export interface ApiKeyStore {
  /** Look up a non-revoked key by its SHA-256 hash. Returns null when unknown or revoked. */
  findByHash(hash: string): Promise<TenantInfo | null>;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface OutgoingMessage {
  key: string;
  value: string;
  headers: Record<string, string>;
}

export interface EventProducer {
  send(messages: OutgoingMessage[]): Promise<void>;
  ping(): Promise<boolean>;
}

export interface RateLimiter {
  consume(tenantId: string, cost: number): { allowed: boolean; retryAfterMs: number };
}

export interface Rejection {
  index: number;
  event_id?: string;
  code: "invalid_event" | "unknown_event_type" | "unsupported_schema_version";
  message: string;
}
