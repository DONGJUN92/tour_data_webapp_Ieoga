import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { durableRateLimitWindows } from "@/db/schema";
import { requestClientIdentity } from "@/lib/rate-limit";

export type DurableRateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  unavailable: boolean;
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function allowDurableRequest(
  request: Request,
  namespace: string,
  limit: number,
  windowMs = 60_000,
): Promise<DurableRateLimitResult> {
  return allowDurableIdentity(
    namespace,
    requestClientIdentity(request),
    limit,
    windowMs,
  );
}

/**
 * Durable quota for an already pseudonymized application identity, such as a
 * partner API key hash. This prevents a caller from multiplying its allowance
 * by rotating IP addresses or reaching different Worker isolates.
 */
export async function allowDurableIdentity(
  namespace: string,
  identity: string,
  limit: number,
  windowMs = 60_000,
): Promise<DurableRateLimitResult> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 10_000);
  const safeWindow = Math.min(
    Math.max(Math.trunc(windowMs), 10_000),
    3_600_000,
  );
  const now = Date.now();
  const windowStart = Math.floor(now / safeWindow) * safeWindow;
  const resetAtMs = windowStart + safeWindow;
  const resetAt = new Date(resetAtMs).toISOString();
  const expiresAt = new Date(resetAtMs + 24 * 3_600_000).toISOString();
  const identityHash = await sha256(
    `${namespace}:${identity}:${windowStart}`,
  );
  try {
    const rows = await getDb()
      .insert(durableRateLimitWindows)
      .values({
        key: identityHash,
        namespace,
        count: 1,
        resetAt,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: durableRateLimitWindows.key,
        set: {
          count: sql`${durableRateLimitWindows.count} + 1`,
          resetAt,
          expiresAt,
        },
      })
      .returning({ count: durableRateLimitWindows.count });
    const count = rows[0]?.count ?? safeLimit + 1;
    return {
      allowed: count <= safeLimit,
      remaining: Math.max(0, safeLimit - count),
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((resetAtMs - now) / 1_000),
      ),
      unavailable: false,
    };
  } catch {
    /* Cost-amplifying endpoints fail closed when the shared limiter cannot
       establish a durable window. The in-isolate guard alone is not treated
       as distributed abuse protection. */
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 5,
      unavailable: true,
    };
  }
}
