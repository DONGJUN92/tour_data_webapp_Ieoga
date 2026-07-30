import { and, asc, eq, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import {
  administrativeAreas,
  apiAuditLogs,
  itineraries,
  proofShares,
  recoveryRuns,
  sessions,
  syncPartitions,
} from "@/db/schema";
import {
  persistPolicySnapshot,
  persistRegionPackMetadata,
} from "@/lib/db/repository";
import { buildPolicyInsight } from "@/lib/insights/service";
import { refreshResilienceMissions } from "@/lib/insights/missions";
import { getDistricts, getRegions } from "@/lib/kto/adapters";
import { putRegionPack } from "@/lib/storage/region-packs";

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export async function purgeExpiredData(): Promise<{
  sessions: number;
  runs: number;
  itineraries: number;
  shares: number;
  audits: number;
}> {
  const db = getDb();
  const now = new Date().toISOString();
  const auditCutoff = new Date(
    Date.now() - 90 * 24 * 3_600_000,
  ).toISOString();
  const shares = await db
    .delete(proofShares)
    .where(lte(proofShares.expiresAt, now))
    .returning({ id: proofShares.id });
  const runs = await db
    .delete(recoveryRuns)
    .where(lte(recoveryRuns.expiresAt, now))
    .returning({ id: recoveryRuns.id });
  const itinerariesDeleted = await db
    .delete(itineraries)
    .where(lte(itineraries.expiresAt, now))
    .returning({ id: itineraries.id });
  const sessionsDeleted = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  const audits = await db
    .delete(apiAuditLogs)
    .where(lte(apiAuditLogs.calledAt, auditCutoff))
    .returning({ id: apiAuditLogs.id });
  return {
    sessions: sessionsDeleted.length,
    runs: runs.length,
    itineraries: itinerariesDeleted.length,
    shares: shares.length,
    audits: audits.length,
  };
}

export async function bootstrapPolicyPartitions(): Promise<{
  regionCount: number;
  districtCount: number;
}> {
  const db = getDb();
  const regionResult = await getRegions();
  let districtCount = 0;

  for (const region of regionResult.items) {
    const regionCode = String(region.code ?? "");
    const regionName = String(region.name ?? "");
    if (!regionCode || !regionName) continue;

    await db
      .insert(administrativeAreas)
      .values({
        code: regionCode,
        name: regionName,
        level: "region",
        codeVersion: "TourAPI-2026-07",
        sourceUpdatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: administrativeAreas.code,
        set: {
          name: regionName,
          active: true,
          codeVersion: "TourAPI-2026-07",
          sourceUpdatedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

    const districts = await getDistricts(regionCode);
    if (!districts.items.length) {
      await db
        .insert(syncPartitions)
        .values({
          id: regionCode,
          regionCode,
          districtCode: "_all",
          regionName,
          status: "pending",
          nextRunAt: new Date().toISOString(),
        })
        .onConflictDoNothing();
      continue;
    }

    for (const district of districts.items) {
      const rawCode = String(district.code ?? "");
      const districtName = String(district.name ?? "");
      if (!rawCode || !districtName) continue;
      const districtCode = `${regionCode}${rawCode}`;
      districtCount += 1;

      await db
        .insert(administrativeAreas)
        .values({
          code: districtCode,
          parentCode: regionCode,
          name: districtName,
          level: "district",
          codeVersion: "TourAPI-2026-07",
          sourceUpdatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: administrativeAreas.code,
          set: {
            parentCode: regionCode,
            name: districtName,
            active: true,
            codeVersion: "TourAPI-2026-07",
            sourceUpdatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });

      await db
        .insert(syncPartitions)
        .values({
          id: districtCode,
          regionCode,
          districtCode,
          regionName,
          districtName,
          status: "pending",
          nextRunAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: syncPartitions.id,
          set: {
            regionName,
            districtName,
            updatedAt: new Date().toISOString(),
          },
        });
    }
  }

  return {
    regionCount: regionResult.items.length,
    districtCount,
  };
}

export async function runPolicySync(options: {
  batchSize?: number;
  bootstrapIfEmpty?: boolean;
} = {}): Promise<{
  bootstrapped?: { regionCount: number; districtCount: number };
  attempted: number;
  succeeded: number;
  failed: number;
  partitions: Array<{
    id: string;
    status: "succeeded" | "failed";
    coveragePercent?: number;
    activeMissionCount?: number;
  }>;
}> {
  const db = getDb();
  await purgeExpiredData();
  const first = await db.select({ id: syncPartitions.id }).from(syncPartitions).limit(1);
  let bootstrapped: { regionCount: number; districtCount: number } | undefined;
  if (!first.length && options.bootstrapIfEmpty !== false) {
    bootstrapped = await bootstrapPolicyPartitions();
  }

  const now = new Date().toISOString();
  const due = await db
    .select()
    .from(syncPartitions)
    .where(
      and(
        lte(syncPartitions.nextRunAt, now),
        or(
          eq(syncPartitions.status, "pending"),
          eq(syncPartitions.status, "ready"),
          eq(syncPartitions.status, "failed"),
        ),
      ),
    )
    .orderBy(asc(syncPartitions.nextRunAt), asc(syncPartitions.id))
    .limit(Math.min(Math.max(options.batchSize ?? 2, 1), 4));

  const partitions: Array<{
    id: string;
    status: "succeeded" | "failed";
    coveragePercent?: number;
    activeMissionCount?: number;
  }> = [];

  for (const partition of due) {
    await db
      .update(syncPartitions)
      .set({
        status: "running",
        lastAttemptAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(syncPartitions.id, partition.id));

    try {
      const payload = await buildPolicyInsight({
        areaCode: partition.regionCode,
        districtCode:
          partition.districtCode === "_all"
            ? undefined
            : partition.districtCode,
      });
      const pack = await putRegionPack(payload);
      if (!pack.stored) throw new Error("REGION_PACKS_UNAVAILABLE");

      await persistPolicySnapshot({
        regionCode: partition.regionCode,
        districtCode:
          partition.districtCode === "_all"
            ? undefined
            : partition.districtCode,
        baseMonth: payload.baseYm,
        status: payload.status,
        coveragePercent: payload.coverage.percent,
        metrics: {
          metricCount: payload.metrics.length,
          hubCount: payload.hubs.length,
        },
        sourceLedger: payload.sourceLedger,
        calculationVersion: payload.calculationVersion,
        r2Key: pack.objectKey,
      });
      await persistRegionPackMetadata({
        regionCode: partition.regionCode,
        districtCode:
          partition.districtCode === "_all"
            ? undefined
            : partition.districtCode,
        baseMonth: payload.baseYm,
        calculationVersion: payload.calculationVersion,
        objectKey: pack.objectKey,
        checksum: pack.checksum,
        status: payload.status,
        coveragePercent: payload.coverage.percent,
        sourceUpdatedAt: payload.generatedAt,
      });
      const missionRefresh = await refreshResilienceMissions(payload);

      await db
        .update(syncPartitions)
        .set({
          status: "ready",
          lastSuccessAt: new Date().toISOString(),
          nextRunAt: inHours(24 * 7),
          failureCount: 0,
          lastErrorCode: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(syncPartitions.id, partition.id));
      partitions.push({
        id: partition.id,
        status: "succeeded",
        coveragePercent: payload.coverage.percent,
        activeMissionCount: missionRefresh.activeCount,
      });
    } catch {
      await db
        .update(syncPartitions)
        .set({
          status: "failed",
          nextRunAt: inHours(6),
          failureCount: partition.failureCount + 1,
          lastErrorCode: "SYNC_FAILED",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(syncPartitions.id, partition.id));
      partitions.push({ id: partition.id, status: "failed" });
    }
  }

  return {
    bootstrapped,
    attempted: partitions.length,
    succeeded: partitions.filter((item) => item.status === "succeeded").length,
    failed: partitions.filter((item) => item.status === "failed").length,
    partitions,
  };
}
