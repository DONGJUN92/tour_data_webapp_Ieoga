import { getDb } from "@/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  apiAuditLogs,
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
import {
  distanceLimitBucket,
  expiresInDays,
  timeBudgetBucket,
} from "@/lib/privacy";
import type { KtoAudit } from "@/lib/kto/types";
import { getTourismCommonDetail } from "@/lib/kto/adapters";
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
  toPrivacySafeContinuityProof,
  toPrivacySafeRecoveryEvidence,
  toPrivacySafeRouteEvidence,
} from "@/lib/recovery/privacy-evidence";
import type { RecoveryResult } from "@/lib/recovery/types";

export type PersistenceResult =
  | { persisted: true }
  | { persisted: false; reason: "DB_UNAVAILABLE" };

type D1WriteBatch = [
  BatchItem<"sqlite">,
  ...BatchItem<"sqlite">[],
];

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
}): Promise<PersistenceResult> {
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
        distanceBucket: distanceLimitBucket(params.input.maxDistanceMeters),
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

    // Cloudflare D1 executes batch statements sequentially and rolls the
    // complete batch back when any statement fails.
    await db.batch(writes);
    return { persisted: true };
  } catch {
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

export async function saveItinerary(params: {
  sessionId: string;
  itinerary: ItineraryRegistration;
  analyticsConsent?: boolean;
}): Promise<
  | { saved: true; itinerary: StoredItinerary }
  | { saved: false; reason: "NOT_FOUND" | "DB_UNAVAILABLE" }
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
    const lockedNodeCount = normalizedNodes.filter(
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
      writes.push(
        db.insert(itineraries).values(itineraryValues),
      );
    }
    writes.push(
      db
        .delete(itineraryNodes)
        .where(eq(itineraryNodes.itineraryId, itineraryId)),
    );
    for (const node of normalizedNodes) {
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
        nodes: normalizedNodes,
        status: "active",
        createdAt: existing[0]?.createdAt ?? now,
        updatedAt: now,
        expiresAt,
      },
    };
  } catch {
    return { saved: false, reason: "DB_UNAVAILABLE" };
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
  } catch {
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

  return {
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
}): Promise<
  | { activated: true; execution: JourneyExecution }
  | {
      activated: false;
      reason: "NOT_FOUND" | "INVALID_STATE" | "DB_UNAVAILABLE";
    }
> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const versionKey = `${params.runId}:${params.optionId}`;
    const existing = await db
      .select({ id: journeyExecutions.id })
      .from(journeyExecutions)
      .where(
        and(
          eq(journeyExecutions.sessionId, params.sessionId),
          eq(journeyExecutions.versionKey, versionKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      const execution = await loadJourneyExecution({
        db,
        sessionId: params.sessionId,
        executionId: existing[0].id,
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
      !run.itineraryId ||
      !run.disruptedNodeId ||
      !run.nextFixedNodeId
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }

    const optionRows = await db
      .select({
        id: recoveryOptions.id,
        contentId: recoveryOptions.contentId,
        title: recoveryOptions.title,
        scheduleDiffJson: recoveryOptions.scheduleDiffJson,
        changedNodeCount: recoveryOptions.changedNodeCount,
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
    if (!option.contentId) {
      return { activated: false, reason: "INVALID_STATE" };
    }
    let officialPlace: Record<string, unknown> | undefined;
    try {
      officialPlace = (
        await getTourismCommonDetail(option.contentId, {
          timeoutMs: 4_000,
          retry: false,
        })
      ).items[0];
    } catch {
      return { activated: false, reason: "INVALID_STATE" };
    }
    const optionLatitude = Number(officialPlace?.mapy);
    const optionLongitude = Number(officialPlace?.mapx);
    if (
      !officialPlace ||
      !Number.isFinite(optionLatitude) ||
      !Number.isFinite(optionLongitude)
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }
    const optionAddress =
      String(officialPlace.addr1 ?? "").trim() || option.title;

    const itineraryRows = await db
      .select({ id: itineraries.id })
      .from(itineraries)
      .where(
        and(
          eq(itineraries.id, run.itineraryId),
          eq(itineraries.sessionId, params.sessionId),
          isNull(itineraries.deletedAt),
          gt(itineraries.expiresAt, now),
        ),
      )
      .limit(1);
    if (!itineraryRows[0]) {
      return { activated: false, reason: "NOT_FOUND" };
    }

    const nodeRows = await db
      .select({
        id: itineraryNodes.clientNodeId,
        sequence: itineraryNodes.sequence,
        type: itineraryNodes.type,
        title: itineraryNodes.title,
        startAt: itineraryNodes.startAt,
        durationMinutes: itineraryNodes.durationMinutes,
        locked: itineraryNodes.locked,
        reservation: itineraryNodes.reservation,
        locationLabel: itineraryNodes.locationLabel,
        latitude: itineraryNodes.latitude,
        longitude: itineraryNodes.longitude,
      })
      .from(itineraryNodes)
      .where(eq(itineraryNodes.itineraryId, run.itineraryId))
      .orderBy(itineraryNodes.sequence);
    const disruptedIndex = nodeRows.findIndex(
      (node) => node.id === run.disruptedNodeId,
    );
    const nextFixedIndex = nodeRows.findIndex(
      (node) => node.id === run.nextFixedNodeId,
    );
    if (
      disruptedIndex < 0 ||
      nextFixedIndex <= disruptedIndex ||
      nodeRows
        .slice(disruptedIndex + 1)
        .some(
          (node) =>
            typeof node.latitude !== "number" ||
            typeof node.longitude !== "number",
        )
    ) {
      return { activated: false, reason: "INVALID_STATE" };
    }

    const scheduleDiff = parseJsonRecord(option.scheduleDiffJson);
    const replacement =
      scheduleDiff.replacementNode &&
      typeof scheduleDiff.replacementNode === "object" &&
      !Array.isArray(scheduleDiff.replacementNode)
        ? (scheduleDiff.replacementNode as Record<string, unknown>)
        : {};
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
      ...nodeRows
        .slice(disruptedIndex + 1)
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
          latitude: node.latitude as number,
          longitude: node.longitude as number,
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
    const nextFixedStepSequence = nextFixedIndex - disruptedIndex;
    const nextFixedStep = steps[nextFixedStepSequence];
    if (!nextFixedStep) {
      return { activated: false, reason: "INVALID_STATE" };
    }
    const promptBasis =
      nextFixedStep.estimatedArrivalAt ??
      nextFixedStep.scheduledAt ??
      now;
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
    writes.push(
      db.insert(journeyExecutions).values({
        id: executionId,
        sessionId: params.sessionId,
        baseItineraryId: run.itineraryId,
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
  } catch {
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
    if (params.action.action === "abandon") {
      const current = execution.steps.find(
        (step) => step.sequence === execution.currentStepSequence,
      );
      const writes: D1WriteBatch = [
        db
          .update(journeyExecutions)
          .set({
            status: "abandoned",
            activeSessionKey: null,
            completedAt: now,
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
      if (execution.status !== "contract_met") {
        writes.push(
          db
            .insert(recoveryOutcomes)
            .values({
              id: `${execution.sourceRunId}:final`,
              runId: execution.sourceRunId,
              optionId: execution.sourceOptionId,
              sessionId: params.sessionId,
              event: "abandoned",
              occurredAt: now,
              reasonCode: params.action.reasonCode,
              changedNodeCount: 1,
              metadataJson: JSON.stringify({
                executionId: execution.id,
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
    }

    const current = execution.steps.find(
      (step) => step.sequence === execution.currentStepSequence,
    );
    if (!current || current.id !== params.action.stepId) {
      return { updated: false, reason: "INVALID_STATE" };
    }
    const isLast =
      current.sequence === execution.steps.length - 1;
    const isNextFixed =
      current.sequence === execution.nextFixedStepSequence;
    const next = isLast
      ? undefined
      : execution.steps.find(
          (step) => step.sequence === current.sequence + 1,
        );
    if (!isLast && !next) {
      return { updated: false, reason: "INVALID_STATE" };
    }
    const nextStatus = isLast
      ? "completed"
      : isNextFixed
        ? "contract_met"
        : execution.status;
    const writes: D1WriteBatch = [
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
          contractMetAt: isNextFixed ? now : execution.contractMetAt ?? null,
          completedAt: isLast ? now : null,
          updatedAt: now,
        })
        .where(eq(journeyExecutions.id, execution.id)),
    );
    if (isNextFixed) {
      const scheduledAt = current.scheduledAt
        ? Date.parse(current.scheduledAt)
        : Number.NaN;
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
            arrivedOnTime: Number.isFinite(scheduledAt)
              ? Date.parse(now) <= scheduledAt
              : null,
            changedNodeCount: 1,
            metadataJson: JSON.stringify({
              executionId: execution.id,
              stepId: current.id,
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
  } catch {
    return { updated: false, reason: "DB_UNAVAILABLE" };
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
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const ownedRun = await db
      .select({
        id: recoveryRuns.id,
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

    const options = await db
      .select({
        id: recoveryOptions.id,
        scheduleDiffJson: recoveryOptions.scheduleDiffJson,
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

    const priorOutcomes = await db
      .select({
        event: recoveryOutcomes.event,
        optionId: recoveryOutcomes.optionId,
      })
      .from(recoveryOutcomes)
      .where(eq(recoveryOutcomes.runId, params.runId))
      .orderBy(desc(recoveryOutcomes.occurredAt))
      .limit(30);
    const finalEvents = new Set([
      "arrived",
      "continued",
      "abandoned",
    ]);
    const isFinal = finalEvents.has(params.outcome.event);
    if (priorOutcomes.some((outcome) => finalEvents.has(outcome.event))) {
      return { recorded: false, reason: "ALREADY_FINALIZED" };
    }
    if (
      isFinal &&
      !priorOutcomes.some(
        (outcome) =>
          outcome.event === "applied" &&
          outcome.optionId === params.outcome.optionId,
      )
    ) {
      return { recorded: false, reason: "INVALID_STATE" };
    }

    let arrivedOnTime: boolean | undefined;
    if (
      params.outcome.event === "arrived" &&
      option?.scheduleDiffJson
    ) {
      const scheduleDiff = JSON.parse(option.scheduleDiffJson) as {
        nextFixedAppointment?: { scheduledAt?: string };
      };
      const scheduledAt =
        scheduleDiff.nextFixedAppointment?.scheduledAt;
      if (scheduledAt) {
        arrivedOnTime =
          Date.parse(now) <= Date.parse(scheduledAt);
      }
    }

    const id = isFinal
      ? `${params.runId}:final`
      : crypto.randomUUID();
    const values = {
      id,
      runId: params.runId,
      optionId: params.outcome.optionId,
      sessionId: params.sessionId,
      event: params.outcome.event,
      occurredAt: now,
      actualArrivalAt:
        params.outcome.event === "arrived" ? now : null,
      arrivedOnTime: arrivedOnTime ?? null,
      reasonCode: params.outcome.reasonCode ?? null,
      changedNodeCount: option?.changedNodeCount ?? null,
      metadataJson: "{}",
    };
    if (isFinal) {
      const inserted = await db
        .insert(recoveryOutcomes)
        .values(values)
        .onConflictDoNothing({ target: recoveryOutcomes.id })
        .returning({ id: recoveryOutcomes.id });
      if (!inserted[0]) {
        return { recorded: false, reason: "ALREADY_FINALIZED" };
      }
    } else {
      await db.insert(recoveryOutcomes).values(values);
    }

    return {
      recorded: true,
      outcome: {
        id,
        runId: params.runId,
        optionId: params.outcome.optionId,
        event: params.outcome.event,
        occurredAt: now,
        actualArrivalAt:
          params.outcome.event === "arrived" ? now : undefined,
        arrivedOnTime,
      },
    };
  } catch {
    return { recorded: false, reason: "DB_UNAVAILABLE" };
  }
}

export async function persistHealth(
  audits: KtoAudit[],
): Promise<PersistenceResult> {
  try {
    const db = getDb();
    const checkedAt = new Date().toISOString();
    for (const audit of audits) {
      await db
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
        });
    }
    return { persisted: true };
  } catch {
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
  } catch {
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
  } catch {
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
  } catch {
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
  | { created: false; reason: "NOT_FOUND" | "DB_UNAVAILABLE" }
> {
  try {
    const db = getDb();
    const rows = await db
      .select({
        runId: recoveryRuns.id,
        incident: recoveryRuns.incident,
        audience: recoveryRuns.audience,
        regionCode: recoveryRuns.regionCode,
        districtCode: recoveryRuns.districtCode,
        status: recoveryRuns.status,
        recoveryMode: recoveryRuns.recoveryMode,
        disruptedNodeId: recoveryRuns.disruptedNodeId,
        nextFixedNodeId: recoveryRuns.nextFixedNodeId,
        ruleVersion: recoveryRuns.ruleVersion,
        completedAt: recoveryRuns.completedAt,
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

    const latestOutcomes = await db
      .select({
        event: recoveryOutcomes.event,
        occurredAt: recoveryOutcomes.occurredAt,
        actualArrivalAt: recoveryOutcomes.actualArrivalAt,
        arrivedOnTime: recoveryOutcomes.arrivedOnTime,
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
    const proof = {
      schema: "https://ieoga.kr/schemas/recovery-proof/v2",
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
      scheduleDiff: parsePrivacySafeJson(row.scheduleDiffJson),
      continuityProof: parsePrivacySafeJson(
        row.continuityProofJson,
        "continuity",
      ),
      counterfactual: parsePrivacySafeJson(row.counterfactualJson),
      outcomes: latestOutcomes,
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
        "이 증명서는 사용 당시 공식 관광데이터와 이어가 규칙에 따른 판정 기록이며 예약·운영·물리적 안전을 보증하지 않습니다.",
    };
    const privacySafeProof = toPrivacySafeRecoveryEvidence(proof) as Record<
      string,
      unknown
    >;
    const token = randomToken();
    const tokenHash = await sha256(token);
    const expiresAt = expiresInDays(7);
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
): Promise<Record<string, unknown> | null> {
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
      ? (JSON.parse(rows[0].proofJson) as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function revokeProofShare(params: {
  token: string;
  sessionId: string;
}): Promise<boolean> {
  try {
    const db = getDb();
    const tokenHash = await sha256(params.token);
    const ownedRuns = await db
      .select({ id: recoveryRuns.id })
      .from(recoveryRuns)
      .where(eq(recoveryRuns.sessionId, params.sessionId));
    if (!ownedRuns.length) return false;
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
    if (!match || !ownedRunIds.has(match.runId)) return false;
    await db
      .update(proofShares)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(proofShares.id, match.id));
    return true;
  } catch {
    return false;
  }
}
