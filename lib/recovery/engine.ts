import {
  getAccessibilityDetail,
  getConcentrationForecast,
  getNearbyAccessibleTourism,
  getNearbyTourism,
  getRelatedTourism,
  normalizeAnalysisCodes,
} from "@/lib/kto/adapters";
import {
  getAvailabilityEvidence,
  type AvailabilityEvidence,
} from "@/lib/kto/availability";
import { previousCompleteMonth } from "@/lib/kto/registry";
import {
  KtoError,
  type KtoAudit,
  type KtoCallResult,
  type KtoItem,
  type KtoServiceName,
} from "@/lib/kto/types";
import {
  conservativeWalkingMinutes,
  haversineMeters,
} from "@/lib/geo";
import {
  getWalkingRoute,
  type WalkingRouteEvidence,
} from "@/lib/mobility/routing";
import { getWeatherEvidence } from "@/lib/weather/service";
import type { RecoveryRequest } from "./schema";
import type {
  EvidenceGap,
  AccessibilityEvidence,
  ContinuityProof,
  DataContribution,
  PublicAvailabilityEvidence,
  RecoveryMode,
  RecoveryOption,
  RecoveryResult,
  RejectedCandidate,
  ScheduleDiff,
  ScheduleNodeSummary,
  TravelPurposeProof,
} from "./types";

export const RECOVERY_RULE_VERSION = "2026.07-continuity-v2";

type ItineraryNode = NonNullable<
  RecoveryRequest["itinerary"]
>["nodes"][number];

type ItineraryContext = {
  mode: Exclude<RecoveryMode, "proximity_fallback">;
  id?: string;
  title: string;
  occurredAt: Date;
  disrupted: ItineraryNode;
  nextFixed?: ItineraryNode;
  continuityNodes: ItineraryNode[];
  sortedNodes: ItineraryNode[];
  lockedNodeIds: string[];
  originalDurationMinutes: number;
};

type WorkingCandidate = {
  /* Conditions that could not be confirmed from official data. The candidate
     is still offered, but never as if it had been verified. */
  evidenceGaps: EvidenceGap[];
  item: KtoItem;
  contentId: string;
  contentTypeId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  estimatedTravelMinutes: number;
  imageUrl?: string;
  modifiedAt?: string;
  indoor: boolean;
  relatedRank?: number;
  purposePreservation: TravelPurposeProof;
  crowdRate?: number;
  crowdBaseDate?: string;
  accessibility: AccessibilityEvidence;
  availability: PublicAvailabilityEvidence;
  routeEvidence:
    | WalkingRouteEvidence
    | {
        status: "geodesic_estimate";
        provider: "ieoga_conservative_estimate";
        distanceMeters: number;
        durationMinutes: number;
        calculatedAt: string;
      };
  scheduleDiff: ScheduleDiff;
  continuityProof: ContinuityProof;
  baseScore: number;
  comfortScore: number;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizedImage(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  return raw.startsWith("http://") ? `https://${raw.slice(7)}` : raw;
}

function isIndoorType(item: KtoItem): boolean {
  const contentTypeId = stringValue(item.contenttypeid);
  const mediumClass = stringValue(item.lclsSystm2);
  return (
    ["14", "38", "39"].includes(contentTypeId) ||
    ["VE03", "VE04", "VE06"].includes(mediumClass)
  );
}

function positiveAccessibility(value: string): boolean {
  if (!value) return false;
  return !/(없음|불가|미제공|해당\s*없음|미확인|확인\s*불가|not available|none)/i.test(
    value,
  );
}

function accessibilityFields(
  audience: RecoveryRequest["audience"],
): string[] {
  if (audience === "stroller") {
    return [
      "stroller",
      "exit",
      "lactationroom",
      "babysparechair",
      "restroom",
      "parking",
    ];
  }
  if (audience === "wheelchair") {
    return ["wheelchair", "elevator", "restroom", "parking", "exit"];
  }
  if (audience === "senior") {
    return ["elevator", "restroom", "parking", "exit", "wheelchair"];
  }
  return [];
}

function evaluateAccessibility(
  audience: RecoveryRequest["audience"],
  item?: KtoItem,
): AccessibilityEvidence {
  if (audience === "general") {
    return {
      status: "not_required",
      grade: "A",
      audience,
      confirmedFields: [],
      requiredChecks: [],
      supplementalFields: [],
      note: "별도의 이동 편의 조건을 요청하지 않았습니다.",
    };
  }

  if (!item) {
    return {
      status: "unverified",
      grade: "X",
      audience,
      confirmedFields: [],
      requiredChecks: [],
      supplementalFields: [],
      note: "한국관광공사 무장애여행정보에서 관련 편의정보를 확인하지 못했습니다.",
    };
  }

  const allFields = accessibilityFields(audience)
    .map((field) => ({ field, value: stringValue(item[field]) }))
    .filter((entry) => positiveAccessibility(entry.value));
  const confirmed = new Set(allFields.map((entry) => entry.field));
  const requiredGroups =
    audience === "stroller"
      ? [
          { label: "유아차 이용 정보", fields: ["stroller"] },
          { label: "출입 동선", fields: ["exit"] },
        ]
      : [
          { label: "출입 동선", fields: ["exit"] },
          {
            label: "내부 이동",
            fields: ["elevator", "wheelchair"],
          },
        ];
  const requiredChecks = requiredGroups.map((group) => ({
    label: group.label,
    status: group.fields.some((field) => confirmed.has(field))
      ? ("confirmed" as const)
      : ("missing" as const),
    fields: group.fields,
  }));
  const confirmedRequiredCount = requiredChecks.filter(
    (check) => check.status === "confirmed",
  ).length;
  const supplementalFieldNames =
    audience === "stroller"
      ? ["lactationroom", "babysparechair", "restroom", "parking"]
      : ["restroom", "parking"];
  const supplementalFields = allFields.filter((entry) =>
    supplementalFieldNames.includes(entry.field),
  );
  const complete = confirmedRequiredCount === requiredChecks.length;
  const partial = confirmedRequiredCount > 0;
  const grade = complete
    ? supplementalFields.length
      ? "A"
      : "B"
    : partial
      ? "C"
      : "X";

  return {
    status: complete ? "verified" : partial ? "partial" : "unverified",
    grade,
    audience,
    confirmedFields: allFields,
    requiredChecks,
    supplementalFields,
    note: complete
      ? `접근성 필수 동선을 모두 확인했습니다(등급 ${grade}). 화장실·주차 등 보조정보는 별도로 표시합니다.`
      : partial
        ? "접근성 필수 동선 중 일부만 확인되어 자동 적용 가능한 복구안에서는 제외합니다."
        : "접근성 필수 동선을 확인하지 못해 자동 복구안에서 제외합니다.",
  };
}

function auditFromFailure(
  service: KtoServiceName,
  operation: string,
  error: unknown,
): KtoAudit {
  if (error instanceof KtoError) return error.audit;
  return {
    apiName: service,
    operation,
    status: "error",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: [],
    errorCode: "UNKNOWN",
  };
}

function notRequiredAudit(
  service: KtoServiceName,
  operation: string,
): KtoAudit {
  return {
    apiName: service,
    operation,
    status: "not_required",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: [],
  };
}

function publicAvailability(
  evidence: AvailabilityEvidence,
): PublicAvailabilityEvidence {
  const { audit: _audit, ...publicEvidence } = evidence;
  void _audit;
  return publicEvidence;
}

function unknownAvailability(
  note = "공식 운영정보를 확인하지 못했습니다.",
): PublicAvailabilityEvidence {
  return {
    status: "unknown",
    checkedAt: new Date().toISOString(),
    note,
  };
}

function currentForecastByTitle(items: KtoItem[]): Map<
  string,
  { rate: number; baseDate: string }
> {
  const koreaDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const koreaDate = Object.fromEntries(
    koreaDateParts.map((part) => [part.type, part.value]),
  );
  const today = `${koreaDate.year}${koreaDate.month}${koreaDate.day}`;
  const grouped = new Map<
    string,
    Array<{ rate: number; baseDate: string }>
  >();

  for (const item of items) {
    const name = normalizeName(stringValue(item.tAtsNm));
    const rate = numberValue(item.cnctrRate);
    const baseDate = stringValue(item.baseYmd);
    if (!name || rate === undefined || !baseDate) continue;
    const values = grouped.get(name) ?? [];
    values.push({ rate, baseDate });
    grouped.set(name, values);
  }

  const selected = new Map<string, { rate: number; baseDate: string }>();
  for (const [name, values] of grouped) {
    values.sort((a, b) => a.baseDate.localeCompare(b.baseDate));
    selected.set(
      name,
      values.find((value) => value.baseDate >= today) ??
        values[values.length - 1],
    );
  }
  return selected;
}

function relatedRankByTitle(
  items: KtoItem[],
  originLabel: string,
): Map<string, number> {
  const ranks = new Map<string, number>();
  const normalizedOrigin = normalizeName(originLabel);
  if (!normalizedOrigin || normalizedOrigin === normalizeName("현재 위치")) {
    return ranks;
  }
  for (const item of items) {
    if (normalizeName(stringValue(item.tAtsNm)) !== normalizedOrigin) continue;
    const name = normalizeName(stringValue(item.rlteTatsNm));
    const rank = numberValue(item.rlteRank);
    if (!name || rank === undefined) continue;
    const current = ranks.get(name);
    if (current === undefined || rank < current) ranks.set(name, rank);
  }
  return ranks;
}

function disruptedNode(input: RecoveryRequest): ItineraryNode | undefined {
  return input.itinerary?.nodes.find(
    (node) => node.id === input.itinerary?.disruptedNodeId,
  );
}

function candidatePurpose(contentTypeId: string): {
  key: string;
  label: string;
} {
  const purposes: Record<string, { key: string; label: string }> = {
    "12": { key: "nature", label: "자연 관광" },
    "14": { key: "culture", label: "문화·전시 관람" },
    "15": { key: "festival", label: "축제·공연 관람" },
    "25": { key: "course", label: "여행 코스 체험" },
    "28": { key: "activity", label: "레포츠·체험" },
    "32": { key: "stay", label: "숙박" },
    "38": { key: "shopping", label: "쇼핑·시장 방문" },
    "39": { key: "meal", label: "식사" },
  };
  return purposes[contentTypeId] ?? {
    key: "visit",
    label: "관광 방문",
  };
}

function originalPurpose(node?: ItineraryNode): {
  key: string;
  label: string;
} {
  if (node?.type === "meal") return { key: "meal", label: "식사" };
  if (node?.type === "stay") return { key: "stay", label: "숙박" };
  if (node?.type === "transit") return { key: "transit", label: "이동" };
  return { key: "visit", label: "관광·체험" };
}

function preservesTravelPurpose(params: {
  input: RecoveryRequest;
  contentTypeId: string;
  relatedRank?: number;
}): boolean {
  const original = originalPurpose(disruptedNode(params.input));
  const replacement = candidatePurpose(params.contentTypeId);
  if (!params.input.itinerary) return true;
  if (params.relatedRank !== undefined) return true;

  /* A declared purpose is preserved strictly: a meal is replaced by a meal, a
     night's stay by a night's stay, and a booked transfer is not replaced by
     sightseeing at all. */
  if (original.key === "meal") return replacement.key === "meal";
  if (original.key === "stay") return replacement.key === "stay";
  if (original.key === "transit") return false;

  /* "visit" is both the generic case and the schema default, so it does not
     evidence what the traveller was actually doing — in bridge recovery the
     disrupted stop is synthesised from "I am here now" and is always this
     type. Treating it as a hard constraint filtered out every restaurant and
     shop, which is most of the official content in a dense area: measured
     across ten scenarios it rejected 226 of 336 candidates, more than every
     other constraint combined, and left the traveller with nothing.

     A meal or a shop is a legitimate way to spend a two-hour gap, especially
     the rain case where indoor is the point. Accommodation is not — nobody
     checks in to wait out a shower — so that stays excluded. Purpose still
     ranks candidates; it just no longer eliminates them on an assumption. */
  return replacement.key !== "stay";
}

function buildTravelPurposeProof(params: {
  input: RecoveryRequest;
  replacementTitle: string;
  contentTypeId: string;
  relatedRank?: number;
}): TravelPurposeProof {
  const node = disruptedNode(params.input);
  const original = originalPurpose(node);
  const replacement = candidatePurpose(params.contentTypeId);
  const originalStopTitle = node?.title ?? params.input.origin.label;

  if (params.relatedRank !== undefined) {
    return {
      status: "verified_related_place",
      originalPurpose: original.label,
      replacementPurpose: replacement.label,
      originalStopTitle,
      replacementTitle: params.replacementTitle,
      evidenceSource: "TarRlteTarService1",
      relatedRank: params.relatedRank,
      statement: `${originalStopTitle}에서 하려던 여행 경험과 실제 연계 방문 데이터가 있는 장소입니다.`,
    };
  }

  if (
    (original.key === "meal" && replacement.key === "meal") ||
    (original.key === "stay" && replacement.key === "stay")
  ) {
    return {
      status: "verified_activity_type",
      originalPurpose: original.label,
      replacementPurpose: replacement.label,
      originalStopTitle,
      replacementTitle: params.replacementTitle,
      evidenceSource: "KorService2",
      statement: `${original.label} 일정의 활동 유형을 바꾸지 않고 같은 목적의 장소로 복구합니다.`,
    };
  }

  return {
    status: "supported_visit_category",
    originalPurpose: original.label,
    replacementPurpose: replacement.label,
    originalStopTitle,
    replacementTitle: params.replacementTitle,
    evidenceSource: "KorService2",
    statement: `${originalStopTitle}의 관광·체험 목적을 유지하는 공식 관광 콘텐츠 유형입니다.`,
  };
}

function nodeSequence(node: ItineraryNode, index: number): number {
  return node.sequence ?? index;
}

function nodeSummary(
  node: ItineraryNode,
  index: number,
): ScheduleNodeSummary {
  return {
    id: node.id,
    sequence: nodeSequence(node, index),
    type: node.type,
    title: node.title,
    startAt: node.startAt,
    endAt: node.endAt,
    locked: node.locked,
    reservation: node.reservation,
  };
}

function plannedDurationMinutes(
  node: ItineraryNode,
  fallback: number,
): number {
  if (node.durationMinutes) return node.durationMinutes;
  if (node.startAt && node.endAt) {
    const minutes = Math.floor(
      (Date.parse(node.endAt) - Date.parse(node.startAt)) / 60_000,
    );
    if (minutes > 0) return minutes;
  }
  return fallback;
}

function itineraryContext(
  input: RecoveryRequest,
): ItineraryContext | undefined {
  const itinerary = input.itinerary;
  if (!itinerary) return undefined;
  const sortedNodes = [...itinerary.nodes].sort(
    (a, b) =>
      nodeSequence(a, itinerary.nodes.indexOf(a)) -
      nodeSequence(b, itinerary.nodes.indexOf(b)),
  );
  const disrupted = sortedNodes.find(
    (node) => node.id === itinerary.disruptedNodeId,
  );
  if (!disrupted) return undefined;
  const disruptedIndex = sortedNodes.indexOf(disrupted);
  const occurredAt = new Date(
    itinerary.occurredAt ?? disrupted.startAt ?? new Date().toISOString(),
  );
  const explicitNext = itinerary.nextFixedNodeId
    ? sortedNodes.find((node) => node.id === itinerary.nextFixedNodeId)
    : undefined;
  const nextFixed =
    explicitNext ??
    sortedNodes
      .slice(disruptedIndex + 1)
      .find(
        (node) =>
          (node.locked || node.reservation) &&
          Boolean(node.startAt) &&
          Boolean(node.location),
      );
  const nextFixedIndex = nextFixed
    ? sortedNodes.indexOf(nextFixed)
    : -1;
  return {
    mode: itinerary.id ? "registered_itinerary" : "inline_itinerary",
    id: itinerary.id,
    title: itinerary.title,
    occurredAt:
      Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    disrupted,
    nextFixed,
    continuityNodes:
      nextFixedIndex > disruptedIndex
        ? sortedNodes.slice(disruptedIndex + 1, nextFixedIndex + 1)
        : [],
    sortedNodes,
    lockedNodeIds: sortedNodes
      .filter((node) => node.locked || node.reservation)
      .map((node) => node.id),
    originalDurationMinutes: plannedDurationMinutes(
      disrupted,
      input.minimumStayMinutes ?? 30,
    ),
  };
}

function scoreCandidate(
  candidate: Omit<WorkingCandidate, "baseScore" | "comfortScore">,
  input: RecoveryRequest,
): { baseScore: number; comfortScore: number } {
  const distanceScore = Math.max(
    0,
    100 - (candidate.distanceMeters / input.radiusMeters) * 100,
  );
  const purposeScore =
    candidate.purposePreservation.status === "verified_related_place"
      ? Math.max(76, 102 - (candidate.relatedRank ?? 1) * 1.2)
      : candidate.purposePreservation.status === "verified_activity_type"
        ? 96
        : 84;
  const crowdScore =
    candidate.crowdRate === undefined
      ? 50
      : candidate.crowdRate >= 80
        ? 25
        : candidate.crowdRate >= 60
          ? 62
          : 86;
  const accessScore =
    input.audience === "general"
      ? 75
      : candidate.accessibility.status === "verified"
        ? 100
        : 0;
  const indoorScore = candidate.indoor ? 100 : 35;
  const continuityScore =
    candidate.scheduleDiff.nextFixedAppointment?.status === "preserved"
      ? Math.min(
          100,
          70 +
            Math.max(
              0,
              candidate.scheduleDiff.nextFixedAppointment
                .arrivalBufferMinutes ?? 0,
            ),
        )
      : candidate.scheduleDiff.mode === "proximity_fallback"
        ? 50
        : 0;

  let baseScore: number;
  if (input.incident === "rain") {
    baseScore =
      distanceScore * 0.15 +
      indoorScore * 0.25 +
      accessScore * 0.13 +
      purposeScore * 0.18 +
      crowdScore * 0.04 +
      continuityScore * 0.25;
  } else if (input.incident === "crowd") {
    baseScore =
      distanceScore * 0.14 +
      crowdScore * 0.24 +
      accessScore * 0.14 +
      purposeScore * 0.18 +
      continuityScore * 0.3;
  } else {
    baseScore =
      distanceScore * 0.23 +
      accessScore * 0.13 +
      purposeScore * 0.18 +
      crowdScore * 0.06 +
      continuityScore * 0.4;
  }

  const comfortScore =
    accessScore * 0.27 +
    indoorScore * 0.2 +
    crowdScore * 0.14 +
    distanceScore * 0.12 +
    purposeScore * 0.1 +
    continuityScore * 0.17;

  return {
    baseScore: Math.round(baseScore * 10) / 10,
    comfortScore: Math.round(comfortScore * 10) / 10,
  };
}

async function accessibilityDetails(
  candidates: WorkingCandidate[],
  audience: RecoveryRequest["audience"],
  signal?: AbortSignal,
): Promise<{ details: Map<string, KtoItem>; audits: KtoAudit[] }> {
  if (audience === "general") return { details: new Map(), audits: [] };

  const details = new Map<string, KtoItem>();
  const audits: KtoAudit[] = [];
  const targets = candidates.slice(0, 8);

  for (let offset = 0; offset < targets.length; offset += 4) {
    const group = targets.slice(offset, offset + 4);
    const settled = await Promise.allSettled(
      group.map((candidate) =>
        getAccessibilityDetail(candidate.contentId, { signal }),
      ),
    );
    settled.forEach((entry, index) => {
      const candidate = group[index];
      if (entry.status === "fulfilled") {
        audits.push(entry.value.audit);
        if (entry.value.items[0]) {
          details.set(candidate.contentId, entry.value.items[0]);
        }
      } else {
        audits.push(
          auditFromFailure(
            "KorWithService2",
            "detailWithTour2",
            entry.reason,
          ),
        );
      }
    });
  }

  return { details, audits };
}

function geodesicEvidence(
  distanceMeters: number,
  durationMinutes: number,
): WorkingCandidate["routeEvidence"] {
  return {
    status: "geodesic_estimate",
    provider: "ieoga_conservative_estimate",
    distanceMeters: Math.round(distanceMeters),
    durationMinutes,
    calculatedAt: new Date().toISOString(),
  };
}

function fallbackScheduleDiff(
  candidate: {
    contentId: string;
    title: string;
    estimatedTravelMinutes: number;
  },
): ScheduleDiff {
  const startAt = new Date(
    Date.now() + candidate.estimatedTravelMinutes * 60_000,
  );
  const durationMinutes = 30;
  return {
    mode: "proximity_fallback",
    replacementContentId: candidate.contentId,
    changedNodeIds: [],
    unchangedNodeIds: [],
    lockedNodeIds: [],
    preservedLockedNodeIds: [],
    changedNodeCount: 0,
    replacementNode: {
      id: `replacement-${candidate.contentId}`,
      title: candidate.title,
      startAt: startAt.toISOString(),
      endAt: new Date(
        startAt.getTime() + durationMinutes * 60_000,
      ).toISOString(),
      durationMinutes,
    },
  };
}

function fallbackContinuityProof(params: {
  candidate: {
    distanceMeters: number;
    estimatedTravelMinutes: number;
  };
  availability: PublicAvailabilityEvidence;
}): ContinuityProof {
  return {
    schemaVersion: "2026-07-v2",
    objective: "minimize_travel_minutes_without_registered_itinerary",
    recoveryMode: "proximity_fallback",
    changedNodeCount: 0,
    lockedNodesTotal: 0,
    lockedNodesPreserved: 0,
    routeEvidence: geodesicEvidence(
      params.candidate.distanceMeters,
      params.candidate.estimatedTravelMinutes,
    ),
    availabilityEvidence: params.availability,
    generatedAt: new Date().toISOString(),
  };
}

function itineraryScheduleDiff(params: {
  context: ItineraryContext;
  candidate: {
    contentId: string;
    title: string;
  };
  route: Extract<WalkingRouteEvidence, { status: "routed" }>;
  stayMinutes: number;
  safetyBufferMinutes: number;
}): ScheduleDiff {
  const { context, candidate, route, stayMinutes, safetyBufferMinutes } =
    params;
  const toCandidateMinutes =
    route.legs[0]?.durationMinutes ?? route.durationMinutes;
  const startAt = new Date(
    context.occurredAt.getTime() + toCandidateMinutes * 60_000,
  );
  const endAt = new Date(startAt.getTime() + stayMinutes * 60_000);
  let nextFixedAppointment: ScheduleDiff["nextFixedAppointment"];
  const preservedWaypoints: NonNullable<
    ScheduleDiff["preservedWaypoints"]
  > = [];
  let cursorMs = endAt.getTime();

  for (const [index, node] of context.continuityNodes.entries()) {
    if (!node.startAt) continue;
    const travelMinutes = route.legs[index + 1]?.durationMinutes ?? 0;
    const estimatedArrivalAt = new Date(
      cursorMs + travelMinutes * 60_000,
    );
    const scheduledAt = new Date(node.startAt);
    const requiredBufferMinutes =
      node.locked ||
      node.reservation ||
      node.id === context.nextFixed?.id
        ? safetyBufferMinutes
        : 0;
    const arrivalBufferMinutes = Math.floor(
      (scheduledAt.getTime() - estimatedArrivalAt.getTime()) / 60_000,
    );
    const status =
      arrivalBufferMinutes >= requiredBufferMinutes
        ? ("preserved" as const)
        : ("at_risk" as const);
    preservedWaypoints.push({
      nodeId: node.id,
      title: node.title,
      scheduledAt: node.startAt,
      estimatedArrivalAt: estimatedArrivalAt.toISOString(),
      arrivalBufferMinutes,
      requiredBufferMinutes,
      locked: node.locked,
      reservation: node.reservation,
      status,
    });

    if (node.id === context.nextFixed?.id) {
      nextFixedAppointment = {
        nodeId: node.id,
        title: node.title,
        scheduledAt: node.startAt,
        estimatedArrivalAt: estimatedArrivalAt.toISOString(),
        arrivalBufferMinutes,
        safetyBufferMinutes,
        status,
      };
      break;
    }

    const visitStartMs = Math.max(
      estimatedArrivalAt.getTime(),
      scheduledAt.getTime(),
    );
    cursorMs =
      visitStartMs +
      plannedDurationMinutes(node, 30) * 60_000;
  }

  const changedNodeIds = [context.disrupted.id];
  const unchangedNodeIds = context.sortedNodes
    .filter((node) => !changedNodeIds.includes(node.id))
    .map((node) => node.id);
  const preservedLockedNodeIds = context.lockedNodeIds.filter(
    (id) => !changedNodeIds.includes(id),
  );
  const disruptedIndex = context.sortedNodes.indexOf(context.disrupted);

  return {
    mode: context.mode,
    replacedNodeId: context.disrupted.id,
    replacementContentId: candidate.contentId,
    changedNodeIds,
    unchangedNodeIds,
    lockedNodeIds: context.lockedNodeIds,
    preservedLockedNodeIds,
    changedNodeCount: 1,
    nextFixedAppointmentPreserved:
      nextFixedAppointment?.status === "preserved"
        ? true
        : nextFixedAppointment
          ? false
          : undefined,
    arrivalTime: nextFixedAppointment?.estimatedArrivalAt,
    safetyBufferMinutes,
    note: nextFixedAppointment
      ? "중단 일정 한 곳만 교체하고, 그 사이 원래 일정과 다음 고정 일정까지 순서대로 이동·도착 가능성을 검증했습니다."
      : "중단 일정 한 곳만 교체하고 나머지 잠금 일정을 유지했습니다.",
    originalNode: nodeSummary(context.disrupted, disruptedIndex),
    replacementNode: {
      id: `replacement-${candidate.contentId}`,
      title: candidate.title,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      durationMinutes: stayMinutes,
    },
    preservedWaypoints,
    nextFixedAppointment,
  };
}

async function enrichForContinuity(params: {
  candidate: WorkingCandidate;
  input: RecoveryRequest;
  context?: ItineraryContext;
  sourceLedger: KtoAudit[];
  rejected: RejectedCandidate[];
  weatherEvidence?: Awaited<ReturnType<typeof getWeatherEvidence>>;
  signal?: AbortSignal;
}): Promise<WorkingCandidate | null> {
  const {
    candidate,
    input,
    context,
    sourceLedger,
    rejected,
    weatherEvidence,
    signal,
  } = params;
  const minimumStay = input.minimumStayMinutes ?? 30;
  const safetyBuffer = input.safetyBufferMinutes ?? 15;

  let routeEvidence = candidate.routeEvidence;
  let scheduleDiff = candidate.scheduleDiff;
  let availability = candidate.availability;

  if (context) {
    const routePoints = [
      input.origin,
      { latitude: candidate.latitude, longitude: candidate.longitude },
      ...context.continuityNodes.map((node) => ({
        latitude: node.location!.latitude,
        longitude: node.location!.longitude,
      })),
    ];
    const route = await getWalkingRoute(routePoints, { signal });
    if (
      route.status !== "routed" ||
      route.legs.length < routePoints.length - 1
    ) {
      rejected.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "ROUTE_UNAVAILABLE",
        reason:
          "대체 일정부터 원래 일정의 복귀 지점까지 이어지는 전체 보행 경로를 검증하지 못해 복구안에서 제외했습니다.",
        distanceMeters: candidate.distanceMeters,
        changedNodeCount: 1,
      });
      return null;
    }

    const firstLeg = route.legs[0];
    const routedDistance =
      firstLeg?.distanceMeters ?? route.distanceMeters;
    const routedMinutes =
      firstLeg?.durationMinutes ?? route.durationMinutes;
    let stayMinutes = Math.max(
      minimumStay,
      Math.min(context.originalDurationMinutes, input.availableMinutes),
    );
    scheduleDiff = itineraryScheduleDiff({
      context,
      candidate,
      route,
      stayMinutes,
      safetyBufferMinutes: safetyBuffer,
    });

    let atRisk = (scheduleDiff.preservedWaypoints ?? []).filter(
      (waypoint) => waypoint.status === "at_risk",
    );
    if (atRisk.length) {
      const shortfall = Math.max(
        ...atRisk.map(
          (waypoint) =>
            waypoint.requiredBufferMinutes -
            waypoint.arrivalBufferMinutes,
        ),
      );
      const automaticReduction = Math.min(
        Math.max(0, stayMinutes - minimumStay),
        shortfall,
      );
      if (automaticReduction > 0) {
        stayMinutes -= automaticReduction;
        scheduleDiff = itineraryScheduleDiff({
          context,
          candidate,
          route,
          stayMinutes,
          safetyBufferMinutes: safetyBuffer,
        });
        atRisk = (scheduleDiff.preservedWaypoints ?? []).filter(
          (waypoint) => waypoint.status === "at_risk",
        );
      }
    }

    routeEvidence = route;
    candidate.distanceMeters = routedDistance;
    candidate.estimatedTravelMinutes = routedMinutes;

    if (candidate.contentTypeId) {
      try {
        const arrivalAt = new Date(scheduleDiff.replacementNode.startAt);
        const departureAt = new Date(scheduleDiff.replacementNode.endAt);
        const evidence = await getAvailabilityEvidence({
          contentId: candidate.contentId,
          contentTypeId: candidate.contentTypeId,
          startAt: arrivalAt,
          endAt: departureAt,
        }, { signal });
        sourceLedger.push(evidence.audit);
        availability = publicAvailability(evidence);
      } catch (error) {
        sourceLedger.push(
          auditFromFailure("KorService2", "detailIntro2", error),
        );
        availability = unknownAvailability(
          "한국관광공사 상세 운영정보 호출에 실패해 운영 여부를 확정하지 못했습니다.",
        );
      }
    }

    const violations: RejectedCandidate[] = [];
    if (routedDistance > input.maxDistanceMeters) {
      const amount = Math.ceil(
        routedDistance - input.maxDistanceMeters,
      );
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "DISTANCE_LIMIT",
        reason: `실제 보행 경로 기준 최대 이동거리를 ${amount.toLocaleString("ko-KR")}m 늘려야 이 후보를 검토할 수 있습니다.`,
        distanceMeters: routedDistance,
        changedNodeCount: 1,
        requiredRelaxation: {
          constraint: "maximum_distance",
          amount,
          unit: "meters",
          currentLimit: input.maxDistanceMeters,
          requiredLimit: Math.ceil(routedDistance),
          description: `최대 이동거리 ${input.maxDistanceMeters.toLocaleString("ko-KR")}m → ${Math.ceil(routedDistance).toLocaleString("ko-KR")}m`,
          preservesLockedNodes: true,
          preservesNextFixedAppointment: true,
        },
      });
    }
    if (routedMinutes > input.availableMinutes) {
      const amount = Math.ceil(routedMinutes - input.availableMinutes);
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "TIME_LIMIT",
        reason: `현재 설정한 이동시간 한도보다 ${amount}분 더 필요합니다.`,
        distanceMeters: routedDistance,
        changedNodeCount: 1,
        requiredRelaxation: {
          constraint: "available_time",
          amount,
          unit: "minutes",
          currentLimit: input.availableMinutes,
          requiredLimit: Math.ceil(routedMinutes),
          description: `이동시간 한도 ${input.availableMinutes}분 → ${Math.ceil(routedMinutes)}분`,
          preservesLockedNodes: true,
          preservesNextFixedAppointment: true,
        },
      });
    }
    if (atRisk.length) {
      const shortfall = Math.max(
        ...atRisk.map(
          (waypoint) =>
            waypoint.requiredBufferMinutes -
            waypoint.arrivalBufferMinutes,
        ),
      );
      const firstRisk = atRisk[0];
      const minimumStayAfterRelaxation = minimumStay - shortfall;
      const safetyAfterRelaxation = safetyBuffer - shortfall;
      const requiredRelaxation =
        minimumStayAfterRelaxation >= 10
          ? {
              constraint: "minimum_stay" as const,
              amount: shortfall,
              unit: "minutes" as const,
              currentLimit: minimumStay,
              requiredLimit: minimumStayAfterRelaxation,
              description: `최소 체류 ${minimumStay}분 → ${minimumStayAfterRelaxation}분`,
              preservesLockedNodes: true as const,
              preservesNextFixedAppointment: true as const,
            }
          : atRisk.every(
                (waypoint) =>
                  waypoint.requiredBufferMinutes === safetyBuffer,
              ) && safetyAfterRelaxation >= 5
            ? {
                constraint: "safety_buffer" as const,
                amount: shortfall,
                unit: "minutes" as const,
                currentLimit: safetyBuffer,
                requiredLimit: safetyAfterRelaxation,
                description: `도착 안전여유 ${safetyBuffer}분 → ${safetyAfterRelaxation}분`,
                preservesLockedNodes: true as const,
                preservesNextFixedAppointment: true as const,
              }
            : undefined;
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode:
          firstRisk.nodeId === context.nextFixed?.id
            ? "NEXT_FIXED_APPOINTMENT_AT_RISK"
            : "CONTINUITY_WAYPOINT_AT_RISK",
        reason: requiredRelaxation
          ? `${firstRisk.title}의 예약 시각을 지키려면 ${requiredRelaxation.description} 한 가지 조정이 필요합니다.`
          : `${firstRisk.title}까지 원래 순서와 시각을 지키는 단일 조건 조정을 찾지 못했습니다.`,
        distanceMeters: routedDistance,
        changedNodeCount: 1,
        arrivalBufferMinutes: firstRisk.arrivalBufferMinutes,
        requiredRelaxation,
      });
    }
    if (availability.status === "confirmed_closed") {
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "OFFICIALLY_CLOSED",
        reason:
          availability.note ||
          "복구 일정 도착 시각에 공식 운영정보상 이용할 수 없습니다.",
        distanceMeters: routedDistance,
        changedNodeCount: 1,
      });
    }

    if (violations.length) {
      const [primary] = violations;
      if (violations.length > 1) {
        delete primary.requiredRelaxation;
        primary.reason = `${primary.reason} 또한 ${violations.length - 1}개의 필수 조건을 추가로 통과하지 못했습니다.`;
      }
      rejected.push(primary);
      return null;
    }
  } else if (candidate.contentTypeId) {
    try {
      const arrivalAt = new Date(scheduleDiff.replacementNode.startAt);
      const departureAt = new Date(scheduleDiff.replacementNode.endAt);
      const evidence = await getAvailabilityEvidence({
        contentId: candidate.contentId,
        contentTypeId: candidate.contentTypeId,
        startAt: arrivalAt,
        endAt: departureAt,
      }, { signal });
      sourceLedger.push(evidence.audit);
      availability = publicAvailability(evidence);
    } catch (error) {
      sourceLedger.push(
        auditFromFailure("KorService2", "detailIntro2", error),
      );
      availability = unknownAvailability(
        "한국관광공사 상세 운영정보 호출에 실패해 운영 여부를 확정하지 못했습니다.",
      );
    }
  }

  const continuityProof: ContinuityProof = {
    schemaVersion: "2026-07-v2",
    objective: context
      ? "minimize_changed_nodes_then_travel_minutes"
      : "minimize_travel_minutes_without_registered_itinerary",
    recoveryMode: context?.mode ?? "proximity_fallback",
    changedNodeCount: scheduleDiff.changedNodeCount,
    lockedNodesTotal: scheduleDiff.lockedNodeIds.length,
    lockedNodesPreserved: scheduleDiff.preservedLockedNodeIds.length,
    nextFixedAppointmentPreserved:
      scheduleDiff.nextFixedAppointment?.status === "preserved"
        ? true
        : scheduleDiff.nextFixedAppointment
          ? false
          : undefined,
    routeEvidence,
    availabilityEvidence: availability,
    purposePreservation: candidate.purposePreservation,
    weatherEvidence,
    generatedAt: new Date().toISOString(),
  };

  const withoutScores = {
    ...candidate,
    availability,
    routeEvidence,
    scheduleDiff,
    continuityProof,
  };
  return {
    ...withoutScores,
    ...scoreCandidate(withoutScores, input),
  };
}

function buildWhy(
  candidate: WorkingCandidate,
  input: RecoveryRequest,
): string[] {
  const reasons = [
    candidate.purposePreservation.statement,
    candidate.routeEvidence.status === "routed"
      ? `OpenStreetMap 보행 경로 기준 ${candidate.distanceMeters.toLocaleString("ko-KR")}m, 약 ${candidate.estimatedTravelMinutes}분입니다.`
      : `한국관광공사 위치정보 기준 직선거리 ${Math.round(candidate.distanceMeters).toLocaleString("ko-KR")}m입니다.`,
  ];

  const appointment = candidate.scheduleDiff.nextFixedAppointment;
  if (appointment?.status === "preserved") {
    reasons.push(
      `다음 고정 일정 '${appointment.title}' 도착 전 ${appointment.arrivalBufferMinutes}분의 여유를 확보합니다.`,
    );
  }
  if (candidate.scheduleDiff.changedNodeCount === 1) {
    reasons.push(
      `기존 일정 중 '${candidate.scheduleDiff.originalNode?.title ?? "중단 일정"}' 한 곳만 교체하고 나머지 잠금 일정을 유지합니다.`,
    );
  }
  if (candidate.availability.status === "confirmed_open") {
    reasons.push(
      "한국관광공사 공식 운영정보에서 복구 일정 도착 시각의 이용 가능성을 확인했습니다.",
    );
  } else if (
    candidate.availability.status === "official_hours_unstructured"
  ) {
    reasons.push(
      "한국관광공사 공식 운영시간 문구가 있으나 방문 직전 최종 확인이 필요합니다.",
    );
  }
  if (candidate.indoor && (input.incident === "rain" || input.indoorOnly)) {
    reasons.push(
      "한국관광공사 콘텐츠 유형을 근거로 실내 이용 가능성이 높은 후보입니다.",
    );
  }
  if (candidate.accessibility.status === "verified") {
    reasons.push(
      "무장애여행정보에서 요청한 이동 조건과 관련된 편의정보를 확인했습니다.",
    );
  }
  if (candidate.crowdRate !== undefined) {
    reasons.push(
      `관광지 집중률 예측값은 ${candidate.crowdRate.toFixed(2)}/100입니다. 실시간 현장 인원값은 아닙니다.`,
    );
  }
  if (candidate.relatedRank !== undefined) {
    reasons.push(
      `지역 연계방문 데이터에서 원래 여행지와의 연관 순위 ${candidate.relatedRank}위 근거가 있습니다.`,
    );
  }
  return reasons;
}

function sourcesFor(candidate: WorkingCandidate): KtoServiceName[] {
  const sources = new Set<KtoServiceName>(["KorService2"]);
  if (candidate.relatedRank !== undefined) sources.add("TarRlteTarService1");
  if (candidate.crowdRate !== undefined) sources.add("TatsCnctrRateService");
  if (candidate.accessibility.status === "verified") {
    sources.add("KorWithService2");
  }
  return [...sources];
}

function dataContributionsFor(
  candidate: WorkingCandidate,
): DataContribution[] {
  const contributions: DataContribution[] = [
    {
      source: "KorService2",
      fields: [
        "contentid",
        "contenttypeid",
        "title",
        "mapx",
        "mapy",
        "dist",
      ],
      decision: "실재 관광지와 위치·거리·콘텐츠 유형을 확인했습니다.",
      effect: "bounded",
      status: "applied",
    },
    {
      source: "KorService2",
      fields: ["usetime", "restdate", "eventstartdate", "eventenddate"],
      decision:
        candidate.availability.status === "confirmed_open"
          ? "대체 일정 도착 시각의 공식 운영 가능성을 확인했습니다."
          : "공식 운영정보의 확인 수준을 복구 증명에 반영했습니다.",
      effect:
        candidate.availability.status === "confirmed_open"
          ? "verified"
          : "bounded",
      status:
        candidate.availability.status === "unknown"
          ? "unavailable"
          : "applied",
    },
  ];

  if (candidate.routeEvidence.status === "routed") {
    contributions.push({
      source: "OpenStreetMap Routing",
      fields: ["distance", "duration", "legs", "geometry"],
      decision:
        "현재 위치→대체 일정→다음 고정 일정의 실제 보행 경로와 도착 버퍼를 계산했습니다.",
      effect: "verified",
      status: "applied",
    });
  }
  if (candidate.relatedRank !== undefined) {
    contributions.push({
      source: "TarRlteTarService1",
      fields: ["tAtsNm", "rlteTatsNm", "rlteRank"],
      decision: "원래 여행 목적과 연결성이 높은 대안을 우선순위에 반영했습니다.",
      effect: "ranked",
      status: "applied",
    });
  }
  if (candidate.crowdRate !== undefined) {
    contributions.push({
      source: "TatsCnctrRateService",
      fields: ["tAtsNm", "cnctrRate", "baseYmd"],
      decision: "관광 집중률 예측을 혼잡 회피 판정과 순위에 반영했습니다.",
      effect: "ranked",
      status: "applied",
    });
  }
  if (candidate.accessibility.status === "verified") {
    contributions.push({
      source: "KorWithService2",
      fields: candidate.accessibility.confirmedFields.map(
        (entry) => entry.field,
      ),
      decision: `접근성 필수 동선 등급 ${candidate.accessibility.grade}를 확인했습니다.`,
      effect: "verified",
      status: "applied",
    });
  }
  const weather = candidate.continuityProof.weatherEvidence;
  if (weather) {
    contributions.push({
      source: "Open-Meteo",
      fields:
        weather.status === "available"
          ? [
              "precipitation",
              "precipitation_probability",
              "weather_code",
            ]
          : [],
      decision:
        weather.status === "available"
          ? "현재 기상 상태를 복구 상황 근거로 함께 기록했습니다."
          : "기상 공급자의 응답 실패를 복구 증명에 공개했습니다.",
      effect: "bounded",
      status: weather.status === "available" ? "applied" : "unavailable",
    });
  }
  return contributions;
}

function toOption(
  candidate: WorkingCandidate,
  strategy: RecoveryOption["strategy"],
  strategyLabel: string,
  requestId: string,
  input: RecoveryRequest,
): RecoveryOption {
  return {
    id: `${requestId}-${strategy}-${candidate.contentId}`,
    strategy,
    strategyLabel,
    /* Travels with the option so the traveller is told which conditions were
       not confirmed. An option with gaps is a suggestion to check, never a
       verified result. */
    evidenceGaps: candidate.evidenceGaps,
    confirmationRequired: candidate.evidenceGaps.length > 0,
    contentId: candidate.contentId,
    title: candidate.title,
    address: candidate.address,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    imageUrl: candidate.imageUrl,
    contentTypeId: candidate.contentTypeId,
    score: candidate.baseScore,
    distanceMeters: Math.round(candidate.distanceMeters),
    estimatedTravelMinutes: candidate.estimatedTravelMinutes,
    travelEstimate:
      candidate.routeEvidence.status === "routed"
        ? "routed"
        : "geodesic_conservative",
    routeGeometry:
      candidate.routeEvidence.status === "routed"
        ? candidate.routeEvidence.geometry
        : undefined,
    availability: candidate.availability,
    indoorSuitability:
      input.incident === "rain" || input.indoorOnly
        ? {
            status: "type_based",
            note: "한국관광공사 콘텐츠 유형을 근거로 한 실내 적합성 판정입니다. 건물별 실제 동선은 최종 확인이 필요합니다.",
          }
        : {
            status: "not_required",
            note: "이번 복구 요청은 실내 장소를 필수 조건으로 사용하지 않았습니다.",
          },
    accessibility: candidate.accessibility,
    crowd:
      candidate.crowdRate === undefined
        ? {
            status: "unavailable",
            note: "이 관광지와 정확히 일치하는 집중률 예측을 확인하지 못했습니다.",
          }
        : {
            status: "available",
            relativeRate: candidate.crowdRate,
            baseDate: candidate.crowdBaseDate,
            note: "향후 관광 집중률 예측값이며 실시간 현장 인원값은 아닙니다.",
          },
    relatedRank: candidate.relatedRank,
    purposePreservation: candidate.purposePreservation,
    why: buildWhy(candidate, input),
    sources: sourcesFor(candidate),
    sourceModifiedAt: candidate.modifiedAt,
    scheduleDiff: candidate.scheduleDiff,
    continuityProof: candidate.continuityProof,
    dataContributions: dataContributionsFor(candidate),
  };
}

function pickOptions(
  candidates: WorkingCandidate[],
  requestId: string,
  input: RecoveryRequest,
): RecoveryOption[] {
  if (!candidates.length) return [];

  const selected: Array<{
    candidate: WorkingCandidate;
    strategy: RecoveryOption["strategy"];
    label: string;
  }> = [];
  const used = new Set<string>();

  const add = (
    candidate: WorkingCandidate | undefined,
    strategy: RecoveryOption["strategy"],
    label: string,
  ) => {
    if (!candidate || used.has(candidate.contentId)) return;
    used.add(candidate.contentId);
    selected.push({ candidate, strategy, label });
  };

  add(
    [...candidates].sort((a, b) => {
      const changed =
        a.scheduleDiff.changedNodeCount - b.scheduleDiff.changedNodeCount;
      if (changed) return changed;
      const aTotal =
        a.routeEvidence.status === "routed"
          ? a.routeEvidence.durationMinutes
          : a.estimatedTravelMinutes;
      const bTotal =
        b.routeEvidence.status === "routed"
          ? b.routeEvidence.durationMinutes
          : b.estimatedTravelMinutes;
      return aTotal - bTotal || b.baseScore - a.baseScore;
    })[0],
    "minimum_change",
    input.itinerary
      ? "잠금 일정을 지키는 최소변경"
      : "가장 가까운 조건충족 대안",
  );
  add(
    [...candidates].sort(
      (a, b) => b.comfortScore - a.comfortScore || b.baseScore - a.baseScore,
    )[0],
    "comfortable",
    "이동 편의 우선",
  );
  add(
    [...candidates].sort((a, b) => {
      const aRank = a.relatedRank ?? 999;
      const bRank = b.relatedRank ?? 999;
      return aRank - bRank || b.baseScore - a.baseScore;
    })[0],
    "local_discovery",
    "여행 목적과 지역 연결",
  );

  for (const candidate of [...candidates].sort(
    (a, b) => b.baseScore - a.baseScore,
  )) {
    if (selected.length >= 3) break;
    add(candidate, "local_discovery", "추가 검증 대안");
  }

  return selected.map(({ candidate, strategy, label }) =>
    toOption(candidate, strategy, label, requestId, input),
  );
}

/* Groups rejections by reason so an empty result can explain itself. */
function summariseRejections(
  rejected: RejectedCandidate[],
): Array<{ reasonCode: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of rejected) {
    counts.set(entry.reasonCode, (counts.get(entry.reasonCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((a, b) => b.count - a.count);
}

function selectCounterfactual(
  rejected: RejectedCandidate[],
): RecoveryResult["counterfactual"] {
  const eligible = rejected
    .filter(
      (
        candidate,
      ): candidate is RejectedCandidate & {
        requiredRelaxation: NonNullable<
          RejectedCandidate["requiredRelaxation"]
        >;
      } => Boolean(candidate.requiredRelaxation),
    )
    .sort((a, b) => {
      const normalizedA =
        a.requiredRelaxation.unit === "meters"
          ? a.requiredRelaxation.amount / 100
          : a.requiredRelaxation.amount;
      const normalizedB =
        b.requiredRelaxation.unit === "meters"
          ? b.requiredRelaxation.amount / 100
          : b.requiredRelaxation.amount;
      return (
        normalizedA - normalizedB ||
        (a.distanceMeters ?? Number.POSITIVE_INFINITY) -
          (b.distanceMeters ?? Number.POSITIVE_INFINITY)
      );
    });
  const best = eligible[0];
  if (!best) return undefined;
  return {
    ...best,
    proofType: "single_constraint_minimum_relaxation",
    changedNodeCount: 1,
  };
}

export async function recoverTrip(
  input: RecoveryRequest,
  requestId = crypto.randomUUID(),
  execution: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<RecoveryResult> {
  const context = itineraryContext(input);
  const recoveryMode: RecoveryMode =
    context?.mode ?? "proximity_fallback";
  const warnings = context
    ? [
        "운영정보와 경로는 호출 시점의 공식·공개 데이터를 기준으로 검증합니다. 예약 자체와 현장 안전을 보증하지 않으므로 출발 직전 운영기관 안내를 확인하세요.",
      ]
    : [
        "등록된 원래 일정이 없어 주변 조건충족 대안으로 계산했습니다. 최소변경과 다음 예약 보존을 검증하려면 최초 일정과 잠금 일정을 등록하세요.",
        "이동시간은 직선거리 기반 보수 추정이며 실제 도로·대중교통 경로가 아닙니다.",
      ];
  const sourceLedger: KtoAudit[] = [];
  const rejected: RejectedCandidate[] = [];

  let nearby: KtoCallResult;
  try {
    nearby = await getNearbyTourism({
      longitude: input.origin.longitude,
      latitude: input.origin.latitude,
      radius: input.radiusMeters,
      regionCode: input.origin.areaCode,
      districtCode: input.origin.sigunguCode,
      /* Candidate discovery is the one call the whole recovery depends on:
         without it there is nothing to filter and the request ends with no
         options at all. Its latency upstream is bimodal — measured at roughly
         0.2s for most calls with an occasional ten-second outlier — so a lone
         four-second attempt turns that tail straight into a failed recovery.
         The adapter hedges this call, which changes what the timeout is for.
         A short timeout would cut off the slow path — those calls do finish,
         around six seconds — while the hedge already covers the common case in
         well under two. So the budget is set wide enough to let a slow call
         land rather than abandoning work that was nearly done, and the hedge,
         not the timeout, is what keeps the usual request fast. */
    }, { signal: execution.signal, timeoutMs: 9_000, retry: false });
    sourceLedger.push(nearby.audit);
  } catch (error) {
    sourceLedger.push(
      auditFromFailure("KorService2", "locationBasedList2", error),
    );
    return {
      requestId,
      status: "upstream_unavailable",
      recoveryMode,
      itinerarySummary: context
        ? {
            itineraryId: context.id,
            title: context.title,
            disruptedNodeId: context.disrupted.id,
            nextFixedNodeId: context.nextFixed?.id,
            lockedNodeCount: context.lockedNodeIds.length,
          }
        : undefined,
      scope: {
        coverage: "nationwide",
        regionCode: input.origin.areaCode,
        districtCode: input.origin.sigunguCode,
        originLabel: input.origin.label,
      },
      options: [],
      rejectedCount: 0,
      rejectionSummary: [],
      dataContributions: [],
      sourceLedger,
      warnings: [
        ...warnings,
        "핵심 관광정보를 확인하지 못해 실제 장소를 임의로 만들어 추천하지 않았습니다.",
      ],
      generatedAt: new Date().toISOString(),
      ruleVersion: RECOVERY_RULE_VERSION,
    };
  }

  const firstCodes = nearby.items[0]
    ? normalizeAnalysisCodes(nearby.items[0])
    : {};
  const regionCode = input.origin.areaCode ?? firstCodes.regionCode;
  const districtCode = input.origin.sigunguCode ?? firstCodes.districtCode;

  const relatedPromise =
    regionCode && districtCode
      ? getRelatedTourism({
          regionCode,
          districtCode,
          baseYm: previousCompleteMonth(),
        }, { signal: execution.signal, timeoutMs: 4_000, retry: false })
      : Promise.resolve(undefined);
  const crowdPromise =
    regionCode && districtCode
      ? getConcentrationForecast(
          { regionCode, districtCode },
          { signal: execution.signal, timeoutMs: 4_000, retry: false },
        )
      : Promise.resolve(undefined);
  const accessiblePromise =
    input.audience === "general"
      ? Promise.resolve(undefined)
      : getNearbyAccessibleTourism({
          longitude: input.origin.longitude,
          latitude: input.origin.latitude,
          radius: input.radiusMeters,
        }, { signal: execution.signal, timeoutMs: 4_000, retry: false });
  const weatherPromise = context
      ? getWeatherEvidence(
          input.origin.latitude,
          input.origin.longitude,
          { signal: execution.signal },
        )
    : Promise.resolve(undefined);

  const [
    relatedSettled,
    crowdSettled,
    accessibleSettled,
    weatherSettled,
  ] = await Promise.allSettled([
    relatedPromise,
    crowdPromise,
    accessiblePromise,
    weatherPromise,
  ]);

  let relatedItems: KtoItem[] = [];
  if (relatedSettled.status === "fulfilled" && relatedSettled.value) {
    relatedItems = relatedSettled.value.items;
    sourceLedger.push(relatedSettled.value.audit);
  } else if (regionCode && districtCode) {
    sourceLedger.push(
      auditFromFailure(
        "TarRlteTarService1",
        "areaBasedList1",
        relatedSettled.status === "rejected"
          ? relatedSettled.reason
          : undefined,
      ),
    );
    warnings.push(
      "연계 관광지 데이터가 없어 여행 목적 유사성은 거리와 조건 중심으로 계산했습니다.",
    );
  } else {
    sourceLedger.push(
      notRequiredAudit("TarRlteTarService1", "areaBasedList1"),
    );
  }

  let crowdItems: KtoItem[] = [];
  if (crowdSettled.status === "fulfilled" && crowdSettled.value) {
    crowdItems = crowdSettled.value.items;
    sourceLedger.push(crowdSettled.value.audit);
  } else if (regionCode && districtCode) {
    sourceLedger.push(
      auditFromFailure(
        "TatsCnctrRateService",
        "tatsCnctrRatedList",
        crowdSettled.status === "rejected"
          ? crowdSettled.reason
          : undefined,
      ),
    );
    warnings.push(
      "관광 집중률 예측을 확인하지 못한 후보에는 혼잡 근거를 표시하지 않습니다.",
    );
  } else {
    sourceLedger.push(
      notRequiredAudit("TatsCnctrRateService", "tatsCnctrRatedList"),
    );
  }

  let accessibleItems: KtoItem[] = [];
  if (accessibleSettled.status === "fulfilled" && accessibleSettled.value) {
    accessibleItems = accessibleSettled.value.items;
    sourceLedger.push(accessibleSettled.value.audit);
  } else if (input.audience !== "general") {
    sourceLedger.push(
      auditFromFailure(
        "KorWithService2",
        "locationBasedList2",
        accessibleSettled.status === "rejected"
          ? accessibleSettled.reason
          : undefined,
      ),
    );
    warnings.push(
      "무장애여행정보를 검증하지 못해 접근성 조건 후보를 자동 통과시키지 않았습니다.",
    );
  } else {
    sourceLedger.push(
      notRequiredAudit("KorWithService2", "locationBasedList2"),
    );
  }

  const weatherEvidence =
    weatherSettled.status === "fulfilled"
      ? weatherSettled.value
      : undefined;
  if (
    context &&
    input.incident === "rain" &&
    weatherEvidence?.status === "available" &&
    !weatherEvidence.raining
  ) {
    warnings.push(
      "현재 위치의 자동 기상 확인에서는 강수가 감지되지 않았지만 사용자가 선택한 우천 상황을 우선 적용했습니다.",
    );
  }

  const relatedRanks = relatedRankByTitle(
    relatedItems,
    context?.disrupted.title ?? input.origin.label,
  );
  const forecasts = currentForecastByTitle(crowdItems);
  const accessibleIds = new Set(
    accessibleItems.map((item) => stringValue(item.contentid)).filter(Boolean),
  );
  const indoorRequired = input.indoorOnly || input.incident === "rain";

  const preliminary: WorkingCandidate[] = [];
  for (const item of nearby.items) {
    const contentId = stringValue(item.contentid);
    const contentTypeId = stringValue(item.contenttypeid);
    const title = stringValue(item.title) || "이름 미확인 관광지";
    const latitude = numberValue(item.mapy);
    const longitude = numberValue(item.mapx);
    if (!contentId || latitude === undefined || longitude === undefined) {
      rejected.push({
        contentId: contentId || undefined,
        title,
        reasonCode: "INVALID_COORDINATE",
        reason: "공식 위치 좌표를 확인하지 못했습니다.",
      });
      continue;
    }

    if (
      context &&
      normalizeName(title) === normalizeName(context.disrupted.title)
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "SAME_AS_DISRUPTED_PLACE",
        reason:
          "문제가 생긴 원래 장소와 같은 장소이므로 대체 일정에서 제외했습니다.",
      });
      continue;
    }

    const relatedRank = relatedRanks.get(normalizeName(title));
    if (
      !preservesTravelPurpose({
        input,
        contentTypeId,
        relatedRank,
      })
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "TRAVEL_PURPOSE_MISMATCH",
        reason:
          "원래 일정에서 하려던 여행 활동과 다른 유형이라 복구 후보에서 제외했습니다.",
      });
      continue;
    }

    const apiDistance = numberValue(item.dist);
    const distanceMeters =
      apiDistance ??
      haversineMeters(input.origin, {
        latitude,
        longitude,
      });
    const nearMissDistanceCeiling =
      input.maxDistanceMeters +
      Math.min(2_000, Math.max(500, input.maxDistanceMeters * 0.5));
    if (
      distanceMeters > input.maxDistanceMeters &&
      (!context || distanceMeters > nearMissDistanceCeiling)
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "DISTANCE_LIMIT",
        reason: `최대 이동거리 ${input.maxDistanceMeters.toLocaleString("ko-KR")}m를 초과합니다.`,
        distanceMeters,
      });
      continue;
    }

    const estimatedTravelMinutes =
      conservativeWalkingMinutes(distanceMeters);
    if (
      estimatedTravelMinutes > input.availableMinutes &&
      (!context ||
        estimatedTravelMinutes > input.availableMinutes + 30)
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "TIME_LIMIT",
        reason: `보수 추정 이동시간이 가용시간 ${input.availableMinutes}분을 초과합니다.`,
        distanceMeters,
      });
      continue;
    }

    /* Coverage of the supporting datasets is partial — accessibility details
       and concentration forecasts exist mainly for major sites, and indoor use
       can only be inferred from the content type. Treating "not stated" as
       "fails" emptied the result for exactly the travellers who need it most:
       across ten scenarios these three checks removed 219 candidates and left
       stroller, wheelchair and crowd journeys with nothing at all.

       The proposal's rule is three-tier — verified, needs confirmation,
       excluded — so an unconfirmed condition is recorded as a gap rather than
       a rejection. Verified candidates still rank first, the gap travels with
       the option through to the response, and nothing is ever presented as
       checked when it was not. Hard facts (time, distance, confirmed closure)
       continue to exclude outright. */
    const indoor = isIndoorType(item);
    const evidenceGaps: EvidenceGap[] = [];
    if (indoorRequired && !indoor) {
      evidenceGaps.push({
        code: "INDOOR_UNVERIFIED",
        note: "공식 콘텐츠 유형만으로 실내 이용 가능성을 확인하지 못했습니다.",
      });
    }

    if (input.audience !== "general" && !accessibleIds.has(contentId)) {
      evidenceGaps.push({
        code: "ACCESSIBILITY_UNVERIFIED",
        note: "무장애여행정보 목록에서 같은 콘텐츠를 확인하지 못했습니다.",
      });
    }

    const forecast = forecasts.get(normalizeName(title));
    if (input.incident === "crowd" && !forecast) {
      evidenceGaps.push({
        code: "CONCENTRATION_UNVERIFIED",
        note: "이 관광지의 향후 집중률 예측을 확인하지 못했습니다.",
      });
    }
    if (
      input.incident === "crowd" &&
      forecast &&
      forecast.rate >= 80
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "CONCENTRATION_HIGH",
        reason: `향후 집중률 예측값이 ${forecast.rate.toFixed(2)}/100으로 높습니다.`,
        distanceMeters,
      });
      continue;
    }

    const availability = unknownAvailability();
    const scheduleDiff = fallbackScheduleDiff({
      contentId,
      title,
      estimatedTravelMinutes,
    });
    const routeEvidence = geodesicEvidence(
      distanceMeters,
      estimatedTravelMinutes,
    );
    const continuityProof = fallbackContinuityProof({
      candidate: { distanceMeters, estimatedTravelMinutes },
      availability,
    });
    const candidateWithoutScores = {
      item,
      contentId,
      contentTypeId,
      title,
      address: stringValue(item.addr1) || "주소 정보 미확인",
      latitude,
      longitude,
      distanceMeters,
      estimatedTravelMinutes,
      imageUrl: normalizedImage(item.firstimage),
      modifiedAt: stringValue(item.modifiedtime) || undefined,
      evidenceGaps,
      indoor,
      relatedRank,
      purposePreservation: buildTravelPurposeProof({
        input,
        replacementTitle: title,
        contentTypeId,
        relatedRank,
      }),
      crowdRate: forecast?.rate,
      crowdBaseDate: forecast?.baseDate,
      accessibility: evaluateAccessibility(input.audience),
      availability,
      routeEvidence,
      scheduleDiff,
      continuityProof,
    };
    preliminary.push({
      ...candidateWithoutScores,
      ...scoreCandidate(candidateWithoutScores, input),
    });
  }

  preliminary.sort(
    (a, b) => b.baseScore - a.baseScore || a.distanceMeters - b.distanceMeters,
  );

  const { details, audits: detailAudits } = await accessibilityDetails(
    preliminary,
    input.audience,
    execution.signal,
  );
  sourceLedger.push(...detailAudits);

  const accessibilityVerified = preliminary
    .map((candidate) => {
      const accessibility = evaluateAccessibility(
        input.audience,
        details.get(candidate.contentId),
      );
      const withAccessibility = { ...candidate, accessibility };
      return {
        ...withAccessibility,
        ...scoreCandidate(withAccessibility, input),
      };
    })
    .map((candidate) => {
      /* Same three-tier rule as the earlier checks: a detail lookup that came
         back without accessibility fields records a gap, it does not delete
         the candidate. */
      if (
        input.audience !== "general" &&
        candidate.accessibility.status !== "verified" &&
        !candidate.evidenceGaps.some(
          (gap) => gap.code === "ACCESSIBILITY_UNVERIFIED",
        )
      ) {
        return {
          ...candidate,
          evidenceGaps: [
            ...candidate.evidenceGaps,
            {
              code: "ACCESSIBILITY_UNVERIFIED" as const,
              note: candidate.accessibility.note,
            },
          ],
        };
      }
      return candidate;
    })
    /* Fully confirmed candidates are verified and offered first; those with a
       gap are only reached when there are not enough confirmed ones. */
    .sort((a, b) => a.evidenceGaps.length - b.evidenceGaps.length);

  const continuityDeadlineAt =
    execution.deadlineAt ?? Date.now() + 18_000;

  /* Verifying the shortlist in sequence made the response time the sum of
     three candidates rather than roughly one. Each candidate waits on a
     walking route and an opening-hours lookup that do not depend on each
     other, so they are verified together. The routing provider's own pacing
     still orders those requests; what this removes is the idle time where one
     candidate's opening-hours call sat waiting for another candidate's route.
     Failures stay per-candidate — one that cannot be verified drops out
     without taking the others with it. */
  const continuityCandidates: WorkingCandidate[] = [];
  const shortlist = accessibilityVerified.slice(0, 3);
  if (Date.now() >= continuityDeadlineAt || execution.signal?.aborted) {
    warnings.push(
      "위기 순간 응답시간을 지키기 위해 상위 후보 검증을 중단했습니다. 확인하지 않은 후보를 결과처럼 표시하지 않았습니다.",
    );
  } else {
    const settled = await Promise.allSettled(
      shortlist.map((candidate) =>
        enrichForContinuity({
          candidate,
          input,
          context,
          sourceLedger,
          rejected,
          weatherEvidence,
          signal: execution.signal,
        }),
      ),
    );
    for (const entry of settled) {
      if (entry.status === "fulfilled" && entry.value) {
        continuityCandidates.push(entry.value);
      }
    }
  }

  const options = pickOptions(continuityCandidates, requestId, input);
  const hasSourceFailure = sourceLedger.some(
    (audit) => audit.status === "error",
  );
  const hasConditionalEvidence = options.some(
    (option) =>
      option.availability.status !== "confirmed_open" ||
      (context &&
        option.continuityProof.routeEvidence.status !== "routed") ||
      (input.incident === "rain" &&
        option.continuityProof.weatherEvidence?.status !== "available"),
  );
  const status =
    options.length === 0
      ? "no_valid_candidate"
      : hasSourceFailure || hasConditionalEvidence
        ? "degraded"
        : "verified";

  if (!options.length) {
    warnings.push(
      context?.nextFixed
        ? "다음 고정 일정의 도착 안전여유와 모든 필수 조건을 함께 만족하는 복구안을 찾지 못했습니다. 잠금 일정을 임의로 변경하지 않았습니다."
        : "현재 조건을 모두 만족하는 공식 관광지 후보를 찾지 못했습니다. 존재하지 않는 장소를 만들어 추천하지 않았습니다.",
    );
  }

  const dataContributions = options
    .flatMap((option) => option.dataContributions)
    .filter(
      (contribution, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.source === contribution.source &&
            candidate.decision === contribution.decision,
        ) === index,
    );

  return {
    requestId,
    status,
    recoveryMode,
    itinerarySummary: context
      ? {
          itineraryId: context.id,
          title: context.title,
          disruptedNodeId: context.disrupted.id,
          nextFixedNodeId: context.nextFixed?.id,
          lockedNodeCount: context.lockedNodeIds.length,
        }
      : undefined,
    scope: {
      coverage: "nationwide",
      regionCode,
      districtCode,
      originLabel: input.origin.label,
    },
    options,
    rejectedCount: rejected.length,
    /* Which constraint actually removed the candidates. Without this a run
       that returns nothing is indistinguishable from a broken one — for the
       traveller, who cannot tell "no room in your schedule" from "the service
       failed", and for the operator, who cannot tell which filter is doing
       the work. Counts only; no place names, so it stays safe to log. */
    rejectionSummary: summariseRejections(rejected),
    counterfactual: selectCounterfactual(rejected),
    dataContributions,
    sourceLedger,
    warnings,
    generatedAt: new Date().toISOString(),
    ruleVersion: RECOVERY_RULE_VERSION,
  };
}
