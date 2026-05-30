import { neon } from "@neondatabase/serverless";

// Server-side only — never import this in client components.
// DATABASE_URL is a private env var (no NEXT_PUBLIC_ prefix).
function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export const db = getDb;

/**
 * Retry a DB operation on transient Neon errors ("fetch failed",
 * connection resets) which occur sporadically under burst on the serverless
 * driver. Deterministic errors (constraint violations, bad SQL) are NOT
 * retried — they surface immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|connect|terminat|timeout/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastErr;
}
