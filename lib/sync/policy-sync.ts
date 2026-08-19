import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  administrativeAreas,
  apiAuditLogs,
  durableRateLimitWindows,
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
import {
  hasOfficialRegionAggregateCoverage,
  KTO_OFFICIAL_REGION_CODES,
} from "@/lib/kto/registry";
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
  /* 만료된 일정을 지우기 전에, 아직 만료되지 않은 복구 기록이 그것을 가리키고
     있으면 링크를 끊는다. 두 만료 시각은 서로 다른 시계로 움직이므로 복구 기록이
     남아 있는 채 일정이 만료되는 상태가 정상적으로 생긴다.
     이 외래키의 실제 DDL 에는 `ON DELETE` 절이 없어 기본값 NO ACTION 이고,
     그것은 삭제를 막는다. 끊지 않으면 지워야 할 일정이 남아 보관기간 약속이
     조용히 깨진다 — 실패가 밖으로 드러나지도 않는다. */
  await db
    .update(recoveryRuns)
    .set({ itineraryId: null })
    .where(
      inArray(
        recoveryRuns.itineraryId,
        db
          .select({ id: itineraries.id })
          .from(itineraries)
          .where(lte(itineraries.expiresAt, now)),
      ),
    );
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
  await db
    .delete(durableRateLimitWindows)
    .where(lte(durableRateLimitWindows.expiresAt, now));
  return {
    sessions: sessionsDeleted.length,
    runs: runs.length,
    itineraries: itinerariesDeleted.length,
    shares: shares.length,
    audits: audits.length,
  };
}

export type PolicyBootstrapResult = {
  regionCount: number;
  districtCount: number;
  failedRegionCodes: string[];
};

export async function bootstrapPolicyPartitions(
  targetRegionCodes: Iterable<string> = KTO_OFFICIAL_REGION_CODES,
): Promise<PolicyBootstrapResult> {
  const db = getDb();
  const regionResult = await getRegions();
  const targets = new Set(targetRegionCodes);
  const failedRegionCodes = new Set(targets);
  let regionCount = 0;
  let districtCount = 0;

  for (const region of regionResult.items) {
    const regionCode = String(region.code ?? "");
    const regionName = String(region.name ?? "");
    if (!targets.has(regionCode) || !regionName) continue;

    /* Store the aggregate before fetching districts. A transient failure in
       one district list must not discard this region or prevent later
       official regions from being bootstrapped. sourceUpdatedAt becomes the
       durable completion marker only after the district phase succeeds. */
    await db
      .insert(administrativeAreas)
      .values({
        code: regionCode,
        name: regionName,
        level: "region",
        codeVersion: "TourAPI-2026-07",
        sourceUpdatedAt: null,
      })
      .onConflictDoUpdate({
        target: administrativeAreas.code,
        set: {
          name: regionName,
          active: true,
          codeVersion: "TourAPI-2026-07",
          sourceUpdatedAt: null,
          updatedAt: new Date().toISOString(),
        },
      });

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
      .onConflictDoUpdate({
        target: syncPartitions.id,
        set: {
          regionName,
          updatedAt: new Date().toISOString(),
        },
      });

    let districts: Awaited<ReturnType<typeof getDistricts>>;
    try {
      districts = await getDistricts(regionCode);
    } catch {
      /* Leave the completion marker empty and continue. The next cron targets
         only incomplete official regions and resumes this exact one. */
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

    await db
      .update(administrativeAreas)
      .set({
        sourceUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(administrativeAreas.code, regionCode));
    failedRegionCodes.delete(regionCode);
    regionCount += 1;
  }

  return {
    regionCount,
    districtCount,
    failedRegionCodes: [...failedRegionCodes].sort(),
  };
}

export async function runPolicySync(options: {
  batchSize?: number;
  bootstrapIfEmpty?: boolean;
} = {}): Promise<{
  bootstrapped?: PolicyBootstrapResult;
  bootstrapError?: "BOOTSTRAP_SOURCE_UNAVAILABLE";
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
  const aggregatePartitions = await db
    .select({ regionCode: syncPartitions.regionCode })
    .from(syncPartitions)
    .where(eq(syncPartitions.districtCode, "_all"));
  const completedBootstrapRegions = await db
    .select({ code: administrativeAreas.code })
    .from(administrativeAreas)
    .where(
      and(
        eq(administrativeAreas.level, "region"),
        isNotNull(administrativeAreas.sourceUpdatedAt),
      ),
    );
  const aggregateCodes = new Set(
    aggregatePartitions.map((partition) => partition.regionCode),
  );
  const completedCodes = new Set(
    completedBootstrapRegions.map((region) => region.code),
  );
  const completedOfficialCodes = KTO_OFFICIAL_REGION_CODES.filter(
    (code) => aggregateCodes.has(code) && completedCodes.has(code),
  );
  const resumeTargets = KTO_OFFICIAL_REGION_CODES.filter(
    (code) => !aggregateCodes.has(code) || !completedCodes.has(code),
  );
  let bootstrapped: PolicyBootstrapResult | undefined;
  let bootstrapError: "BOOTSTRAP_SOURCE_UNAVAILABLE" | undefined;
  if (
    !hasOfficialRegionAggregateCoverage(completedOfficialCodes) &&
    options.bootstrapIfEmpty !== false
  ) {
    try {
      bootstrapped = await bootstrapPolicyPartitions(resumeTargets);
    } catch {
      /* Existing due partitions remain processable when the region source is
         transiently down. Bootstrap resumes independently on the next cron. */
      bootstrapError = "BOOTSTRAP_SOURCE_UNAVAILABLE";
    }
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
          eq(syncPartitions.status, "running"),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${syncPartitions.districtCode} = '_all' THEN 0 ELSE 1 END`,
      asc(syncPartitions.nextRunAt),
      asc(syncPartitions.id),
    )
    .limit(Math.min(Math.max(options.batchSize ?? 2, 1), 4));

  const partitions: Array<{
    id: string;
    status: "succeeded" | "failed";
    coveragePercent?: number;
    activeMissionCount?: number;
  }> = [];

  for (const partition of due) {
    /* nextRunAt doubles as a renewable lease deadline while running. The
       conditional update is the claim: only one concurrent worker can replace
       the exact due state. A crashed worker becomes claimable again after the
       lease expires instead of leaving the partition permanently running. */
    const leaseUntil = new Date(
      Date.now() + 20 * 60_000 + Math.floor(Math.random() * 1_000),
    ).toISOString();
    const claimed = await db
      .update(syncPartitions)
      .set({
        status: "running",
        lastAttemptAt: new Date().toISOString(),
        nextRunAt: leaseUntil,
        lastErrorCode: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(syncPartitions.id, partition.id),
          eq(syncPartitions.status, partition.status),
          eq(syncPartitions.nextRunAt, partition.nextRunAt),
        ),
      )
      .returning({ id: syncPartitions.id });
    if (!claimed.length) continue;

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

      const finalized = await db
        .update(syncPartitions)
        .set({
          status: "ready",
          lastSuccessAt: new Date().toISOString(),
          nextRunAt: inHours(24 * 7),
          failureCount: 0,
          lastErrorCode: null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(syncPartitions.id, partition.id),
            eq(syncPartitions.status, "running"),
            eq(syncPartitions.nextRunAt, leaseUntil),
          ),
        )
        .returning({ id: syncPartitions.id });
      if (!finalized.length) {
        partitions.push({ id: partition.id, status: "failed" });
        continue;
      }
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
        .where(
          and(
            eq(syncPartitions.id, partition.id),
            eq(syncPartitions.status, "running"),
            eq(syncPartitions.nextRunAt, leaseUntil),
          ),
        );
      partitions.push({ id: partition.id, status: "failed" });
    }
  }

  return {
    bootstrapped,
    bootstrapError,
    attempted: partitions.length,
    succeeded: partitions.filter((item) => item.status === "succeeded").length,
    failed: partitions.filter((item) => item.status === "failed").length,
    partitions,
  };
}
