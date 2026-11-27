import { createHash, randomBytes } from "node:crypto";

const KEY_PATTERN = /^aiobs_[A-Za-z0-9_-]{43}$/;

/** A new random key: "aiobs_" + 256 bits of randomness. Shown once, never stored. */
export function generateApiKey(): string {
  return `aiobs_${randomBytes(32).toString("base64url")}`;
}

/**
 * SHA-256 is the right tool here: keys are long random secrets, not human passwords, so there is
 * nothing to brute-force and a slow hash (bcrypt) would only add latency to every request.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Cheap format check so malformed keys never cost a database lookup. */
export function looksLikeApiKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Non-secret prefix kept next to the hash so humans can recognize a key. */
export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}
