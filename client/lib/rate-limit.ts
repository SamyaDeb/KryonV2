const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

async function distributedRateLimit(key: string, limit: number): Promise<boolean | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const bucketKey = `rl:${key}:${Math.floor(Date.now() / WINDOW_MS)}`;
  const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", bucketKey],
      ["PEXPIRE", bucketKey, String(WINDOW_MS + 5_000)],
    ]),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error("distributed rate limit unavailable");
  }

  const result = (await res.json()) as Array<{ result?: unknown }>;
  const count = Number(result[0]?.result ?? 0);
  return Number.isFinite(count) && count <= limit;
}

function localRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  current.count += 1;
  return current.count <= limit;
}

export async function rateLimit(key: string, limit: number): Promise<boolean> {
  const distributed = await distributedRateLimit(key, limit).catch(() => false);
  if (distributed !== null) return distributed;
  return localRateLimit(key, limit);
}

export function requestKey(req: Request, owner: string): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip") || "unknown";
  return `${owner}:${ip}`;
}

export function bodyTooLarge(req: Request, maxBytes = 4096): boolean {
  const len = Number(req.headers.get("content-length") ?? 0);
  return Number.isFinite(len) && len > maxBytes;
}
