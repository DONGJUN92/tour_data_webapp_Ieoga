import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { partnerClients, partnerUsageDaily } from "@/db/schema";
import {
  allowDurableIdentity,
  type DurableRateLimitResult,
} from "@/lib/durable-rate-limit";

const PARTNER_MINUTE_LIMIT = 60;

export type PartnerQuotaResult = {
  allowed: boolean;
  unavailable: boolean;
  reason?: "inactive" | "minute_limit" | "daily_limit" | "unavailable";
  clientId?: string;
  usageDate?: string;
  minuteRemaining: number;
  dailyRemaining: number;
  retryAfterSeconds: number;
};

function bearerValue(authorization: string | null): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function koreaUsageDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

export function secondsUntilNextKoreaDay(now = new Date()): number {
  const koreaTime = now.getTime() + 9 * 3_600_000;
  const nextDay = new Date(koreaTime);
  nextDay.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((nextDay.getTime() - koreaTime) / 1_000));
}

function unavailableQuota(): PartnerQuotaResult {
  return {
    allowed: false,
    unavailable: true,
    reason: "unavailable",
    minuteRemaining: 0,
    dailyRemaining: 0,
    retryAfterSeconds: 5,
  };
}

export async function consumePartnerQuota(
  authorization: string | null,
): Promise<PartnerQuotaResult> {
  const token = bearerValue(authorization);
  if (!token) return unavailableQuota();

  try {
    const db = getDb();
    const keyHash = await sha256(token);
    const clientId = `env-${keyHash.slice(0, 32)}`;
    await db
      .insert(partnerClients)
      .values({
        id: clientId,
        name: "Environment partner client",
        keyHash,
      })
      .onConflictDoNothing({ target: partnerClients.keyHash });

    const rows = await db
      .select({
        id: partnerClients.id,
        active: partnerClients.active,
        dailyLimit: partnerClients.dailyLimit,
        revokedAt: partnerClients.revokedAt,
      })
      .from(partnerClients)
      .where(eq(partnerClients.keyHash, keyHash))
      .limit(1);
    const client = rows[0];
    if (!client || !client.active || client.revokedAt) {
      return {
        allowed: false,
        unavailable: false,
        reason: "inactive",
        clientId: client?.id,
        minuteRemaining: 0,
        dailyRemaining: 0,
        retryAfterSeconds: 60,
      };
    }

    const minute: DurableRateLimitResult = await allowDurableIdentity(
      "partner-recover-key",
      keyHash,
      PARTNER_MINUTE_LIMIT,
    );
    if (!minute.allowed) {
      return {
        allowed: false,
        unavailable: minute.unavailable,
        reason: minute.unavailable ? "unavailable" : "minute_limit",
        clientId: client.id,
        minuteRemaining: 0,
        dailyRemaining: client.dailyLimit,
        retryAfterSeconds: minute.retryAfterSeconds,
      };
    }

    const usageDate = koreaUsageDate();
    const now = new Date().toISOString();
    const usage = await db
      .insert(partnerUsageDaily)
      .values({
        clientId: client.id,
        usageDate,
        requestCount: 1,
        successCount: 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          partnerUsageDaily.clientId,
          partnerUsageDaily.usageDate,
        ],
        set: {
          requestCount: sql`${partnerUsageDaily.requestCount} + 1`,
          updatedAt: now,
        },
      })
      .returning({ requestCount: partnerUsageDaily.requestCount });
    const requestCount = usage[0]?.requestCount;
    if (!Number.isInteger(requestCount)) return unavailableQuota();
    const dailyRemaining = Math.max(0, client.dailyLimit - requestCount);
    if (requestCount > client.dailyLimit) {
      return {
        allowed: false,
        unavailable: false,
        reason: "daily_limit",
        clientId: client.id,
        usageDate,
        minuteRemaining: minute.remaining,
        dailyRemaining,
        retryAfterSeconds: secondsUntilNextKoreaDay(),
      };
    }
    return {
      allowed: true,
      unavailable: false,
      clientId: client.id,
      usageDate,
      minuteRemaining: minute.remaining,
      dailyRemaining,
      retryAfterSeconds: minute.retryAfterSeconds,
    };
  } catch {
    return unavailableQuota();
  }
}

export async function recordPartnerSuccess(
  clientId: string,
  usageDate: string,
): Promise<boolean> {
  try {
    const result = await getDb()
      .update(partnerUsageDaily)
      .set({
        successCount: sql`${partnerUsageDaily.successCount} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(partnerUsageDaily.clientId, clientId),
          eq(partnerUsageDaily.usageDate, usageDate),
        ),
      )
      .returning({ clientId: partnerUsageDaily.clientId });
    return result.length === 1;
  } catch {
    return false;
  }
}
