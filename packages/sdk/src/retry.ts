/**
 * Exponential backoff with "equal jitter": the delay grows 2x per consecutive failure up to
 * maxMs, and is randomized between half and all of that ceiling so clients do not retry in sync.
 */
export function backoffDelay(
  failures: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/** Parse a Retry-After header (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
