import { getDb } from "@/db";
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { assessJourneyDrift } from "@/lib/recovery/drift";
import type { BatchItem } from "drizzle-orm/batch";
import {
  apiAuditLogs,
  administrativeAreas,
  consentEvents,
  itineraries,
  itineraryNodes,
  journeyExecutions,
  journeyExecutionSteps,
  proofShares,
  regionPacks,
  recoveryOptions,
  recoveryOutcomes,
  recoveryRuns,
  regionPolicySnapshots,
  sessions,
  sourceHealth,
} from "@/db/schema";
import { distanceBucket, minutesBucket } from "@/lib/geo";
import { expiresInDays, timeBudgetBucket } from "@/lib/privacy";
import type { KtoAudit } from "@/lib/kto/types";
import { hasExactKtoHealthSourceSet } from "@/lib/kto/health-snapshot";
import type {
  ItineraryRegistration,
  JourneyExecutionActionInput,
  RecoveryOutcomeInput,
  RecoveryRequest,
} from "@/lib/recovery/schema";
import type {
  JourneyExecution,
  JourneyExecutionStep,
  JourneyExecutionStepRole,
} from "@/lib/recovery/execution";
import {
  APPLICATION_SAFETY_CONTRACT_VERSION,
  createItineraryImpactSnapshot,
  applicationSnapshotClass,
  decryptApplicationSnapshot,
  encryptApplicationSnapshot,
} from "@/lib/recovery/application-snapshot";
import { RECOVERY_RULE_VERSION } from "@/lib/recovery/engine";
import {
  koreaLatitude,
  koreaLongitude,
} from "@/lib/validation/numbers";
import {
  toPrivacySafeContinuityProof,
  toPrivacySafeRecoveryEvidence,
  toPrivacySafeRouteEvidence,
} from "@/lib/recovery/privacy-evidence";
import type { RecoveryResult } from "@/lib/recovery/types";

export type PersistenceResult =
  | { persisted: true }
  | {
      persisted: false;
      reason:
        | "DB_UNAVAILABLE"
        | "APPLICATION_SNAPSHOT_UNAVAILABLE"
        | "RECOVERY_DEADLINE_EXCEEDED"
        | "INVALID_HEALTH_SNAPSHOT";
    };

type D1WriteBatch = [
  BatchItem<"sqlite">,
  ...BatchItem<"sqlite">[],
];

function isJourneyStateGuardFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /NOT NULL constraint failed:\s*journey_(?:executions|execution_steps)\.id/i.test(
    message,
  );
}

function privacySafeJson(
  value: unknown,
  kind: "general" | "continuity" | "route" = "general",
): string {
  const safe =
    kind === "route"
      ? toPrivacySafeRouteEvidence(value)
      : kind === "continuity"
        ? toPrivacySafeContinuityProof(value)
        : toPrivacySafeRecoveryEvidence(value);
  return JSON.stringify(safe);
}

function parsePrivacySafeJson(
  value: string | null,
  kind: "general" | "continuity" | "route" = "general",
): unknown {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return kind === "route"
      ? toPrivacySafeRouteEvidence(parsed)
      : kind === "continuity"
        ? toPrivacySafeContinuityProof(parsed)
        : toPrivacySafeRecoveryEvidence(parsed);
  } catch {
    return null;
  }
}

function sessionWriteBatch(params: {
  db: ReturnType<typeof getDb>;
  sessionId: string;
  analyticsConsent: boolean;
  currentAnalyticsConsent?: boolean;
}): D1WriteBatch {
  const now = new Date().toISOString();
  const expiresAt = expiresInDays(30);
  const consentVersion = params.analyticsConsent ? "2026-07-v1" : null;
  const writes: D1WriteBatch = [
    params.db.insert(sessions).values({
      id: params.sessionId,
      analyticsConsent: params.analyticsConsent,
      consentVersion,
      expiresAt,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: sessions.id,
      set: {
        analyticsConsent: params.analyticsConsent,
        consentVersion,
        expiresAt,
        updatedAt: now,
        deletedAt: null,
      },
    }),
  ];

  if (
    params.currentAnalyticsConsent === undefined ||
    params.currentAnalyticsConsent !== params.analyticsConsent
  ) {
    writes.push(
      params.db.insert(consentEvents).values({
        sessionId: params.sessionId,
        action: params.analyticsConsent ? "granted" : "declined",
        consentVersion: "2026-07-v1",
      }),
    );
  }
  return writes;
}

export async function persistRecovery(params: {
  sessionId: string;
  input: RecoveryRequest;
  result: RecoveryResult;
  commitDeadlineAt?: number;
}): Promise<PersistenceResult> {
  if (
    params.commitDeadlineAt !== undefined &&
    (!Number.isFinite(params.commitDeadlineAt) ||
      Date.now() >= params.commitDeadlineAt)
  ) {
    return {
      persisted: false,
      reason: "RECOVERY_DEADLINE_EXCEEDED",
    };
  }
  try {
    const db = getDb();
    const runExpiry = expiresInDays(
      params.input.analyticsConsent ? 30 : 1,
    );
    const requestedItineraryId = params.input.itinerary?.id;
    const [currentSession, ownedItinerary] = await Promise.all([
      db
        .select({ analyticsConsent: sessions.analyticsConsent })
        .from(sessions)
        .where(eq(sessions.id, params.sessionId))
        .limit(1),
      requestedItineraryId
        ? db
            .select({ id: itineraries.id })
            .from(itineraries)
            .where(
              and(
                eq(itineraries.id, requestedItineraryId),
                eq(itineraries.sessionId, params.sessionId),
                isNull(itineraries.deletedAt),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);
    const bestOption = params.result.options[0];
    const recoveryItinerary = params.input.itinerary;
    const disruptedNodeId =
      params.result.itinerarySummary?.disruptedNodeId ??
      recoveryItinerary?.disruptedNodeId;
    const nextFixedNodeId =
      params.result.itinerarySummary?.nextFixedNodeId ??
      recoveryItinerary?.nextFixedNodeId;
    const itineraryImpact =
      params.result.recoveryMode === "registered_itinerary" &&
      recoveryItinerary?.id &&
      disruptedNodeId &&
      nextFixedNodeId
        ? await createItineraryImpactSnapshot({
            itineraryId: recoveryItinerary.id,
            disruptedNodeId,
            nextFixedNodeId,
            nodes: recoveryItinerary.nodes,
          })
        : undefined;
    if (
      params.result.options.length > 0 &&
      params.result.recoveryMode === "registered_itinerary" &&
      !itineraryImpact
    ) {
      return {
        persisted: false,
        reason: "APPLICATION_SNAPSHOT_UNAVAILABLE",
      };
    }
    const applicationSnapshots = new Map(
      await Promise.all(
        params.result.options.map(async (option) => {
          const nextFixed = option.scheduleDiff.nextFixedAppointment;
          const openWindow = option.scheduleDiff.openWindow;
          /* 계약이 담을 수 있는 상태인가. 휴무로 확인된 곳은 애초에 결과에
             오르지 않지만, 그 사실을 여기서 다시 단정하지 않는다 — 단정하면
             엔진이 바뀌었을 때 이 자리가 조용히 거짓이 된다. 담을 수 없는
             상태면 스냅숏을 만들지 않고, 아래 검사가 응답을 막는다. */
          const snapshotStatus =
            option.availability.status === "confirmed_open" ||
            option.availability.status === "official_hours_unstructured" ||
            option.availability.status === "unknown"
              ? option.availability.status
              : undefined;
          if (!snapshotStatus) return [option.id, undefined] as const;
          return [
            option.id,
            await encryptApplicationSnapshot(
              {
                contentId: option.contentId,
                title: option.title,
                address: option.address || option.title,
                latitude: option.latitude,
                longitude: option.longitude,
                generatedAt: params.result.generatedAt,
                contractVersion: APPLICATION_SAFETY_CONTRACT_VERSION,
                ruleVersion: params.result.ruleVersion,
                recoveryMode: params.result.recoveryMode,
                /* 확인한 그대로 담는다. 예전에는 `as "confirmed_open"`으로
                   눌러 적었는데, 그러면 계약이 담을 수 없는 안이 목록에 오르는
                   순간 스냅숏이 조용히 만들어지지 않고 **응답 전체가 저장 실패로
                   버려졌다.** 계약이 두 갈래를 아는 지금은 사실대로 적으면 되고,
                   갈래를 벗어난 안은 아래에서 스냅숏 없이 걸러진다. */
                availability: {
                  status: snapshotStatus,
                  checkedAt: option.availability.checkedAt,
                },
                confirmationRequired: option.confirmationRequired,
                evidenceGapCodes: option.evidenceGaps.map((gap) => gap.code),
                visitStartAt: option.scheduleDiff.replacementNode.startAt,
                visitEndAt: option.scheduleDiff.replacementNode.endAt,
                nextFixed:
                  nextFixed?.estimatedArrivalAt
                    ? {
                        nodeId: nextFixed.nodeId,
                        scheduledAt: nextFixed.scheduledAt,
                        estimatedArrivalAt:
                          nextFixed.estimatedArrivalAt,
                        status: nextFixed.status as "preserved",
                      }
                    : undefined,
                openWindow: openWindow
                  ? {
                      windowStartAt: openWindow.windowStartAt,
                      windowEndAt: openWindow.windowEndAt,
                      status: openWindow.status as "fits",
                      returnMinutes: openWindow.returnMinutes,
                      returnBasis: openWindow.returnBasis,
                      returnProvider: openWindow.returnProvider,
                      returnDistanceMeters:
                        openWindow.returnDistanceMeters,
                      returnCalculatedAt: openWindow.returnCalculatedAt,
                      requiredBufferMinutes:
                        openWindow.requiredBufferMinutes,
                      leftoverMinutes: openWindow.leftoverMinutes,
                    }
                  : undefined,
                itineraryImpact,
              },
              params.result.requestId,
              option.id,
            ),
          ] as const;
        }),
      ),
    );
    /* 적용 가능한 안은 검증된 장소의 무결성 보호 사본을 반드시 지녀야 한다.
       평문이나 빈 값으로 대체해 저장하면 나중의 적용이 바뀔 수 있는 상위
       데이터에 의존하게 된다. 그 규칙은 그대로다.

       바뀐 것은 **못 지녔을 때 무엇을 버리느냐**이다. 예전에는 한 안이라도
       봉인되지 않으면 요청 전체를 실패시켰다. 그래서 계약이 담지 못하는 안이
       목록에 하나 섞이는 순간, 나머지 여덟 곳이 멀쩡한데도 여행자는 "저장하지
       못해 결과를 제공하지 않습니다"만 보았다. 실제로 그렇게 터졌다.

       봉인하지 못한 안은 애초에 적용할 수 없다 — 적용 경로가 스냅숏이 없으면
       거절한다. 그러니 목록에 남겨 둘 이유가 없고, 그 하나 때문에 조회 전체를
       버릴 이유는 더더욱 없다. 그 안만 빼고, 뺐다는 사실을 밝힌다. */
    const sealedOptions = params.result.options.filter((option) =>
      applicationSnapshots.get(option.id),
    );
    const unsealedCount =
      params.result.options.length - sealedOptions.length;
    if (unsealedCount > 0) {
      params.result.options = sealedOptions;
      params.result.warnings = [
        ...(params.result.warnings ?? []),
        `${unsealedCount}곳은 적용 계약을 만들지 못해 목록에서 제외했습니다. 확인하지 않은 후보를 결과처럼 표시하지 않습니다.`,
      ];
    }
    if (unsealedCount > 0 && sealedOptions.length === 0) {
      /* 전부 봉인에 실패했다면 그것은 후보 하나의 문제가 아니라 열쇠나 계약
         자체의 문제다. 그때는 조용히 0건을 내놓지 않고 실패로 말한다. */
      return {
        persisted: false,
        reason: "APPLICATION_SNAPSHOT_UNAVAILABLE",
      };
    }

    const writes = sessionWriteBatch({
      db,
      sessionId: params.sessionId,
      analyticsConsent: params.input.analyticsConsent,
      currentAnalyticsConsent: currentSession[0]?.analyticsConsent,
    });
    writes.push(
      db.insert(recoveryRuns).values({
        id: params.result.requestId,
        sessionId: params.sessionId,
        itineraryId: ownedItinerary[0]?.id ?? null,
        disruptedNodeId:
          params.result.itinerarySummary?.disruptedNodeId ?? null,
        nextFixedNodeId:
          params.result.itinerarySummary?.nextFixedNodeId ?? null,
        recoveryMode: params.result.recoveryMode,
        incident: params.input.incident,
        audience: params.input.audience,
        regionCode: params.result.scope.regionCode ?? null,
        districtCode: params.result.scope.districtCode ?? "_all",
        timeBudgetBucket: timeBudgetBucket(params.input.availableMinutes),
        /* User-facing distance caps were removed: eligibility is determined by
           routed travel time, stay time and the protected appointment. Keep a
           non-identifying policy marker in the legacy analytics column rather
           than pretending that the request carried a distance preference. */
        distanceBucket: "time-based",
        indoorRequired:
          params.input.indoorOnly || params.input.incident === "rain",
        status: params.result.status,
        ruleVersion: params.result.ruleVersion,
        optionCount: params.result.options.length,
        rejectedCount: params.result.rejectedCount,
        changedNodeCount:
          bestOption?.scheduleDiff.changedNodeCount ?? null,
        lockedNodeCount:
          bestOption?.continuityProof.lockedNodesTotal ??
          params.result.itinerarySummary?.lockedNodeCount ??
          null,
        lockedNodesPreserved:
          bestOption?.continuityProof.lockedNodesPreserved ?? null,
        nextFixedPreserved:
          bestOption?.continuityProof.nextFixedAppointmentPreserved ?? null,
        decisionProofJson: bestOption
          ? privacySafeJson(bestOption.continuityProof, "continuity")
          : null,
        itineraryImpactHash: itineraryImpact?.hash ?? null,
        counterfactualJson: params.result.counterfactual
          ? privacySafeJson(params.result.counterfactual)
          : null,
        analyticsEligible: params.input.analyticsConsent,
        failureCode:
          params.result.status === "verified" ||
          params.result.status === "degraded"
            ? null
            : params.result.status,
        completedAt: params.result.generatedAt,
        expiresAt: runExpiry,
      }),
    );

    for (const [index, option] of params.result.options.entries()) {
      writes.push(
        db.insert(recoveryOptions).values({
          id: option.id,
          runId: params.result.requestId,
          rank: index + 1,
          contentId: option.contentId,
          title: option.title,
          contentTypeId: option.contentTypeId,
          status: "applicable",
          score: option.score,
          distanceBucket: distanceBucket(option.distanceMeters),
          travelMinutesBucket: minutesBucket(option.estimatedTravelMinutes),
          accessibilityStatus: option.accessibility.status,
          crowdStatus: option.crowd.status,
          sourceNamesJson: JSON.stringify(option.sources),
          changedNodeCount: option.scheduleDiff.changedNodeCount,
          nextFixedStatus:
            option.scheduleDiff.nextFixedAppointment?.status ?? null,
          arrivalBufferMinutes:
            option.scheduleDiff.nextFixedAppointment
              ?.arrivalBufferMinutes ?? null,
          routeEvidenceJson: privacySafeJson(
            option.continuityProof.routeEvidence,
            "route",
          ),
          scheduleDiffJson: privacySafeJson(option.scheduleDiff),
          continuityProofJson: privacySafeJson(
            option.continuityProof,
            "continuity",
          ),
          applicationSnapshotJson:
            applicationSnapshots.get(option.id) ?? null,
          safetyContractVersion: APPLICATION_SAFETY_CONTRACT_VERSION,
          availabilityStatus: option.availability.status,
          availabilityCheckedAt: option.availability.checkedAt,
          visitStartAt: option.scheduleDiff.replacementNode.startAt,
          visitEndAt: option.scheduleDiff.replacementNode.endAt,
          confirmationRequired: option.confirmationRequired,
          evidenceGapCount: option.evidenceGaps.length,
        }),
      );
    }

    for (const audit of params.result.sourceLedger) {
      writes.push(
        db.insert(apiAuditLogs).values({
          runId: params.result.requestId,
          requestId: params.result.requestId,
          apiName: audit.apiName,
          operation: audit.operation,
          status: audit.status,
          httpStatus: audit.httpStatus ?? null,
          latencyMs: audit.latencyMs,
          resultCount: audit.resultCount,
          sourceReferenceDate: audit.sourceReferenceDate ?? null,
          fieldsUsedJson: JSON.stringify(audit.fieldsUsed),
          errorCode: audit.errorCode ?? null,
        }),
      );
    }

    if (params.commitDeadlineAt !== undefined) {
      const commitDeadline = new Date(
        params.commitDeadlineAt,
      ).toISOString();
      /* This is deliberately the final statement in the D1 transaction. If
         the batch reaches the commit-reserve boundary too late, assigning
         NULL to the NOT NULL primary key fails and D1 rolls the whole batch
         back. The route still reports an in-flight response race as unknown. */
      writes.push(
        db
          .update(recoveryRuns)
          .set({
            id: sql<string>`CASE
              WHEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') <= ${commitDeadline}
              THEN ${recoveryRuns.id}
              ELSE NULL
            END`,
          })
          .where(eq(recoveryRuns.id, params.result.requestId)),
      );
    }

    // Cloudflare D1 executes batch statements sequentially and rolls the
    // complete batch back when any statement fails.
    await db.batch(writes);
    return { persisted: true };
  } catch {
    if (
      params.commitDeadlineAt !== undefined &&
      Date.now() >= params.commitDeadlineAt
    ) {
      return {
        persisted: false,
        reason: "RECOVERY_DEADLINE_EXCEEDED",
      };
    }
    return { persisted: false, reason: "DB_UNAVAILABLE" };
  }
}

export type StoredItinerary = ItineraryRegistration & {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export const MAX_ACTIVE_ITINERARIES_PER_SESSION = 10;

function logRepositoryFailure(
  operation: string,
  requestId: string | undefined,
  error: unknown,
): void {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  console.error("[db] operation_failed", {
    operation,
    requestId: requestId ?? "unavailable",
    errorName:
      typeof candidate?.name === "string" ? candidate.name : "UnknownError",
    errorCode:
      typeof candidate?.code === "string" ||
      typeof candidate?.code === "number"
        ? String(candidate.code).slice(0, 80)
        : "unavailable",
  });
}

export async function saveItinerary(params: {
  sessionId: string;
  itinerary: ItineraryRegistration;
  analyticsConsent?: boolean;
  ephemeralLocationNodeIds?: string[];
  requestId?: string;
}): Promise<
  | { saved: true; itinerary: StoredItinerary }
  | {
      saved: false;
      reason:
        | "NOT_FOUND"
        | "INVALID_EPHEMERAL_LOCATION_NODE"
        | "DB_UNAVAILABLE";
    }
> {
  try {
    const db = getDb();
    const itineraryId = params.itinerary.id ?? crypto.randomUUID();
    const [currentSession, existing] = await Promise.all([
      db
        .select({ analyticsConsent: sessions.analyticsConsent })
        .from(sessions)
        .where(eq(sessions.id, params.sessionId))
        .limit(1),
      db
        .select({
          sessionId: itineraries.sessionId,
          createdAt: itineraries.createdAt,
        })
        .from(itineraries)
        .where(eq(itineraries.id, itineraryId))
        .limit(1),
    ]);
    const analyticsConsent =
      params.analyticsConsent ??
      currentSession[0]?.analyticsConsent ??
      false;
    if (
      existing[0] &&
      existing[0].sessionId !== params.sessionId
    ) {
      return { saved: false, reason: "NOT_FOUND" };
    }

    const now = new Date().toISOString();
    const expiresAt = expiresInDays(30);
    const normalizedNodes = params.itinerary.nodes
      .map((node, index) => ({
        ...node,
        sequence: node.sequence ?? index,
      }))
      .sort((a, b) => a.sequence - b.sequence);
    const ephemeralLocationNodeIds = new Set(
      params.ephemeralLocationNodeIds ?? [],
    );
    if (
      [...ephemeralLocationNodeIds].some((nodeId) => {
        const node = normalizedNodes.find((item) => item.id === nodeId);
        return !node || node.locked || node.reservation;
      })
    ) {
      return {
        saved: false,
        reason: "INVALID_EPHEMERAL_LOCATION_NODE",
      };
    }
    const storedNodes = normalizedNodes.map((node) =>
      ephemeralLocationNodeIds.has(node.id)
        ? { ...node, location: undefined }
        : node,
    );
    const lockedNodeCount = storedNodes.filter(
      (node) => node.locked || node.reservation,
    ).length;

    const writes = sessionWriteBatch({
      db,
      sessionId: params.sessionId,
      analyticsConsent,
      currentAnalyticsConsent: currentSession[0]?.analyticsConsent,
    });
    const itineraryValues = {
      id: itineraryId,
      sessionId: params.sessionId,
      title: params.itinerary.title,
      timezone: params.itinerary.timezone,
      audience: params.itinerary.audience,
      status: "active",
      nodeCount: normalizedNodes.length,
      lockedNodeCount,
      analyticsEligible: analyticsConsent,
      updatedAt: now,
      expiresAt,
    };
    if (existing[0]) {
      writes.push(
        db
          .update(itineraries)
          .set({
            title: params.itinerary.title,
            timezone: params.itinerary.timezone,
            audience: params.itinerary.audience,
            status: "active",
            nodeCount: normalizedNodes.length,
            lockedNodeCount,
            analyticsEligible: analyticsConsent,
            updatedAt: now,
            expiresAt,
            deletedAt: null,
          })
          .where(
            and(
              eq(itineraries.id, itineraryId),
              eq(itineraries.sessionId, params.sessionId),
            ),
          ),
      );
    } else {
      const newestActiveItineraries = db
        .select({ id: itineraries.id })
        .from(itineraries)
        .where(
          and(
            eq(itineraries.sessionId, params.sessionId),
            eq(itineraries.status, "active"),
            isNull(itineraries.deletedAt),
            gt(itineraries.expiresAt, now),
          ),
        )
        .orderBy(desc(itineraries.updatedAt))
        .limit(MAX_ACTIVE_ITINERARIES_PER_SESSION - 1);
      /* D1 serializes each batch. Pruning to nine inside the same batch before
         a new insert keeps the active set at ten even when concurrent creates
         reached the Worker through different isolates. Cascading foreign keys
         remove nodes belonging to the replaced oldest itinerary. */
      writes.push(
        db
          .delete(itineraries)
          .where(
            and(
              eq(itineraries.sessionId, params.sessionId),
              eq(itineraries.status, "active"),
              isNull(itineraries.deletedAt),
              gt(itineraries.expiresAt, now),
              notInArray(itineraries.id, newestActiveItineraries),
            ),
          ),
      );
      writes.push(
        db.insert(itineraries).values(itineraryValues),
      );
    }
    writes.push(
      db
        .delete(itineraryNodes)
        .where(eq(itineraryNodes.itineraryId, itineraryId)),
    );
    for (const node of storedNodes) {
      writes.push(
        db.insert(itineraryNodes).values({
          id: `${itineraryId}:${node.id}`,
          itineraryId,
          clientNodeId: node.id,
          sequence: node.sequence,
          type: node.type,
          title: node.title,
          startAt: node.startAt ?? null,
          endAt: node.endAt ?? null,
          durationMinutes: node.durationMinutes ?? null,
          locked: node.locked,
          reservation: node.reservation,
          locationLabel: node.location?.label ?? null,
          latitude: node.location?.latitude ?? null,
          longitude: node.location?.longitude ?? null,
          regionCode: node.location?.areaCode ?? null,
          districtCode: node.location?.sigunguCode ?? null,
        }),
      );
    }

    // The itinerary header, replacement node set, session refresh and consent
    // event must either all commit or all roll back.
    await db.batch(writes);

    return {
      saved: true,
      itinerary: {
        ...params.itinerary,
        id: itineraryId,
        nodes: storedNodes,
        status: "active",
        createdAt: existing[0]?.createdAt ?? now,
        updatedAt: now,
        expiresAt,
      },
    };
  } catch (error) {
    // Never return D1 text to the browser: it can contain schema, query, or
    // bound-value details. Operators correlate this bounded server log with
    // the public request id instead.
    logRepositoryFailure("save_itinerary", params.requestId, error);
    return {
      saved: false,
      reason: "DB_UNAVAILABLE",
    };
  }
}

export async function getSessionItineraries(
  sessionId: string,
): Promise<StoredItinerary[]> {
  try {
    const db = getDb();
    const itineraryRows = await db
      .select({
        id: itineraries.id,
        title: itineraries.title,
        timezone: itineraries.timezone,
        audience: itineraries.audience,
        status: itineraries.status,
        createdAt: itineraries.createdAt,
        updatedAt: itineraries.updatedAt,
        expiresAt: itineraries.expiresAt,
      })
      .from(itineraries)
      .where(
        and(
          eq(itineraries.sessionId, sessionId),
          eq(itineraries.status, "active"),
          isNull(itineraries.deletedAt),
          gt(itineraries.expiresAt, new Date().toISOString()),
        ),
      )
      .orderBy(desc(itineraries.updatedAt))
      .limit(10);

    const result: StoredItinerary[] = [];
    for (const itinerary of itineraryRows) {
      const nodeRows = await db
        .select({
          id: itineraryNodes.clientNodeId,
          sequence: itineraryNodes.sequence,
          type: itineraryNodes.type,
          title: itineraryNodes.title,
          startAt: itineraryNodes.startAt,
          endAt: itineraryNodes.endAt,
          durationMinutes: itineraryNodes.durationMinutes,
          locked: itineraryNodes.locked,
          reservation: itineraryNodes.reservation,
          locationLabel: itineraryNodes.locationLabel,
          latitude: itineraryNodes.latitude,
          longitude: itineraryNodes.longitude,
          areaCode: itineraryNodes.regionCode,
          sigunguCode: itineraryNodes.districtCode,
        })
        .from(itineraryNodes)
        .where(eq(itineraryNodes.itineraryId, itinerary.id))
        .orderBy(itineraryNodes.sequence);
      result.push({
        id: itinerary.id,
        title: itinerary.title,
        timezone: itinerary.timezone as "Asia/Seoul",
        audience: itinerary.audience as ItineraryRegistration["audience"],
        status: itinerary.status,
        createdAt: itinerary.createdAt,
        updatedAt: itinerary.updatedAt,
        expiresAt: itinerary.expiresAt,
        nodes: nodeRows.map((node) => ({
          id: node.id,
          sequence: node.sequence,
          type: node.type as ItineraryRegistration["nodes"][number]["type"],
          title: node.title,
          startAt: node.startAt ?? undefined,
          endAt: node.endAt ?? undefined,
          durationMinutes: node.durationMinutes ?? undefined,
          locked: node.locked,
          reservation: node.reservation,
          location:
            node.latitude !== null &&
            node.longitude !== null &&
            node.locationLabel
              ? {
                  latitude: node.latitude,
                  longitude: node.longitude,
                  label: node.locationLabel,
                  areaCode: node.areaCode ?? undefined,
                  sigunguCode: node.sigunguCode ?? undefined,
                }
              : undefined,
        })),
      });
    }
    return result;
  } catch {
    throw new Error("DB_UNAVAILABLE");
  }
}

export async function getOwnedSessionItinerary(params: {
  sessionId: string;
  itineraryId: string;
}): Promise<
  | { found: true; itinerary: StoredItinerary }
  | { found: false; reason: "NOT_FOUND" | "DB_UNAVAILABLE" }
> {
  try {
    const db = getDb();
    const itineraryRows = await db
      .select({
        id: itineraries.id,
        title: itineraries.title,
        timezone: itineraries.timezone,
        audience: itineraries.audience,
        status: itineraries.status,
        createdAt: itineraries.createdAt,
        updatedAt: itineraries.updatedAt,
        expiresAt: itineraries.expiresAt,
      })
      .from(itineraries)
      .where(
        and(
          eq(itineraries.id, params.itineraryId),
          eq(itineraries.sessionId, params.sessionId),
          eq(itineraries.status, "active"),
          isNull(itineraries.deletedAt),
          gt(itineraries.expiresAt, new Date().toISOString()),
        ),
      )
      .limit(1);
    const itinerary = itineraryRows[0];
    if (!itinerary) {
      return { found: false, reason: "NOT_FOUND" };
    }

    const nodeRows = await db
      .select({
        id: itineraryNodes.clientNodeId,
        sequence: itineraryNodes.sequence,
        type: itineraryNodes.type,
        title: itineraryNodes.title,
        startAt: itineraryNodes.startAt,
        endAt: itineraryNodes.endAt,
        durationMinutes: itineraryNodes.durationMinutes,
        locked: itineraryNodes.locked,
        reservation: itineraryNodes.reservation,
        locationLabel: itineraryNodes.locationLabel,
        latitude: itineraryNodes.latitude,
        longitude: itineraryNodes.longitude,
        areaCode: itineraryNodes.regionCode,
        sigunguCode: itineraryNodes.districtCode,
      })
      .from(itineraryNodes)
      .where(eq(itineraryNodes.itineraryId, itinerary.id))
      .orderBy(itineraryNodes.sequence);

    return {
      found: true,
      itinerary: {
        id: itinerary.id,
        title: itinerary.title,
        timezone: itinerary.timezone as "Asia/Seoul",
        audience:
          itinerary.audience as ItineraryRegistration["audience"],
        status: itinerary.status,
        createdAt: itinerary.createdAt,
        updatedAt: itinerary.updatedAt,
        expiresAt: itinerary.expiresAt,
        nodes: nodeRows.map((node) => ({
          id: node.id,
          sequence: node.sequence,
          type:
            node.type as ItineraryRegistration["nodes"][number]["type"],
          title: node.title,
          startAt: node.startAt ?? undefined,
          endAt: node.endAt ?? undefined,
          durationMinutes: node.durationMinutes ?? undefined,
          locked: node.locked,
          reservation: node.reservation,
          location:
            node.latitude !== null &&
            node.longitude !== null &&
            node.locationLabel
              ? {
                  latitude: node.latitude,
                  longitude: node.longitude,
                  label: node.locationLabel,
                  areaCode: node.areaCode ?? undefined,
                  sigunguCode: node.sigunguCode ?? undefined,
                }
              : undefined,
        })),
      },
    };
  } catch (error) {
    logRepositoryFailure("get_owned_session_itinerary", undefined, error);
    return { found: false, reason: "DB_UNAVAILABLE" };
  }
}

type JourneyExecutionHeader = {
  id: string;
  baseItineraryId: string;
  sourceRunId: string;
  sourceOptionId: string;
  status: string;
  currentStepSequence: number;
  nextFixedStepSequence: number;
  activatedAt: string;
  outcomePromptAt: string;
  contractMetAt: string | null;
  contractMissedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  expiresAt: string;
};

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function loadJourneyExecution(params: {
  db: ReturnType<typeof getDb>;
  sessionId: string;
  executionId?: string;
  activeOnly?: boolean;
}): Promise<JourneyExecution | null> {
  const conditions = [
    eq(journeyExecutions.sessionId, params.sessionId),
    gt(journeyExecutions.expiresAt, new Date().toISOString()),
  ];
  if (params.executionId) {
    conditions.push(eq(journeyExecutions.id, params.executionId));
  }
  if (params.activeOnly) {
    conditions.push(
      eq(journeyExecutions.activeSessionKey, params.sessionId),
    );
  }
  const rows = await params.db
    .select({
      id: journeyExecutions.id,
      baseItineraryId: journeyExecutions.baseItineraryId,
      sourceRunId: journeyExecutions.sourceRunId,
      sourceOptionId: journeyExecutions.sourceOptionId,
      status: journeyExecutions.status,
      currentStepSequence: journeyExecutions.currentStepSequence,
      nextFixedStepSequence: journeyExecutions.nextFixedStepSequence,
      activatedAt: journeyExecutions.activatedAt,
      outcomePromptAt: journeyExecutions.outcomePromptAt,
      contractMetAt: journeyExecutions.contractMetAt,
      contractMissedAt: journeyExecutions.contractMissedAt,
      completedAt: journeyExecutions.completedAt,
      updatedAt: journeyExecutions.updatedAt,
      expiresAt: journeyExecutions.expiresAt,
    })
    .from(journeyExecutions)
    .where(and(...conditions))
    .orderBy(desc(journeyExecutions.updatedAt))
    .limit(1);
  const header = rows[0] as JourneyExecutionHeader | undefined;
  if (!header) return null;

  const stepRows = await params.db
    .select({
      id: journeyExecutionSteps.id,
      sequence: journeyExecutionSteps.sequence,
      originalNodeId: journeyExecutionSteps.originalNodeId,
      role: journeyExecutionSteps.role,
      contentId: journeyExecutionSteps.contentId,
      title: journeyExecutionSteps.title,
      type: journeyExecutionSteps.type,
      scheduledAt: journeyExecutionSteps.scheduledAt,
      estimatedArrivalAt: journeyExecutionSteps.estimatedArrivalAt,
      durationMinutes: journeyExecutionSteps.durationMinutes,
      locationLabel: journeyExecutionSteps.locationLabel,
      latitude: journeyExecutionSteps.latitude,
      longitude: journeyExecutionSteps.longitude,
      locked: journeyExecutionSteps.locked,
      reservation: journeyExecutionSteps.reservation,
      verificationStatus: journeyExecutionSteps.verificationStatus,
      status: journeyExecutionSteps.status,
      arrivedAt: journeyExecutionSteps.arrivedAt,
    })
    .from(journeyExecutionSteps)
    .where(eq(journeyExecutionSteps.executionId, header.id))
    .orderBy(journeyExecutionSteps.sequence);

  const mapped = {
    id: header.id,
    baseItineraryId: header.baseItineraryId,
    sourceRunId: header.sourceRunId,
    sourceOptionId: header.sourceOptionId,
    status: header.status as JourneyExecution["status"],
    currentStepSequence: header.currentStepSequence,
    nextFixedStepSequence: header.nextFixedStepSequence,
    activatedAt: header.activatedAt,
    outcomePromptAt: header.outcomePromptAt,
    contractMetAt: header.contractMetAt ?? undefined,
    contractMissedAt: header.contractMissedAt ?? undefined,
    completedAt: header.completedAt ?? undefined,
    updatedAt: header.updatedAt,
    expiresAt: header.expiresAt,
    steps: stepRows.flatMap((step): JourneyExecutionStep[] => {
      if (
        typeof step.latitude !== "number" ||
        typeof step.longitude !== "number"
      ) {
        return [];
      }
      return [
        {
          id: step.id,
          sequence: step.sequence,
          originalNodeId: step.originalNodeId ?? undefined,
          role: step.role as JourneyExecutionStep["role"],
          contentId: step.contentId ?? undefined,
          title: step.title,
          type: step.type,
          scheduledAt: step.scheduledAt ?? undefined,
          estimatedArrivalAt: step.estimatedArrivalAt ?? undefined,
          durationMinutes: step.durationMinutes ?? undefined,
          locationLabel: step.locationLabel ?? undefined,
          latitude: step.latitude,
          longitude: step.longitude,
          locked: step.locked,
          reservation: step.reservation,
          verificationStatus:
            step.verificationStatus as JourneyExecutionStep["verificationStatus"],
          status: step.status as JourneyExecutionStep["status"],
          arrivedAt: step.arrivedAt ?? undefined,
        },
      ];
    }),
  };

  /* 동선 꼬임 판정은 저장된 값만으로 계산한다 — 새 호출도, 스키마 변경도 없다.
     조회 경로와 갱신 경로가 같은 이 함수를 지나므로 두 곳이 갈릴 수 없다. */
  return { ...mapped, drift: assessJourneyDrift(mapped) };
}

export async function getActiveJourneyExecution(
  sessionId: string,
): Promise<JourneyExecution | null> {
  try {
    return await loadJourneyExecution({
      db: getDb(),
      sessionId,
      activeOnly: true,
    });
  } catch {
    throw new Error("DB_UNAVAILABLE");
  }
}

export async function activateRecoveryExecution(params: {
  sessionId: string;
  runId: string;
  optionId: string;
  /* 운영시간 미확인 안에 대한 여행자의 동의. 화면이 보낸다. */
  acknowledgeUnverifiedHours?: boolean;
}): Promise<
  | { activated: true; execution: JourneyExecution }
  | {
      activated: false;
      reason:
        | "NOT_FOUND"
        | "INVALID_STATE"
        | "UPSTREAM_UNAVAILABLE"
        | "DB_UNAVAILABLE"
        /* 동의가 필요한 안인데 동의 없이 들어왔다. 상태가 잘못된 것이 아니라
           한 단계가 빠진 것이므로 따로 답한다. */
        | "ACKNOWLEDGEMENT_REQUIRED";
    }
> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const versionKey = `${params.runId}:${params.optionId}`;
    const existing = await db
      .select({
        id: journeyExecutions.id,
        status: journeyExecutions.status,
        activeSessionKey: journeyExecutions.activeSessionKey,
        expiresAt: journeyExecutions.expiresAt,
      })
      .from(journeyExecutions)
      .where(
        and(
          eq(journeyExecutions.sessionId, params.sessionId),
          eq(journeyExecutions.versionKey, versionKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (
        existing[0].status !== "active" ||
        existing[0].activeSessionKey !== params.sessionId ||
        Date.parse(existing[0].expiresAt) <= Date.parse(now)
      ) {
        return { activated: false, reason: "INVALID_STATE" };
      }
      const execution = await loadJourneyExecution({
        db,
        sessionId: params.sessionId,
        executionId: existing[0].id,
        activeOnly: true,
      });
      return execution
        ? { activated: true, execution }
        : { activated: false, reason: "INVALID_STATE" };
    }

    const runRows = await db
      .select({
        id: recoveryRuns.id,
        itineraryId: recoveryRuns.itineraryId,
        disruptedNodeId: recoveryRuns.disruptedNodeId,
        nextFixedNodeId: recoveryRuns.nextFixedNodeId,
        recoveryMode: recoveryRuns.recoveryMode,
        audience: recoveryRuns.audience,
        status: recoveryRuns.status,
        ruleVersion: recoveryRuns.ruleVersion,
        itineraryImpactHash: recoveryRuns.itineraryImpactHash,
        completedAt: recoveryRuns.completedAt,
        expiresAt: recoveryRuns.expiresAt,
      })
      .from(recoveryRuns)
      .where(
        and(
          eq(recoveryRuns.id, params.runId),
          eq(recoveryRuns.sessionId, params.sessionId),
          isNull(recoveryRuns.deletedAt),
          gt(recoveryRuns.expiresAt, now),
        ),
      )
      .limit(1);
    const run = runRows[0];
    if (!run) return { activated: false, reason: "NOT_FOUND" };
    if (
      (run.status !== "verified" && run.status !== "degraded") ||
      run.ruleVersion !== RECOVERY_RULE_VERSION ||
      !run.completedAt ||
      !Number.isFinite(Date.parse(run.completedAt)) ||
      !Number.isFinite(Date.parse(run.expiresAt)) ||
      Date.parse(run.expiresAt) <= Date.parse(now)
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }
    /* 빈 시간 추천에는 교체할 일정이 구조상 없다. 예전에는 이 세 값이 없다는
       이유로 INVALID_STATE를 돌려줘, 화면이 동의 체크박스와 적용 버튼을 정상
       노출한 뒤 마지막 클릭에서 반드시 409로 끝났다. 가상 페르소나 조사에서
       세 지역·세 runId·네 번의 시도가 모두 그렇게 실패했다.

       끼워 넣기의 실행 계획은 "그 한 곳에 도착한다" 한 단계다. 일정 복구처럼
       경유지를 이어 붙일 대상이 없으므로 단계를 만들어 낼 것도 없다. */
    const insertOnly = run.recoveryMode === "open_window";
    if (
      !insertOnly &&
      (!run.itineraryId || !run.disruptedNodeId || !run.nextFixedNodeId)
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }

    const optionRows = await db
      .select({
        id: recoveryOptions.id,
        contentId: recoveryOptions.contentId,
        title: recoveryOptions.title,
        status: recoveryOptions.status,
        scheduleDiffJson: recoveryOptions.scheduleDiffJson,
        changedNodeCount: recoveryOptions.changedNodeCount,
        applicationSnapshotJson:
          recoveryOptions.applicationSnapshotJson,
        safetyContractVersion:
          recoveryOptions.safetyContractVersion,
        availabilityStatus: recoveryOptions.availabilityStatus,
        availabilityCheckedAt:
          recoveryOptions.availabilityCheckedAt,
        visitStartAt: recoveryOptions.visitStartAt,
        visitEndAt: recoveryOptions.visitEndAt,
        confirmationRequired:
          recoveryOptions.confirmationRequired,
        evidenceGapCount: recoveryOptions.evidenceGapCount,
      })
      .from(recoveryOptions)
      .where(
        and(
          eq(recoveryOptions.id, params.optionId),
          eq(recoveryOptions.runId, params.runId),
        ),
      )
      .limit(1);
    const option = optionRows[0];
    if (!option) return { activated: false, reason: "NOT_FOUND" };
    if (!option.contentId || option.status !== "applicable") {
      return { activated: false, reason: "INVALID_STATE" };
    }
    const applicationSnapshot = await decryptApplicationSnapshot(
      option.applicationSnapshotJson,
      params.runId,
      params.optionId,
      { contentId: option.contentId, title: option.title },
    );
    if (!applicationSnapshot) {
      /* Missing/legacy/tampered contracts are all unsafe. A fresh recovery
         must be generated; mutable upstream data is never used as a bypass. */
      return { activated: false, reason: "INVALID_STATE" };
    }
    /* 운영시간을 대조하지 못한 안은 여행자가 그 사실을 읽고 동의했을 때만
       실행 계약이 된다. 화면에도 체크박스가 있지만 그것은 화면의 약속일 뿐이고,
       요청을 직접 만들면 지나갈 수 있다. 계약을 만드는 자리에서 다시 묻는다. */
    if (
      applicationSnapshotClass(applicationSnapshot) === "hours_unconfirmed" &&
      params.acknowledgeUnverifiedHours !== true
    ) {
      return { activated: false, reason: "ACKNOWLEDGEMENT_REQUIRED" };
    }
    const optionLatitude = applicationSnapshot.latitude;
    const optionLongitude = applicationSnapshot.longitude;
    const optionAddress = applicationSnapshot.address;
    const nowMs = Date.parse(now);
    const checkedAtMs = Date.parse(applicationSnapshot.availability.checkedAt);
    const visitStartMs = Date.parse(applicationSnapshot.visitStartAt);
    const visitEndMs = Date.parse(applicationSnapshot.visitEndAt);
    const scheduleDiff = parseJsonRecord(option.scheduleDiffJson);
    const replacement =
      scheduleDiff.replacementNode &&
      typeof scheduleDiff.replacementNode === "object" &&
      !Array.isArray(scheduleDiff.replacementNode)
        ? (scheduleDiff.replacementNode as Record<string, unknown>)
        : {};
    const SAFETY_EVIDENCE_MAX_AGE_MS = 15 * 60_000;
    /* 저장된 행과 봉인된 스냅숏이 **서로 일치**해야 한다. 예전에는 양쪽에
       `confirmed_open`과 공백 0을 각각 못박아 두 조건을 한꺼번에 검사했는데,
       그러면 계약이 두 갈래가 된 순간 동의를 받은 안까지 막힌다. 못박는 대신
       대조한다 — 위조를 막는 힘은 "값이 무엇이냐"가 아니라 "둘이 같으냐"에서
       나오고, 어느 갈래에 드는지는 위에서 `applicationSnapshotClass`가 이미
       판정했다. */
    if (
      option.safetyContractVersion !==
        APPLICATION_SAFETY_CONTRACT_VERSION ||
      option.availabilityStatus !== applicationSnapshot.availability.status ||
      option.availabilityCheckedAt !==
        applicationSnapshot.availability.checkedAt ||
      option.visitStartAt !== applicationSnapshot.visitStartAt ||
      option.visitEndAt !== applicationSnapshot.visitEndAt ||
      option.confirmationRequired !==
        applicationSnapshot.confirmationRequired ||
      option.evidenceGapCount !==
        applicationSnapshot.evidenceGapCodes.length ||
      applicationSnapshot.contractVersion !==
        APPLICATION_SAFETY_CONTRACT_VERSION ||
      applicationSnapshot.ruleVersion !== RECOVERY_RULE_VERSION ||
      applicationSnapshot.recoveryMode !== run.recoveryMode ||
      applicationSnapshotClass(applicationSnapshot) === undefined ||
      !Number.isFinite(checkedAtMs) ||
      checkedAtMs > nowMs + 60_000 ||
      nowMs - checkedAtMs > SAFETY_EVIDENCE_MAX_AGE_MS ||
      !Number.isFinite(visitStartMs) ||
      !Number.isFinite(visitEndMs) ||
      visitStartMs < nowMs ||
      visitEndMs <= visitStartMs ||
      replacement.startAt !== applicationSnapshot.visitStartAt ||
      replacement.endAt !== applicationSnapshot.visitEndAt
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }

    const itineraryRows = await db
      .select({ id: itineraries.id })
      .from(itineraries)
      .where(
        and(
          eq(itineraries.id, run.itineraryId ?? ""),
          eq(itineraries.sessionId, params.sessionId),
          isNull(itineraries.deletedAt),
          gt(itineraries.expiresAt, now),
        ),
      )
      .limit(1);
    if (!insertOnly && !itineraryRows[0]) {
      return { activated: false, reason: "NOT_FOUND" };
    }

    const nodeRows = await db
      .select({
        id: itineraryNodes.clientNodeId,
        sequence: itineraryNodes.sequence,
        type: itineraryNodes.type,
        title: itineraryNodes.title,
        startAt: itineraryNodes.startAt,
        endAt: itineraryNodes.endAt,
        durationMinutes: itineraryNodes.durationMinutes,
        locked: itineraryNodes.locked,
        reservation: itineraryNodes.reservation,
        locationLabel: itineraryNodes.locationLabel,
        latitude: itineraryNodes.latitude,
        longitude: itineraryNodes.longitude,
        regionCode: itineraryNodes.regionCode,
        districtCode: itineraryNodes.districtCode,
      })
      .from(itineraryNodes)
      .where(eq(itineraryNodes.itineraryId, run.itineraryId ?? ""))
      .orderBy(itineraryNodes.sequence);
    const disruptedIndex = insertOnly
      ? -1
      : nodeRows.findIndex((node) => node.id === run.disruptedNodeId);
    const nextFixedIndex = insertOnly
      ? -1
      : nodeRows.findIndex((node) => node.id === run.nextFixedNodeId);
    const originalNextFixed = insertOnly
      ? undefined
      : nodeRows[nextFixedIndex];
    if (
      !insertOnly &&
      (disruptedIndex < 0 ||
        nextFixedIndex <= disruptedIndex ||
        !originalNextFixed ||
        (!originalNextFixed.locked && !originalNextFixed.reservation) ||
        !originalNextFixed.startAt ||
        !Number.isFinite(Date.parse(originalNextFixed.startAt)) ||
        nodeRows.slice(disruptedIndex + 1).some(
          (node) =>
            koreaLatitude(node.latitude) === undefined ||
            koreaLongitude(node.longitude) === undefined,
        ))
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }

    if (!insertOnly) {
      const expectedImpact = applicationSnapshot.itineraryImpact;
      const currentImpact =
        run.itineraryId && run.disruptedNodeId && run.nextFixedNodeId
          ? await createItineraryImpactSnapshot({
              itineraryId: run.itineraryId,
              disruptedNodeId: run.disruptedNodeId,
              nextFixedNodeId: run.nextFixedNodeId,
              nodes: nodeRows.map((node) => ({
                id: node.id,
                sequence: node.sequence,
                type: node.type as ItineraryRegistration["nodes"][number]["type"],
                title: node.title,
                startAt: node.startAt ?? undefined,
                endAt: node.endAt ?? undefined,
                durationMinutes: node.durationMinutes ?? undefined,
                locked: node.locked,
                reservation: node.reservation,
                location:
                  node.locationLabel &&
                  node.latitude !== null &&
                  node.longitude !== null
                    ? {
                        label: node.locationLabel,
                        latitude: node.latitude,
                        longitude: node.longitude,
                        areaCode: node.regionCode ?? undefined,
                        sigunguCode: node.districtCode ?? undefined,
                      }
                    : undefined,
              })),
            })
          : undefined;
      if (
        !expectedImpact ||
        !currentImpact ||
        run.itineraryImpactHash !== expectedImpact.hash ||
        currentImpact.hash !== expectedImpact.hash ||
        JSON.stringify(currentImpact.nodes) !==
          JSON.stringify(expectedImpact.nodes)
      ) {
        return { activated: false, reason: "INVALID_STATE" };
      }
    }

    const nextFixedProof =
      scheduleDiff.nextFixedAppointment &&
      typeof scheduleDiff.nextFixedAppointment === "object" &&
      !Array.isArray(scheduleDiff.nextFixedAppointment)
        ? (scheduleDiff.nextFixedAppointment as Record<string, unknown>)
        : undefined;
    /* Applying a recommendation must never turn its estimated arrival into
       the appointment itself. The persisted proof is checked against the
       authoritative itinerary before any write. A stale or tampered option
       fails closed and the original locked node remains untouched. */
    if (
      !insertOnly &&
      (!originalNextFixed ||
        !nextFixedProof ||
        nextFixedProof.nodeId !== originalNextFixed.id ||
        nextFixedProof.title !== originalNextFixed.title ||
        nextFixedProof.status !== "preserved" ||
        typeof nextFixedProof.scheduledAt !== "string" ||
        typeof nextFixedProof.estimatedArrivalAt !== "string" ||
        Date.parse(nextFixedProof.scheduledAt) !==
          Date.parse(originalNextFixed.startAt as string) ||
        !applicationSnapshot.nextFixed ||
        applicationSnapshot.nextFixed.nodeId !== nextFixedProof.nodeId ||
        applicationSnapshot.nextFixed.scheduledAt !==
          nextFixedProof.scheduledAt ||
        applicationSnapshot.nextFixed.estimatedArrivalAt !==
          nextFixedProof.estimatedArrivalAt ||
        applicationSnapshot.nextFixed.status !== "preserved" ||
        Date.parse(applicationSnapshot.nextFixed.scheduledAt) <= nowMs ||
        Date.parse(applicationSnapshot.nextFixed.estimatedArrivalAt) >
          Date.parse(applicationSnapshot.nextFixed.scheduledAt))
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }
    if (insertOnly) {
      const openWindowProof =
        scheduleDiff.openWindow &&
        typeof scheduleDiff.openWindow === "object" &&
        !Array.isArray(scheduleDiff.openWindow)
          ? (scheduleDiff.openWindow as Record<string, unknown>)
          : undefined;
      const protectedWindow = applicationSnapshot.openWindow;
      const windowStartMs = Date.parse(
        protectedWindow?.windowStartAt ?? "",
      );
      const windowEndMs = Date.parse(protectedWindow?.windowEndAt ?? "");
      const returnCalculatedAtMs = Date.parse(
        protectedWindow?.returnCalculatedAt ?? "",
      );
      if (
        !openWindowProof ||
        !protectedWindow ||
        openWindowProof.status !== "fits" ||
        openWindowProof.windowStartAt !== protectedWindow.windowStartAt ||
        openWindowProof.windowEndAt !== protectedWindow.windowEndAt ||
        openWindowProof.returnMinutes !== protectedWindow.returnMinutes ||
        openWindowProof.returnBasis !== protectedWindow.returnBasis ||
        openWindowProof.returnProvider !== protectedWindow.returnProvider ||
        openWindowProof.returnDistanceMeters !==
          protectedWindow.returnDistanceMeters ||
        openWindowProof.returnCalculatedAt !==
          protectedWindow.returnCalculatedAt ||
        openWindowProof.requiredBufferMinutes !==
          protectedWindow.requiredBufferMinutes ||
        openWindowProof.leftoverMinutes !==
          protectedWindow.leftoverMinutes ||
        !Number.isFinite(windowStartMs) ||
        !Number.isFinite(windowEndMs) ||
        !Number.isFinite(returnCalculatedAtMs) ||
        nowMs < windowStartMs - 60_000 ||
        nowMs >= windowEndMs ||
        nowMs - returnCalculatedAtMs > SAFETY_EVIDENCE_MAX_AGE_MS ||
        returnCalculatedAtMs > nowMs + 60_000 ||
        visitStartMs < windowStartMs ||
        protectedWindow.leftoverMinutes <
          protectedWindow.requiredBufferMinutes ||
        Math.floor(
          (windowEndMs -
            (visitEndMs + protectedWindow.returnMinutes * 60_000)) /
            60_000,
        ) !== protectedWindow.leftoverMinutes ||
        visitEndMs +
            (protectedWindow.returnMinutes +
              protectedWindow.requiredBufferMinutes) *
              60_000 >
          windowEndMs
      ) {
        return { activated: false, reason: "INVALID_STATE" };
      }
    }
    const waypointRows = Array.isArray(scheduleDiff.preservedWaypoints)
      ? scheduleDiff.preservedWaypoints.flatMap((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? [entry as Record<string, unknown>]
            : [],
        )
      : [];
    const estimatedArrival = new Map(
      waypointRows.flatMap((waypoint) =>
        typeof waypoint.nodeId === "string"
          ? [
              [
                waypoint.nodeId,
                typeof waypoint.estimatedArrivalAt === "string"
                  ? waypoint.estimatedArrivalAt
                  : undefined,
              ] as const,
            ]
          : [],
      ),
    );
    const executionId = crypto.randomUUID();
    const steps: JourneyExecutionStep[] = [
      {
        id: `${executionId}:0`,
        sequence: 0,
        role: "replacement",
        contentId: option.contentId ?? undefined,
        title: option.title,
        type: "visit",
        scheduledAt:
          typeof replacement.startAt === "string"
            ? replacement.startAt
            : now,
        durationMinutes:
          typeof replacement.durationMinutes === "number"
            ? replacement.durationMinutes
            : undefined,
        locationLabel: optionAddress,
        latitude: optionLatitude,
        longitude: optionLongitude,
        locked: false,
        reservation: false,
        verificationStatus: "continuity_verified",
        status: "current",
      },
      ...(insertOnly ? [] : nodeRows.slice(disruptedIndex + 1))
        .map((node, index): JourneyExecutionStep => {
        const role: JourneyExecutionStepRole =
          node.id === run.nextFixedNodeId
            ? "next_fixed"
            : disruptedIndex + 1 + index < nextFixedIndex
              ? "preserved"
              : "remaining_original";
          return {
          id: `${executionId}:${index + 1}`,
          sequence: index + 1,
          originalNodeId: node.id,
          role,
          title: node.title,
          type: node.type,
          scheduledAt: node.startAt ?? undefined,
          estimatedArrivalAt: estimatedArrival.get(node.id),
          durationMinutes: node.durationMinutes ?? undefined,
          locationLabel: node.locationLabel ?? node.title,
          latitude: koreaLatitude(node.latitude) as number,
          longitude: koreaLongitude(node.longitude) as number,
          locked: node.locked,
          reservation: node.reservation,
            verificationStatus:
            role === "remaining_original"
              ? "resumed_original"
              : "continuity_verified",
            status: "pending",
          };
        }),
    ];
    /* 완주 확인을 언제 물을지의 기준점. 일정 복구는 다음 고정 일정 도착이고,
       끼워 넣기는 그 한 곳의 체류가 끝나는 시각이다. 알려 준 다음 장소가 있으면
       그 도착 시각을 쓴다 — 좌표가 없어 단계로는 만들 수 없지만 시각은 안다. */
    const nextFixedStepSequence = insertOnly
      ? 0
      : nextFixedIndex - disruptedIndex;
    const nextFixedStep = steps[nextFixedStepSequence];
    if (!nextFixedStep) {
      return { activated: false, reason: "INVALID_STATE" };
    }
    if (
      !insertOnly &&
      (!originalNextFixed ||
        nextFixedStep.role !== "next_fixed" ||
        nextFixedStep.originalNodeId !== originalNextFixed.id ||
        nextFixedStep.scheduledAt !== originalNextFixed.startAt ||
        nextFixedStep.locked !== originalNextFixed.locked ||
        nextFixedStep.reservation !== originalNextFixed.reservation ||
        nextFixedStep.locationLabel !==
          (originalNextFixed.locationLabel ?? originalNextFixed.title) ||
        nextFixedStep.latitude !== koreaLatitude(originalNextFixed.latitude) ||
        nextFixedStep.longitude !== koreaLongitude(originalNextFixed.longitude))
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }
    const openWindowNextArrival =
      nextFixedProof;
    const promptBasis = insertOnly
      ? (typeof openWindowNextArrival?.scheduledAt === "string"
          ? openWindowNextArrival.scheduledAt
          : typeof replacement.endAt === "string"
            ? replacement.endAt
            : now)
      : (nextFixedStep.estimatedArrivalAt ??
        nextFixedStep.scheduledAt ??
        now);
    const promptTime = Date.parse(promptBasis);
    const outcomePromptAt = Number.isFinite(promptTime)
      ? new Date(promptTime - 5 * 60_000).toISOString()
      : now;

    const writes: D1WriteBatch = [
      db
        .update(journeyExecutions)
        .set({
          status: "superseded",
          activeSessionKey: null,
          updatedAt: now,
        })
        .where(
          eq(journeyExecutions.activeSessionKey, params.sessionId),
        ),
    ];
    /* 끼워 넣기를 적용하면 실제로 "지금부터 여기 갔다 온다"는 한 곳짜리 일정이
       생긴다. 실행 기록은 기준 일정을 가리켜야 하고(`base_itinerary_id`는 필수
       컬럼이다), 그 일정을 여기서 같은 원자 배치로 만든다. 그래야 진행 조회·
       도착 확인·30일 보관·세션 삭제가 일정 복구와 완전히 같은 경로를 탄다.

       스키마를 바꿔 컬럼을 널 허용으로 만드는 방법도 있지만, 그러면 "적용했는데
       기준 일정이 없는 실행"이라는 상태가 생기고 진행 화면이 그것을 따로
       다뤄야 한다. 실제로 생긴 일정을 저장하는 편이 데이터와 사실이 맞는다. */
    const insertOnlyItineraryId = insertOnly ? crypto.randomUUID() : undefined;
    if (insertOnlyItineraryId) {
      writes.push(
        db.insert(itineraries).values({
          id: insertOnlyItineraryId,
          sessionId: params.sessionId,
          title: "지금 넣은 한 곳",
          timezone: "Asia/Seoul",
          audience: run.audience,
          status: "active",
          nodeCount: 1,
          lockedNodeCount: 0,
          /* 사용자가 분석 동의를 한 실행에서만 집계 대상이 된다. 이 값은
             복구 실행 시점에 이미 판정되어 run에 남아 있다. */
          analyticsEligible: false,
          createdAt: now,
          updatedAt: now,
          expiresAt: run.expiresAt,
        }),
      );
      writes.push(
        db.insert(itineraryNodes).values({
          id: crypto.randomUUID(),
          itineraryId: insertOnlyItineraryId,
          clientNodeId: "inserted-stop",
          sequence: 1,
          type: "visit",
          title: option.title,
          startAt:
            typeof replacement.startAt === "string"
              ? replacement.startAt
              : now,
          endAt:
            typeof replacement.endAt === "string"
              ? replacement.endAt
              : null,
          durationMinutes:
            typeof replacement.durationMinutes === "number"
              ? replacement.durationMinutes
              : null,
          locked: false,
          reservation: false,
          locationLabel: optionAddress,
          latitude: optionLatitude,
          longitude: optionLongitude,
        }),
      );
    }
    writes.push(
      db.insert(journeyExecutions).values({
        id: executionId,
        sessionId: params.sessionId,
        baseItineraryId: insertOnlyItineraryId ?? (run.itineraryId as string),
        sourceRunId: params.runId,
        sourceOptionId: params.optionId,
        versionKey,
        activeSessionKey: params.sessionId,
        status: "active",
        currentStepSequence: 0,
        nextFixedStepSequence,
        activatedAt: now,
        outcomePromptAt,
        updatedAt: now,
        expiresAt: run.expiresAt,
      }),
    );
    for (const step of steps) {
      writes.push(
        db.insert(journeyExecutionSteps).values({
          id: step.id,
          executionId,
          sequence: step.sequence,
          originalNodeId: step.originalNodeId ?? null,
          role: step.role,
          contentId: step.contentId ?? null,
          title: step.title,
          type: step.type,
          scheduledAt: step.scheduledAt ?? null,
          estimatedArrivalAt: step.estimatedArrivalAt ?? null,
          durationMinutes: step.durationMinutes ?? null,
          locationLabel: step.locationLabel ?? null,
          latitude: step.latitude,
          longitude: step.longitude,
          locked: step.locked,
          reservation: step.reservation,
          verificationStatus: step.verificationStatus,
          status: step.status,
        }),
      );
    }
    writes.push(
      db
        .update(recoveryOptions)
        .set({ status: "applied" })
        .where(eq(recoveryOptions.id, params.optionId)),
      db.insert(recoveryOutcomes).values({
        id: crypto.randomUUID(),
        runId: params.runId,
        optionId: params.optionId,
        sessionId: params.sessionId,
        event: "applied",
        occurredAt: now,
        changedNodeCount: option.changedNodeCount ?? 1,
        metadataJson: JSON.stringify({ executionId }),
      }),
    );
    await db.batch(writes);

    const execution = await loadJourneyExecution({
      db,
      sessionId: params.sessionId,
      executionId,
    });
    return execution
      ? { activated: true, execution }
      : { activated: false, reason: "INVALID_STATE" };
  } catch (error) {
    logRepositoryFailure("activate_recovery_execution", undefined, error);
    return { activated: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function updateActiveJourneyExecution(params: {
  sessionId: string;
  action: JourneyExecutionActionInput;
}): Promise<
  | { updated: true; execution: JourneyExecution }
  | {
      updated: false;
      reason:
        | "NOT_FOUND"
        | "INVALID_STATE"
        | "ALREADY_FINALIZED"
        | "DB_UNAVAILABLE";
    }
> {
  try {
    const db = getDb();
    const execution = await loadJourneyExecution({
      db,
      sessionId: params.sessionId,
      activeOnly: true,
    });
    if (!execution) return { updated: false, reason: "NOT_FOUND" };
    if (
      execution.status === "completed" ||
      execution.status === "abandoned" ||
      execution.status === "superseded"
    ) {
      return { updated: false, reason: "ALREADY_FINALIZED" };
    }

    const now = new Date().toISOString();
    const executionGuard = db
      .update(journeyExecutions)
      .set({
        id: sql<string>`CASE
          WHEN ${journeyExecutions.status} = ${execution.status}
            AND ${journeyExecutions.currentStepSequence} = ${execution.currentStepSequence}
            AND ${journeyExecutions.activeSessionKey} = ${params.sessionId}
            AND ${journeyExecutions.expiresAt} > ${now}
          THEN ${journeyExecutions.id}
          ELSE NULL
        END`,
      })
      .where(eq(journeyExecutions.id, execution.id));
    if (params.action.action === "abandon") {
      const current = execution.steps.find(
        (step) => step.sequence === execution.currentStepSequence,
      );
      const writes: D1WriteBatch = [
        executionGuard,
        db
          .update(journeyExecutions)
          .set({
            /* Contract outcome and journey termination are separate facts.
               Keep met/missed timestamps, but never describe a traveler who
               stopped the remaining route as having completed it. */
            status: "abandoned",
            activeSessionKey: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(journeyExecutions.id, execution.id)),
      ];
      if (current) {
        writes.push(
          db
            .update(journeyExecutionSteps)
            .set({ status: "skipped" })
            .where(eq(journeyExecutionSteps.id, current.id)),
        );
      }
      writes.push(
        db
          .insert(recoveryOutcomes)
          .values({
            id: `${execution.sourceRunId}:${execution.id}:abandoned`,
            runId: execution.sourceRunId,
            optionId: execution.sourceOptionId,
            sessionId: params.sessionId,
            event: "abandoned",
            occurredAt: now,
            reasonCode: params.action.reasonCode,
            changedNodeCount: 1,
            metadataJson: JSON.stringify({
              executionId: execution.id,
              contractStatusBeforeTermination: execution.status,
            }),
          })
          .onConflictDoNothing({ target: recoveryOutcomes.id }),
      );
      await db.batch(writes);
      const updated = await loadJourneyExecution({
        db,
        sessionId: params.sessionId,
        executionId: execution.id,
      });
      return updated
        ? { updated: true, execution: updated }
        : { updated: false, reason: "INVALID_STATE" };
    }

    const current = execution.steps.find(
      (step) => step.sequence === execution.currentStepSequence,
    );
    if (!current || current.id !== params.action.stepId) {
      return { updated: false, reason: "INVALID_STATE" };
    }
    const currentStepGuard = db
      .update(journeyExecutionSteps)
      .set({
        id: sql<string>`CASE
          WHEN ${journeyExecutionSteps.status} = 'current'
          THEN ${journeyExecutionSteps.id}
          ELSE NULL
        END`,
      })
      .where(eq(journeyExecutionSteps.id, current.id));
    const isLast =
      current.sequence === execution.steps.length - 1;
    const isNextFixed =
      current.role === "next_fixed" &&
      current.sequence === execution.nextFixedStepSequence;
    const next = isLast
      ? undefined
      : execution.steps.find(
          (step) => step.sequence === current.sequence + 1,
        );
    if (!isLast && !next) {
      return { updated: false, reason: "INVALID_STATE" };
    }
    const scheduledAt = isNextFixed && current.scheduledAt
      ? Date.parse(current.scheduledAt)
      : Number.NaN;
    if (isNextFixed && !Number.isFinite(scheduledAt)) {
      return { updated: false, reason: "INVALID_STATE" };
    }
    const arrivedOnTime = isNextFixed
      ? Date.parse(now) <= scheduledAt
      : undefined;
    const nextStatus: JourneyExecution["status"] = isNextFixed
      ? arrivedOnTime
        ? isLast
          ? "completed"
          : "contract_met"
        : "contract_missed"
      : isLast
        ? execution.status === "contract_missed"
          ? "contract_missed"
          : "completed"
        : execution.status;
    const writes: D1WriteBatch = [
      executionGuard,
      currentStepGuard,
      db
        .update(journeyExecutionSteps)
        .set({ status: "arrived", arrivedAt: now })
        .where(eq(journeyExecutionSteps.id, current.id)),
    ];
    if (next) {
      writes.push(
        db
          .update(journeyExecutionSteps)
          .set({ status: "current" })
          .where(eq(journeyExecutionSteps.id, next.id)),
      );
    }
    writes.push(
      db
        .update(journeyExecutions)
        .set({
          status: nextStatus,
          currentStepSequence: next?.sequence ?? current.sequence,
          activeSessionKey: isLast ? null : params.sessionId,
          contractMetAt:
            isNextFixed && arrivedOnTime
              ? now
              : execution.contractMetAt ?? null,
          contractMissedAt:
            isNextFixed && !arrivedOnTime
              ? now
              : execution.contractMissedAt ?? null,
          completedAt: isLast ? now : null,
          updatedAt: now,
        })
        .where(eq(journeyExecutions.id, execution.id)),
    );
    if (isNextFixed) {
      writes.push(
        db
          .insert(recoveryOutcomes)
          .values({
            id: `${execution.sourceRunId}:final`,
            runId: execution.sourceRunId,
            optionId: execution.sourceOptionId,
            sessionId: params.sessionId,
            event: "arrived",
            occurredAt: now,
            actualArrivalAt: now,
            arrivedOnTime,
            changedNodeCount: 1,
            metadataJson: JSON.stringify({
              executionId: execution.id,
              stepId: current.id,
              arrivalEvidence: "self_reported",
            }),
          })
          .onConflictDoNothing({ target: recoveryOutcomes.id }),
      );
    }
    await db.batch(writes);
    const updated = await loadJourneyExecution({
      db,
      sessionId: params.sessionId,
      executionId: execution.id,
    });
    return updated
      ? { updated: true, execution: updated }
      : { updated: false, reason: "INVALID_STATE" };
  } catch (error) {
    return {
      updated: false,
      reason: isJourneyStateGuardFailure(error)
        ? "INVALID_STATE"
        : "DB_UNAVAILABLE",
    };
  }
}

export async function recordRecoveryOutcome(params: {
  sessionId: string;
  runId: string;
  outcome: RecoveryOutcomeInput;
}): Promise<
  | {
      recorded: true;
      outcome: {
        id: string;
        runId: string;
        optionId?: string;
        event: RecoveryOutcomeInput["event"];
        occurredAt: string;
        actualArrivalAt?: string;
        arrivedOnTime?: boolean;
      };
    }
  | {
      recorded: false;
      reason:
        | "NOT_FOUND"
        | "INVALID_STATE"
        | "ALREADY_FINALIZED"
        | "DB_UNAVAILABLE";
    }
> {
  if (params.outcome.event !== "selected") {
    return { recorded: false, reason: "INVALID_STATE" };
  }
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const ownedRun = await db
      .select({
        id: recoveryRuns.id,
        status: recoveryRuns.status,
        ruleVersion: recoveryRuns.ruleVersion,
      })
      .from(recoveryRuns)
      .where(
        and(
          eq(recoveryRuns.id, params.runId),
          eq(recoveryRuns.sessionId, params.sessionId),
          isNull(recoveryRuns.deletedAt),
          gt(recoveryRuns.expiresAt, now),
        ),
      )
      .limit(1);
    if (!ownedRun[0]) return { recorded: false, reason: "NOT_FOUND" };
    if (
      (ownedRun[0].status !== "verified" &&
        ownedRun[0].status !== "degraded") ||
      ownedRun[0].ruleVersion !== RECOVERY_RULE_VERSION
    ) {
      return { recorded: false, reason: "INVALID_STATE" };
    }

    const options = await db
      .select({
        id: recoveryOptions.id,
        status: recoveryOptions.status,
        changedNodeCount: recoveryOptions.changedNodeCount,
      })
      .from(recoveryOptions)
      .where(
        and(
          eq(recoveryOptions.id, params.outcome.optionId),
          eq(recoveryOptions.runId, params.runId),
        ),
      )
      .limit(1);
    const option = options[0];
    if (!option) return { recorded: false, reason: "NOT_FOUND" };
    if (option.status !== "applicable") {
      return { recorded: false, reason: "INVALID_STATE" };
    }
    const id = crypto.randomUUID();
    const values = {
      id,
      runId: params.runId,
      optionId: params.outcome.optionId,
      sessionId: params.sessionId,
      event: params.outcome.event,
      occurredAt: now,
      actualArrivalAt: null,
      arrivedOnTime: null,
      reasonCode: null,
      changedNodeCount: option.changedNodeCount ?? null,
      metadataJson: JSON.stringify({ telemetry: "selection" }),
    };
    await db.insert(recoveryOutcomes).values(values);

    return {
      recorded: true,
      outcome: {
        id,
        runId: params.runId,
        optionId: params.outcome.optionId,
        event: params.outcome.event,
        occurredAt: now,
      },
    };
  } catch {
    return { recorded: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function persistHealth(
  audits: KtoAudit[],
): Promise<PersistenceResult> {
  if (!hasExactKtoHealthSourceSet(audits)) {
    return { persisted: false, reason: "INVALID_HEALTH_SNAPSHOT" };
  }
  try {
    const db = getDb();
    const checkedAt = new Date().toISOString();
    const writes = audits.map((audit) =>
      db
        .insert(sourceHealth)
        .values({
          sourceName: audit.apiName,
          operation: audit.operation,
          status: audit.status,
          latencyMs: audit.latencyMs,
          resultCount: audit.resultCount,
          sourceReferenceDate: audit.sourceReferenceDate ?? null,
          checkedAt,
          errorCode: audit.errorCode ?? null,
        })
        .onConflictDoUpdate({
          target: sourceHealth.sourceName,
          set: {
            operation: audit.operation,
            status: audit.status,
            latencyMs: audit.latencyMs,
            resultCount: audit.resultCount,
            sourceReferenceDate: audit.sourceReferenceDate ?? null,
            checkedAt,
            errorCode: audit.errorCode ?? null,
          },
        }),
    ) as unknown as D1WriteBatch;
    // A health generation is all eight required services or none of them.
    // D1 rolls the complete batch back when any individual upsert fails.
    await db.batch(writes);
    return { persisted: true };
  } catch (error) {
    logRepositoryFailure("persist_health_snapshot", undefined, error);
    return { persisted: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function getStoredHealthSnapshot(): Promise<
  Array<{
    apiName: string;
    operation: string;
    status: string;
    latencyMs: number;
    resultCount: number;
    sourceReferenceDate?: string;
    checkedAt: string;
    errorCode?: string;
  }>
> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sourceHealth)
    .orderBy(sourceHealth.sourceName);
  return rows.map((row) => ({
    apiName: row.sourceName,
    operation: row.operation,
    status: row.status,
    latencyMs: row.latencyMs,
    resultCount: row.resultCount,
    sourceReferenceDate: row.sourceReferenceDate ?? undefined,
    checkedAt: row.checkedAt,
    errorCode: row.errorCode ?? undefined,
  }));
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function isKnownAdministrativeScope(params: {
  regionCode: string;
  districtCode: string;
}): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ code: administrativeAreas.code })
    .from(administrativeAreas)
    .where(
      and(
        eq(administrativeAreas.code, params.districtCode),
        eq(administrativeAreas.parentCode, params.regionCode),
        eq(administrativeAreas.level, "district"),
        eq(administrativeAreas.active, true),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

export async function areKnownAdministrativeScopes(
  scopes: Array<{ regionCode: string; districtCode: string }>,
): Promise<boolean> {
  const uniqueScopes = [
    ...new Map(
      scopes.map((scope) => [
        `${scope.regionCode}:${scope.districtCode}`,
        scope,
      ]),
    ).values(),
  ];
  if (uniqueScopes.length === 0) return true;
  const rows = await getDb()
    .select({
      code: administrativeAreas.code,
      parentCode: administrativeAreas.parentCode,
    })
    .from(administrativeAreas)
    .where(
      and(
        or(
          ...uniqueScopes.map((scope) =>
            and(
              eq(administrativeAreas.code, scope.districtCode),
              eq(administrativeAreas.parentCode, scope.regionCode),
            ),
          ),
        ),
        eq(administrativeAreas.level, "district"),
        eq(administrativeAreas.active, true),
      ),
    );
  const found = new Set(
    rows.map((row) => `${row.parentCode}:${row.code}`),
  );
  return uniqueScopes.every((scope) =>
    found.has(`${scope.regionCode}:${scope.districtCode}`),
  );
}

export async function persistPolicySnapshot(params: {
  regionCode: string;
  districtCode?: string;
  baseMonth: string;
  status: string;
  coveragePercent: number;
  metrics: unknown;
  sourceLedger: KtoAudit[];
  calculationVersion: string;
  r2Key?: string;
}): Promise<PersistenceResult> {
  try {
    const db = getDb();
    const metricsJson = JSON.stringify(params.metrics);
    const sourceLedgerJson = JSON.stringify(params.sourceLedger);
    const checksum = await sha256(
      `${params.regionCode}|${params.districtCode ?? ""}|${params.baseMonth}|${params.calculationVersion}|${metricsJson}|${sourceLedgerJson}`,
    );
    await db
      .insert(regionPolicySnapshots)
      .values({
        id: crypto.randomUUID(),
        regionCode: params.regionCode,
        districtCode: params.districtCode ?? "_all",
        baseMonth: params.baseMonth,
        status: params.status,
        coveragePercent: params.coveragePercent,
        metricsJson,
        sourceLedgerJson,
        calculationVersion: params.calculationVersion,
        checksum,
        r2Key: params.r2Key ?? null,
      })
      .onConflictDoUpdate({
        target: [
          regionPolicySnapshots.regionCode,
          regionPolicySnapshots.districtCode,
          regionPolicySnapshots.baseMonth,
          regionPolicySnapshots.calculationVersion,
        ],
        set: {
          status: params.status,
          coveragePercent: params.coveragePercent,
          metricsJson,
          sourceLedgerJson,
          checksum,
          r2Key: params.r2Key ?? null,
        },
      });
    return { persisted: true };
  } catch (error) {
    logRepositoryFailure("persist_mission_evidence", undefined, error);
    return { persisted: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function persistRegionPackMetadata(params: {
  regionCode: string;
  districtCode?: string;
  baseMonth: string;
  calculationVersion: string;
  objectKey: string;
  checksum: string;
  status: string;
  coveragePercent: number;
  sourceUpdatedAt: string;
}): Promise<PersistenceResult> {
  try {
    const db = getDb();
    await db.insert(regionPacks).values({
      id: crypto.randomUUID(),
      regionCode: params.regionCode,
      districtCode: params.districtCode ?? "_all",
      baseMonth: params.baseMonth,
      calculationVersion: params.calculationVersion,
      objectKey: params.objectKey,
      checksum: params.checksum,
      status: params.status,
      coveragePercent: params.coveragePercent,
      sourceUpdatedAt: params.sourceUpdatedAt,
      activatedAt: new Date().toISOString(),
    });
    return { persisted: true };
  } catch (error) {
    logRepositoryFailure("persist_region_pack_metadata", undefined, error);
    return { persisted: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function deleteSessionData(
  sessionId: string,
): Promise<PersistenceResult> {
  try {
    const db = getDb();
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return { persisted: true };
  } catch (error) {
    logRepositoryFailure("delete_session_data", undefined, error);
    return { persisted: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function createProofShare(params: {
  sessionId: string;
  runId: string;
  optionId: string;
}): Promise<
  | {
      created: true;
      token: string;
      expiresAt: string;
      proof: Record<string, unknown>;
    }
  | {
      created: false;
      reason: "NOT_FOUND" | "INVALID_STATE" | "DB_UNAVAILABLE";
    }
> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const rows = await db
      .select({
        runId: recoveryRuns.id,
        incident: recoveryRuns.incident,
        audience: recoveryRuns.audience,
        regionCode: recoveryRuns.regionCode,
        districtCode: recoveryRuns.districtCode,
        status: recoveryRuns.status,
        recoveryMode: recoveryRuns.recoveryMode,
        itineraryId: recoveryRuns.itineraryId,
        disruptedNodeId: recoveryRuns.disruptedNodeId,
        nextFixedNodeId: recoveryRuns.nextFixedNodeId,
        ruleVersion: recoveryRuns.ruleVersion,
        itineraryImpactHash: recoveryRuns.itineraryImpactHash,
        completedAt: recoveryRuns.completedAt,
        expiresAt: recoveryRuns.expiresAt,
        counterfactualJson: recoveryRuns.counterfactualJson,
        optionId: recoveryOptions.id,
        rank: recoveryOptions.rank,
        contentId: recoveryOptions.contentId,
        title: recoveryOptions.title,
        contentTypeId: recoveryOptions.contentTypeId,
        score: recoveryOptions.score,
        distanceBucket: recoveryOptions.distanceBucket,
        travelMinutesBucket: recoveryOptions.travelMinutesBucket,
        accessibilityStatus: recoveryOptions.accessibilityStatus,
        crowdStatus: recoveryOptions.crowdStatus,
        sourceNamesJson: recoveryOptions.sourceNamesJson,
        scheduleDiffJson: recoveryOptions.scheduleDiffJson,
        continuityProofJson: recoveryOptions.continuityProofJson,
        optionStatus: recoveryOptions.status,
        applicationSnapshotJson:
          recoveryOptions.applicationSnapshotJson,
        safetyContractVersion:
          recoveryOptions.safetyContractVersion,
        availabilityStatus: recoveryOptions.availabilityStatus,
        availabilityCheckedAt:
          recoveryOptions.availabilityCheckedAt,
        visitStartAt: recoveryOptions.visitStartAt,
        visitEndAt: recoveryOptions.visitEndAt,
        confirmationRequired:
          recoveryOptions.confirmationRequired,
        evidenceGapCount: recoveryOptions.evidenceGapCount,
      })
      .from(recoveryRuns)
      .innerJoin(
        recoveryOptions,
        eq(recoveryOptions.runId, recoveryRuns.id),
      )
      .where(
        and(
          eq(recoveryRuns.id, params.runId),
          eq(recoveryRuns.sessionId, params.sessionId),
          eq(recoveryOptions.id, params.optionId),
          isNull(recoveryRuns.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { created: false, reason: "NOT_FOUND" };

    if (
      (row.status !== "verified" && row.status !== "degraded") ||
      row.ruleVersion !== RECOVERY_RULE_VERSION ||
      !row.completedAt ||
      !Number.isFinite(Date.parse(row.completedAt)) ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      (row.optionStatus !== "applicable" &&
        row.optionStatus !== "applied") ||
      !row.contentId
    ) {
      return { created: false, reason: "INVALID_STATE" };
    }
    const applicationSnapshot = await decryptApplicationSnapshot(
      row.applicationSnapshotJson,
      row.runId,
      row.optionId,
      { contentId: row.contentId, title: row.title },
    );
    if (!applicationSnapshot) {
      return { created: false, reason: "INVALID_STATE" };
    }
    const executionRows = row.optionStatus === "applied"
      ? await db
          .select({
            id: journeyExecutions.id,
            status: journeyExecutions.status,
            activatedAt: journeyExecutions.activatedAt,
            contractMetAt: journeyExecutions.contractMetAt,
            contractMissedAt: journeyExecutions.contractMissedAt,
            completedAt: journeyExecutions.completedAt,
            updatedAt: journeyExecutions.updatedAt,
            expiresAt: journeyExecutions.expiresAt,
          })
          .from(journeyExecutions)
          .where(
            and(
              eq(journeyExecutions.sessionId, params.sessionId),
              eq(journeyExecutions.sourceRunId, row.runId),
              eq(journeyExecutions.sourceOptionId, row.optionId),
              gt(journeyExecutions.expiresAt, now),
            ),
          )
          .orderBy(desc(journeyExecutions.updatedAt))
          .limit(1)
      : [];
    const sealedExecution = executionRows[0];
    const checkedAtMs = Date.parse(applicationSnapshot.availability.checkedAt);
    const visitStartMs = Date.parse(applicationSnapshot.visitStartAt);
    const visitEndMs = Date.parse(applicationSnapshot.visitEndAt);
    const SAFETY_EVIDENCE_MAX_AGE_MS = 15 * 60_000;
    const scheduleDiff = parseJsonRecord(row.scheduleDiffJson);
    const replacement =
      scheduleDiff.replacementNode &&
      typeof scheduleDiff.replacementNode === "object" &&
      !Array.isArray(scheduleDiff.replacementNode)
        ? (scheduleDiff.replacementNode as Record<string, unknown>)
        : {};
    if (
      row.safetyContractVersion !==
        APPLICATION_SAFETY_CONTRACT_VERSION ||
      row.availabilityStatus !== "confirmed_open" ||
      row.availabilityCheckedAt !==
        applicationSnapshot.availability.checkedAt ||
      row.visitStartAt !== applicationSnapshot.visitStartAt ||
      row.visitEndAt !== applicationSnapshot.visitEndAt ||
      row.confirmationRequired !== false ||
      row.evidenceGapCount !== 0 ||
      applicationSnapshot.contractVersion !==
        APPLICATION_SAFETY_CONTRACT_VERSION ||
      applicationSnapshot.ruleVersion !== RECOVERY_RULE_VERSION ||
      applicationSnapshot.recoveryMode !== row.recoveryMode ||
      applicationSnapshot.confirmationRequired !== false ||
      applicationSnapshot.evidenceGapCodes.length !== 0 ||
      applicationSnapshot.availability.status !== "confirmed_open" ||
      !Number.isFinite(checkedAtMs) ||
      !Number.isFinite(visitStartMs) ||
      !Number.isFinite(visitEndMs) ||
      visitEndMs <= visitStartMs ||
      replacement.startAt !== applicationSnapshot.visitStartAt ||
      replacement.endAt !== applicationSnapshot.visitEndAt
    ) {
      return { created: false, reason: "INVALID_STATE" };
    }
    const actionableContractIsCurrent =
      Date.parse(row.expiresAt) > nowMs &&
      checkedAtMs <= nowMs + 60_000 &&
      nowMs - checkedAtMs <= SAFETY_EVIDENCE_MAX_AGE_MS &&
      visitStartMs >= nowMs;
    const historicalProof = Boolean(
      sealedExecution &&
        (sealedExecution.status !== "active" ||
          !actionableContractIsCurrent),
    );
    if (!actionableContractIsCurrent && !sealedExecution) {
      return { created: false, reason: "INVALID_STATE" };
    }

    if (historicalProof) {
      if (row.recoveryMode === "registered_itinerary") {
        const nextFixed = applicationSnapshot.nextFixed;
        const nextFixedProof =
          scheduleDiff.nextFixedAppointment &&
          typeof scheduleDiff.nextFixedAppointment === "object" &&
          !Array.isArray(scheduleDiff.nextFixedAppointment)
            ? (scheduleDiff.nextFixedAppointment as Record<string, unknown>)
            : undefined;
        if (
          !row.itineraryId ||
          !row.disruptedNodeId ||
          !row.nextFixedNodeId ||
          !applicationSnapshot.itineraryImpact ||
          row.itineraryImpactHash !==
            applicationSnapshot.itineraryImpact.hash ||
          !nextFixed ||
          !nextFixedProof ||
          nextFixedProof.nodeId !== nextFixed.nodeId ||
          nextFixedProof.scheduledAt !== nextFixed.scheduledAt ||
          nextFixedProof.estimatedArrivalAt !==
            nextFixed.estimatedArrivalAt ||
          nextFixedProof.status !== "preserved" ||
          Date.parse(nextFixed.estimatedArrivalAt) >
            Date.parse(nextFixed.scheduledAt)
        ) {
          return { created: false, reason: "INVALID_STATE" };
        }
      } else if (row.recoveryMode === "open_window") {
        const protectedWindow = applicationSnapshot.openWindow;
        const openWindowProof =
          scheduleDiff.openWindow &&
          typeof scheduleDiff.openWindow === "object" &&
          !Array.isArray(scheduleDiff.openWindow)
            ? (scheduleDiff.openWindow as Record<string, unknown>)
            : undefined;
        if (
          !protectedWindow ||
          !openWindowProof ||
          openWindowProof.status !== "fits" ||
          openWindowProof.windowStartAt !== protectedWindow.windowStartAt ||
          openWindowProof.windowEndAt !== protectedWindow.windowEndAt ||
          openWindowProof.returnMinutes !== protectedWindow.returnMinutes ||
          openWindowProof.returnBasis !== protectedWindow.returnBasis ||
          openWindowProof.returnProvider !== protectedWindow.returnProvider ||
          openWindowProof.returnDistanceMeters !==
            protectedWindow.returnDistanceMeters ||
          openWindowProof.returnCalculatedAt !==
            protectedWindow.returnCalculatedAt ||
          openWindowProof.requiredBufferMinutes !==
            protectedWindow.requiredBufferMinutes ||
          openWindowProof.leftoverMinutes !==
            protectedWindow.leftoverMinutes ||
          visitStartMs < Date.parse(protectedWindow.windowStartAt) ||
          protectedWindow.leftoverMinutes <
            protectedWindow.requiredBufferMinutes ||
          Math.floor(
            (Date.parse(protectedWindow.windowEndAt) -
              (visitEndMs + protectedWindow.returnMinutes * 60_000)) /
              60_000,
          ) !== protectedWindow.leftoverMinutes ||
          visitEndMs +
              (protectedWindow.returnMinutes +
                protectedWindow.requiredBufferMinutes) *
                60_000 >
            Date.parse(protectedWindow.windowEndAt)
        ) {
          return { created: false, reason: "INVALID_STATE" };
        }
      } else {
        return { created: false, reason: "INVALID_STATE" };
      }
    } else if (row.recoveryMode === "registered_itinerary") {
      if (
        !row.itineraryId ||
        !row.disruptedNodeId ||
        !row.nextFixedNodeId ||
        !applicationSnapshot.itineraryImpact ||
        row.itineraryImpactHash !==
          applicationSnapshot.itineraryImpact.hash
      ) {
        return { created: false, reason: "INVALID_STATE" };
      }
      const itineraryRows = await db
        .select({ id: itineraries.id })
        .from(itineraries)
        .where(
          and(
            eq(itineraries.id, row.itineraryId),
            eq(itineraries.sessionId, params.sessionId),
            isNull(itineraries.deletedAt),
            gt(itineraries.expiresAt, now),
          ),
        )
        .limit(1);
      if (!itineraryRows[0]) {
        return { created: false, reason: "INVALID_STATE" };
      }
      const nodeRows = await db
        .select({
          id: itineraryNodes.clientNodeId,
          sequence: itineraryNodes.sequence,
          type: itineraryNodes.type,
          title: itineraryNodes.title,
          startAt: itineraryNodes.startAt,
          endAt: itineraryNodes.endAt,
          durationMinutes: itineraryNodes.durationMinutes,
          locked: itineraryNodes.locked,
          reservation: itineraryNodes.reservation,
          locationLabel: itineraryNodes.locationLabel,
          latitude: itineraryNodes.latitude,
          longitude: itineraryNodes.longitude,
          regionCode: itineraryNodes.regionCode,
          districtCode: itineraryNodes.districtCode,
        })
        .from(itineraryNodes)
        .where(eq(itineraryNodes.itineraryId, row.itineraryId))
        .orderBy(itineraryNodes.sequence);
      const currentImpact = await createItineraryImpactSnapshot({
        itineraryId: row.itineraryId,
        disruptedNodeId: row.disruptedNodeId,
        nextFixedNodeId: row.nextFixedNodeId,
        nodes: nodeRows.map((node) => ({
          id: node.id,
          sequence: node.sequence,
          type: node.type as ItineraryRegistration["nodes"][number]["type"],
          title: node.title,
          startAt: node.startAt ?? undefined,
          endAt: node.endAt ?? undefined,
          durationMinutes: node.durationMinutes ?? undefined,
          locked: node.locked,
          reservation: node.reservation,
          location:
            node.locationLabel &&
            node.latitude !== null &&
            node.longitude !== null
              ? {
                  label: node.locationLabel,
                  latitude: node.latitude,
                  longitude: node.longitude,
                  areaCode: node.regionCode ?? undefined,
                  sigunguCode: node.districtCode ?? undefined,
                }
              : undefined,
        })),
      });
      const nextFixed = applicationSnapshot.nextFixed;
      const nextFixedProof =
        scheduleDiff.nextFixedAppointment &&
        typeof scheduleDiff.nextFixedAppointment === "object" &&
        !Array.isArray(scheduleDiff.nextFixedAppointment)
          ? (scheduleDiff.nextFixedAppointment as Record<string, unknown>)
          : undefined;
      if (
        !currentImpact ||
        currentImpact.hash !== applicationSnapshot.itineraryImpact.hash ||
        JSON.stringify(currentImpact.nodes) !==
          JSON.stringify(applicationSnapshot.itineraryImpact.nodes) ||
        !nextFixed ||
        !nextFixedProof ||
        nextFixedProof.nodeId !== nextFixed.nodeId ||
        nextFixedProof.scheduledAt !== nextFixed.scheduledAt ||
        nextFixedProof.estimatedArrivalAt !==
          nextFixed.estimatedArrivalAt ||
        nextFixedProof.status !== "preserved" ||
        Date.parse(nextFixed.scheduledAt) <= nowMs ||
        Date.parse(nextFixed.estimatedArrivalAt) >
          Date.parse(nextFixed.scheduledAt)
      ) {
        return { created: false, reason: "INVALID_STATE" };
      }
    } else if (row.recoveryMode === "open_window") {
      const protectedWindow = applicationSnapshot.openWindow;
      const openWindowProof =
        scheduleDiff.openWindow &&
        typeof scheduleDiff.openWindow === "object" &&
        !Array.isArray(scheduleDiff.openWindow)
          ? (scheduleDiff.openWindow as Record<string, unknown>)
          : undefined;
      if (
        !protectedWindow ||
        !openWindowProof ||
        openWindowProof.status !== "fits" ||
        openWindowProof.windowStartAt !== protectedWindow.windowStartAt ||
        openWindowProof.windowEndAt !== protectedWindow.windowEndAt ||
        openWindowProof.returnMinutes !== protectedWindow.returnMinutes ||
        openWindowProof.returnBasis !== protectedWindow.returnBasis ||
        openWindowProof.returnProvider !== protectedWindow.returnProvider ||
        openWindowProof.returnDistanceMeters !==
          protectedWindow.returnDistanceMeters ||
        openWindowProof.returnCalculatedAt !==
          protectedWindow.returnCalculatedAt ||
        openWindowProof.requiredBufferMinutes !==
          protectedWindow.requiredBufferMinutes ||
        openWindowProof.leftoverMinutes !==
          protectedWindow.leftoverMinutes ||
        nowMs < Date.parse(protectedWindow.windowStartAt) - 60_000 ||
        nowMs >= Date.parse(protectedWindow.windowEndAt) ||
        protectedWindow.leftoverMinutes <
          protectedWindow.requiredBufferMinutes ||
        Math.floor(
          (Date.parse(protectedWindow.windowEndAt) -
            (visitEndMs + protectedWindow.returnMinutes * 60_000)) /
            60_000,
        ) !== protectedWindow.leftoverMinutes ||
        visitEndMs +
            (protectedWindow.returnMinutes +
              protectedWindow.requiredBufferMinutes) *
              60_000 >
          Date.parse(protectedWindow.windowEndAt) ||
        nowMs - Date.parse(protectedWindow.returnCalculatedAt) >
          SAFETY_EVIDENCE_MAX_AGE_MS ||
        Date.parse(protectedWindow.returnCalculatedAt) > nowMs + 60_000
      ) {
        return { created: false, reason: "INVALID_STATE" };
      }
    } else {
      return { created: false, reason: "INVALID_STATE" };
    }

    const latestOutcomes = await db
      .select({
        event: recoveryOutcomes.event,
        occurredAt: recoveryOutcomes.occurredAt,
        actualArrivalAt: recoveryOutcomes.actualArrivalAt,
        arrivedOnTime: recoveryOutcomes.arrivedOnTime,
        metadataJson: recoveryOutcomes.metadataJson,
      })
      .from(recoveryOutcomes)
      .where(
        and(
          eq(recoveryOutcomes.runId, row.runId),
          eq(recoveryOutcomes.optionId, row.optionId),
        ),
      )
      .orderBy(desc(recoveryOutcomes.occurredAt))
      .limit(10);
    const expiresAt = expiresInDays(7);
    const proof = {
      schema: "urn:ieoga:recovery-proof:v2",
      proofKind: historicalProof
        ? "historical_execution"
        : "actionable_recovery",
      actionability: historicalProof
        ? "historical_not_actionable"
        : "current_at_share",
      runId: row.runId,
      optionId: row.optionId,
      incident: row.incident,
      audience: row.audience,
      regionCode: row.regionCode,
      districtCode: row.districtCode,
      decisionStatus: row.status,
      recoveryMode: row.recoveryMode,
      disruptedNodeId: row.disruptedNodeId,
      nextFixedNodeId: row.nextFixedNodeId,
      ruleVersion: row.ruleVersion,
      generatedAt: row.completedAt,
      shareExpiresAt: expiresAt,
      execution: historicalProof && sealedExecution
        ? {
            id: sealedExecution.id,
            status: sealedExecution.status,
            activatedAt: sealedExecution.activatedAt,
            contractMetAt: sealedExecution.contractMetAt,
            contractMissedAt: sealedExecution.contractMissedAt,
            completedAt: sealedExecution.completedAt,
            lastUpdatedAt: sealedExecution.updatedAt,
          }
        : null,
      scheduleDiff: parsePrivacySafeJson(row.scheduleDiffJson),
      continuityProof: parsePrivacySafeJson(
        row.continuityProofJson,
        "continuity",
      ),
      counterfactual: parsePrivacySafeJson(row.counterfactualJson),
      outcomes: latestOutcomes.map((outcome) => {
        const metadata = parseJsonRecord(outcome.metadataJson);
        const selfReported =
          metadata.arrivalEvidence === "self_reported";
        return {
          event: outcome.event,
          occurredAt: outcome.occurredAt,
          actualArrivalAt: outcome.actualArrivalAt,
          arrivedOnTime: outcome.arrivedOnTime,
          evidenceKind: selfReported
            ? "traveler_self_report"
            : "system_event",
          verificationLevel: selfReported
            ? "self_reported_unverified"
            : "system_recorded",
        };
      }),
      option: {
        rank: row.rank,
        contentId: row.contentId,
        title: row.title,
        contentTypeId: row.contentTypeId,
        score: row.score,
        distanceBucket: row.distanceBucket,
        travelMinutesBucket: row.travelMinutesBucket,
        accessibilityStatus: row.accessibilityStatus,
        crowdStatus: row.crowdStatus,
        sources: JSON.parse(row.sourceNamesJson) as unknown,
      },
      notice:
        historicalProof
          ? "이 증명서는 실행 당시 보호된 판정과 이후 여정 기록을 보여 주는 역사적 증명입니다. 현재 영업·경로·예약 가능 여부를 뜻하지 않으며 현재 이동 결정에 사용하면 안 됩니다."
          : "이 증명서는 공유 시점에 서버가 다시 확인한 안전 계약입니다. 예약·운영·물리적 안전을 보증하지 않으며 표시된 만료 시간 이후에는 다시 확인해야 합니다.",
    };
    const privacySafeProof = toPrivacySafeRecoveryEvidence(proof) as Record<
      string,
      unknown
    >;
    const token = randomToken();
    const tokenHash = await sha256(token);
    await db.insert(proofShares).values({
      id: crypto.randomUUID(),
      runId: params.runId,
      optionId: params.optionId,
      tokenHash,
      proofJson: JSON.stringify(privacySafeProof),
      expiresAt,
    });
    return {
      created: true,
      token,
      expiresAt,
      proof: privacySafeProof,
    };
  } catch {
    return { created: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function getProofShare(
  token: string,
): Promise<
  | { found: true; proof: Record<string, unknown> }
  | { found: false; reason: "NOT_FOUND" | "DB_UNAVAILABLE" }
> {
  try {
    const db = getDb();
    const tokenHash = await sha256(token);
    const rows = await db
      .select({ proofJson: proofShares.proofJson })
      .from(proofShares)
      .where(
        and(
          eq(proofShares.tokenHash, tokenHash),
          isNull(proofShares.revokedAt),
          gt(proofShares.expiresAt, new Date().toISOString()),
        ),
      )
      .limit(1);
    return rows[0]
      ? {
          found: true,
          proof: JSON.parse(rows[0].proofJson) as Record<string, unknown>,
        }
      : { found: false, reason: "NOT_FOUND" };
  } catch (error) {
    logRepositoryFailure("get_proof_share", undefined, error);
    return { found: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function revokeProofShare(params: {
  token: string;
  sessionId: string;
}): Promise<
  | { revoked: true }
  | { revoked: false; reason: "NOT_FOUND" | "DB_UNAVAILABLE" }
> {
  try {
    const db = getDb();
    const tokenHash = await sha256(params.token);
    const ownedRuns = await db
      .select({ id: recoveryRuns.id })
      .from(recoveryRuns)
      .where(eq(recoveryRuns.sessionId, params.sessionId));
    if (!ownedRuns.length) return { revoked: false, reason: "NOT_FOUND" };
    const ownedRunIds = new Set(ownedRuns.map((row) => row.id));
    const matches = await db
      .select({ id: proofShares.id, runId: proofShares.runId })
      .from(proofShares)
      .where(
        and(
          eq(proofShares.tokenHash, tokenHash),
          isNull(proofShares.revokedAt),
          gt(proofShares.expiresAt, new Date().toISOString()),
        ),
      )
      .limit(1);
    const match = matches[0];
    if (!match || !ownedRunIds.has(match.runId)) {
      return { revoked: false, reason: "NOT_FOUND" };
    }
    await db
      .update(proofShares)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(proofShares.id, match.id));
    return { revoked: true };
  } catch (error) {
    logRepositoryFailure("revoke_proof_share", undefined, error);
    return { revoked: false, reason: "DB_UNAVAILABLE" };
  }
}
