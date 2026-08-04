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
import {
  KtoError,
  type KtoAudit,
  type KtoCallResult,
  type KtoItem,
  type KtoServiceName,
} from "@/lib/kto/types";
import {
  conservativeDrivingMinutes,
  conservativeWalkingMinutes,
  haversineMeters,
} from "@/lib/geo";
import {
  getRoute,
  type WalkingRouteEvidence,
  type WalkingRouteProvider,
} from "@/lib/mobility/routing";
import { getWeatherEvidence } from "@/lib/weather/service";
import { withParticle } from "@/lib/text/korean";
import { strictFiniteNumber } from "@/lib/validation/numbers";
import type { RecoveryRequest } from "./schema";
import type {
  EvidenceGap,
  AccessibilityEvidence,
  ContinuityProof,
  DataContribution,
  OpenWindowProof,
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
  /* 원래 일정 한 곳을 교체하는지, 빈 시간에 한 곳을 끼워 넣는지. `insert`인
     경우 `disrupted`는 없고 보존 대상은 창의 끝 또는 다음 장소뿐이다. */
  changeKind: "replace" | "insert";
  id?: string;
  title: string;
  occurredAt: Date;
  disrupted?: ItineraryNode;
  nextFixed?: ItineraryNode;
  continuityNodes: ItineraryNode[];
  sortedNodes: ItineraryNode[];
  lockedNodeIds: string[];
  originalDurationMinutes: number;
  /* `insert`에서만 채워진다. 창 안에 들어가는지 판정할 때 쓴다. */
  openWindow?: {
    endAt: Date;
    plannedStayMinutes: number;
    nextPlaceLabel?: string;
    nextPlaceArriveBy?: Date;
  };
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

function numberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return strictFiniteNumber(value, { minimum, maximum });
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

const VERIFIED_INDOOR_CATEGORY_CODES = new Set([
  "A02060100", // museum
  "A02060200", // memorial hall
  "A02060300", // exhibition hall
  "A02060400", // convention centre
  "A02060500", // art museum / gallery
  "A02060600", // performance hall
  "A02060700", // cultural centre
  "A02060800", // library
  "A02060900", // large bookstore
  "A02061000", // cultural school
  "A02061100", // cinema
  "A04010100", // department store
  "A04010200", // shopping centre
  "A04010400", // duty-free shop
]);

export function hasVerifiedIndoorEvidence(item: KtoItem): boolean {
  const contentTypeId = stringValue(item.contenttypeid);
  const title = stringValue(item.title);
  const categoryCode = stringValue(
    item.cat3 ?? item.lclsSystm3 ?? item.lclsSystm2,
  );
  const explicitOutdoor =
    /공원|산책로|둘레길|트레킹|해변|해수욕장|광장|정원|수목원|숲|산\b|계곡|폭포|캠핑|야영|전망대|유적|고궁|궁궐|성곽|섬|항구|시장/i.test(
      `${title} ${stringValue(item.cat1)} ${stringValue(item.cat2)} ${categoryCode}`,
    );
  if (explicitOutdoor) return false;
  if (VERIFIED_INDOOR_CATEGORY_CODES.has(categoryCode)) return true;

  /* Food establishments are an indoor TourAPI content class unless the
     record explicitly describes an outdoor venue above. Culture and shopping
     are too broad (parks and traditional markets are often classified there),
     so they additionally require an indoor-specific name. */
  if (contentTypeId === "39") return true;
  const explicitIndoorName =
    /박물관|미술관|전시관|기념관|과학관|도서관|문화관|문화센터|공연장|극장|영화관|아쿠아리움|수족관|백화점|쇼핑몰|면세점|실내|갤러리|체험관/i.test(
      title,
    );
  return (
    explicitIndoorName &&
    (contentTypeId === "14" || contentTypeId === "38")
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
      note: "이동 편의 조건을 따로 요청하지 않았습니다.",
      noteEn: "You did not request any specific mobility condition.",
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
      note: "한국관광공사 무장애여행정보에서 이 곳의 편의정보를 찾지 못했습니다.",
      noteEn:
        "No barrier-free facility record was found for this place in the official data.",
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
    const rate = numberInRange(item.cnctrRate, 0, 100);
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
    const rank = numberInRange(item.rlteRank, 1, 100_000);
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

/* `tier`는 "관광·체험을 하려던 사람에게 이 유형이 얼마나 관광다운가"이다.
   식당·쇼핑을 후보에서 빼면 도심에서 대안이 거의 사라지므로(아래
   preservesTravelPurpose 주석의 실측) 제외하지 않는다. 대신 순위에서
   관광 콘텐츠를 앞세워, 박물관이 있는데 간장게장이 1순위로 올라오는 일을
   막는다. 점수 차이가 없으면 사용자는 고를 근거가 없다. */
function candidatePurpose(contentTypeId: string): {
  key: string;
  label: string;
  tier: "sightseeing" | "shopping" | "meal" | "stay" | "unknown";
} {
  const purposes: Record<
    string,
    { key: string; label: string; tier: "sightseeing" | "shopping" | "meal" | "stay" }
  > = {
    "12": { key: "nature", label: "자연 관광", tier: "sightseeing" },
    "14": { key: "culture", label: "문화·전시 관람", tier: "sightseeing" },
    "15": { key: "festival", label: "축제·공연 관람", tier: "sightseeing" },
    "25": { key: "course", label: "여행 코스 체험", tier: "sightseeing" },
    "28": { key: "activity", label: "레포츠·체험", tier: "sightseeing" },
    "32": { key: "stay", label: "숙박", tier: "stay" },
    "38": { key: "shopping", label: "쇼핑·시장 방문", tier: "shopping" },
    "39": { key: "meal", label: "식사", tier: "meal" },
  };
  return purposes[contentTypeId] ?? {
    key: "visit",
    label: "관광 방문",
    tier: "unknown",
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

  /* 빈 시간 추천에는 보존할 원래 목적이 없다. 여기서 기존 분기를 그대로 타면
     "원래 하려던 관광·체험 대신…"처럼 사용자가 말한 적 없는 계획을 근거로
     제시하게 된다. 다음 장소를 알려 준 경우에만 그 장소와의 연결을 주장하고,
     아니면 아무 목적도 주장하지 않는다. */
  const openWindow = params.input.openWindow;
  if (openWindow) {
    const nextPlaceLabel = openWindow.nextPlace?.label;
    if (nextPlaceLabel) {
      return {
        status: "open_window_flow",
        originalPurpose: "지금 비어 있는 시간",
        replacementPurpose: replacement.label,
        originalStopTitle: nextPlaceLabel,
        replacementTitle: params.replacementTitle,
        evidenceSource:
          params.relatedRank !== undefined
            ? "TarRlteTarService1"
            : "KorService2",
        relatedRank: params.relatedRank,
        statement:
          params.relatedRank !== undefined
            ? `${withParticle(nextPlaceLabel, "와/과")} 함께 방문한 기록이 실제로 있는 곳입니다.`
            : `${withParticle(nextPlaceLabel, "으로/로")} 가는 길에 들를 수 있는 공식 관광 콘텐츠입니다.`,
        statementEn:
          params.relatedRank !== undefined
            ? `Official data records real visits to this place together with ${nextPlaceLabel}.`
            : `Official tourism content you can stop at on the way to ${nextPlaceLabel}.`,
      };
    }
    return {
      status: "open_window_unconstrained",
      originalPurpose: "지금 비어 있는 시간",
      replacementPurpose: replacement.label,
      originalStopTitle: params.input.origin.label,
      replacementTitle: params.replacementTitle,
      /* 보존할 목적이 없으므로 목적 근거로 쓴 공사 API도 없다. */
      evidenceSource: "none",
      statement: `남은 시간 안에 다녀올 수 있는 ${replacement.label} 공식 관광 콘텐츠입니다. 원래 계획을 알려 주지 않으셨으므로 목적 유지 여부는 판단하지 않았습니다.`,
      statementEn: `Official ${replacement.label} content you can visit and return from within your remaining time. You did not tell us an original plan, so no intent match is claimed.`,
    };
  }

  if (params.relatedRank !== undefined) {
    return {
      status: "verified_related_place",
      originalPurpose: original.label,
      replacementPurpose: replacement.label,
      originalStopTitle,
      replacementTitle: params.replacementTitle,
      evidenceSource: "TarRlteTarService1",
      relatedRank: params.relatedRank,
      statement: `${withParticle(originalStopTitle, "와/과")} 함께 방문한 기록이 실제로 있는 곳입니다.`,
      statementEn: `Official data records real visits to this place together with ${originalStopTitle}.`,
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
      statement: `${original.label} 일정을 같은 종류의 장소로 이어갑니다. 활동은 바뀌지 않습니다.`,
      statementEn: `Your ${original.label} stop continues at a place of the same kind — the activity does not change.`,
    };
  }

  /* 관광·체험을 하려던 사람에게 관광 콘텐츠를 제안하는 경우에만 "목적을
     유지한다"고 말한다. 식사·쇼핑으로 바뀐 후보에 같은 문장을 쓰면 화면에
     "관광·체험 → 식사"라고 표시하면서 목적을 유지했다고 주장하는 모순이
     생긴다. 바뀐 것은 바뀐 대로 쓴다. */
  if (replacement.tier === "sightseeing" || replacement.tier === "unknown") {
    return {
      status: "supported_visit_category",
      originalPurpose: original.label,
      replacementPurpose: replacement.label,
      originalStopTitle,
      replacementTitle: params.replacementTitle,
      evidenceSource: "KorService2",
      statement: `${withParticle(originalStopTitle, "와/과")} 같은 관광·체험 목적으로 이어지는 공식 관광 콘텐츠입니다.`,
      statementEn: `Official tourism content that continues the same sightseeing intent as ${originalStopTitle}.`,
    };
  }

  return {
    status: "changed_visit_category",
    originalPurpose: original.label,
    replacementPurpose: replacement.label,
    originalStopTitle,
    replacementTitle: params.replacementTitle,
    evidenceSource: "KorService2",
    statement: `원래 하려던 ${original.label} 대신 ${replacement.label} 장소입니다. 남은 시간과 조건 안에서 갈 수 있는 공식 관광정보로 제안합니다.`,
    statementEn: `This is a ${replacement.label} place instead of the ${original.label} you planned. It is offered because it is reachable within your remaining time and conditions.`,
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
    changeKind: "replace",
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

/* 빈 시간 추천의 컨텍스트. 사용자가 알려 준 것은 "지금 어디에 있고, 언제까지
   비어 있고, 한 곳에 얼마나 머물 생각인지"이고 다음 장소는 선택이다. 다음
   장소를 알려 준 경우에는 그 장소를 잠금 노드로 취급해 기존 연속성 검증을 그대로
   재사용한다. 알려 주지 않은 경우에는 보존 대상이 창의 끝 시각뿐이다. */
function openWindowContext(
  input: RecoveryRequest,
): ItineraryContext | undefined {
  const window = input.openWindow;
  if (!window) return undefined;
  const endAt = new Date(window.availableUntil);
  if (Number.isNaN(endAt.getTime())) return undefined;

  const nextPlace = window.nextPlace;
  const nextPlaceArriveBy = nextPlace
    ? new Date(nextPlace.arriveBy)
    : undefined;
  const nextFixed: ItineraryNode | undefined =
    nextPlace && nextPlaceArriveBy && !Number.isNaN(nextPlaceArriveBy.getTime())
      ? {
          id: "open-window-next-place",
          sequence: 1,
          type: "other",
          title: nextPlace.label,
          startAt: nextPlaceArriveBy.toISOString(),
          locked: true,
          reservation: false,
          location: {
            latitude: nextPlace.latitude,
            longitude: nextPlace.longitude,
            label: nextPlace.label,
            areaCode: nextPlace.areaCode,
            sigunguCode: nextPlace.sigunguCode,
          },
        }
      : undefined;

  return {
    mode: "open_window",
    changeKind: "insert",
    title: "지금 비어 있는 시간",
    occurredAt: new Date(),
    disrupted: undefined,
    nextFixed,
    continuityNodes: nextFixed ? [nextFixed] : [],
    sortedNodes: nextFixed ? [nextFixed] : [],
    lockedNodeIds: nextFixed ? [nextFixed.id] : [],
    originalDurationMinutes: window.plannedStayMinutes,
    openWindow: {
      endAt,
      plannedStayMinutes: window.plannedStayMinutes,
      nextPlaceLabel: nextPlace?.label,
      nextPlaceArriveBy:
        nextPlaceArriveBy && !Number.isNaN(nextPlaceArriveBy.getTime())
          ? nextPlaceArriveBy
          : undefined,
    },
  };
}

function recoveryContext(
  input: RecoveryRequest,
): ItineraryContext | undefined {
  return input.openWindow
    ? openWindowContext(input)
    : itineraryContext(input);
}

function summariseItinerary(
  context: ItineraryContext | undefined,
): RecoveryResult["itinerarySummary"] {
  if (!context) return undefined;
  return {
    itineraryId: context.id,
    title: context.title,
    disruptedNodeId: context.disrupted?.id,
    nextFixedNodeId: context.nextFixed?.id,
    lockedNodeCount: context.lockedNodeIds.length,
  };
}

function summariseOpenWindow(
  context: ItineraryContext | undefined,
): RecoveryResult["openWindowSummary"] {
  const window = context?.openWindow;
  if (!context || !window) return undefined;
  return {
    windowEndAt: window.endAt.toISOString(),
    windowMinutes: Math.max(
      0,
      Math.floor(
        (window.endAt.getTime() - context.occurredAt.getTime()) / 60_000,
      ),
    ),
    plannedStayMinutes: window.plannedStayMinutes,
    nextPlaceLabel: window.nextPlaceLabel,
    nextPlaceArriveBy: window.nextPlaceArriveBy?.toISOString(),
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
  /* 같은 `supported_visit_category`에 84점을 일괄로 주면 박물관과 식당의
     총점이 88 대 86처럼 붙어서 사용자가 고를 근거가 사라진다. 유형별로
     벌린다. */
  const replacementTier = candidatePurpose(candidate.contentTypeId).tier;
  const categoryScore =
    replacementTier === "sightseeing"
      ? 92
      : replacementTier === "unknown"
        ? 80
        : replacementTier === "shopping"
          ? 70
          : 58;
  const purposeScore =
    candidate.purposePreservation.status === "verified_related_place"
      ? Math.max(76, 102 - (candidate.relatedRank ?? 1) * 1.2)
      : candidate.purposePreservation.status === "verified_activity_type"
        ? 96
        : categoryScore;
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
      : /* 빈 시간 추천에서 다음 장소를 알려 주지 않은 경우에는 지킬 약속이
           없으므로 연속성을 0으로 깎지 않는다. 대신 창 안에 남는 여유를
           같은 척도로 환산한다. 여유가 클수록 서두르지 않아도 된다. */
        candidate.scheduleDiff.openWindow
        ? Math.min(
            100,
            70 +
              Math.max(0, candidate.scheduleDiff.openWindow.leftoverMinutes),
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
    changeKind: "insert",
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

  const disrupted = context.disrupted;
  const changedNodeIds = disrupted ? [disrupted.id] : [];
  const unchangedNodeIds = context.sortedNodes
    .filter((node) => !changedNodeIds.includes(node.id))
    .map((node) => node.id);
  const preservedLockedNodeIds = context.lockedNodeIds.filter(
    (id) => !changedNodeIds.includes(id),
  );

  const openWindow = context.openWindow
    ? openWindowProof({
        context,
        windowStartAt: context.occurredAt,
        travelToMinutes: toCandidateMinutes,
        appliedStayMinutes: stayMinutes,
        arriveAt: startAt,
        leaveAt: endAt,
        route,
        nextFixedAppointment,
      })
    : undefined;

  const replacementNode = {
    id: `replacement-${candidate.contentId}`,
    title: candidate.title,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    durationMinutes: stayMinutes,
  };

  if (context.changeKind === "insert") {
    return {
      mode: context.mode,
      changeKind: "insert",
      replacementContentId: candidate.contentId,
      changedNodeIds: [],
      unchangedNodeIds,
      lockedNodeIds: context.lockedNodeIds,
      preservedLockedNodeIds,
      /* 끼워 넣기이므로 바뀐 일정은 0곳이다. 이 값을 1로 두면 증명서가
         있지도 않은 원래 일정을 바꿨다고 말하게 된다. */
      changedNodeCount: 0,
      nextFixedAppointmentPreserved:
        nextFixedAppointment?.status === "preserved"
          ? true
          : nextFixedAppointment
            ? false
            : undefined,
      arrivalTime: nextFixedAppointment?.estimatedArrivalAt,
      safetyBufferMinutes,
      note: nextFixedAppointment
        ? `비어 있는 시간에 한 곳을 더 넣고, 알려 주신 다음 장소 도착까지 실제 ${routeModeLabel(route.provider)} 경로로 검증했습니다.`
        : `비어 있는 시간에 한 곳을 더 넣고, 같은 ${routeModeLabel(route.provider)} 경로로 되돌아오는 시간까지 남은 시간 안에 들어가는지 검증했습니다.`,
      replacementNode,
      preservedWaypoints,
      nextFixedAppointment,
      openWindow,
    };
  }

  const disruptedIndex = disrupted
    ? context.sortedNodes.indexOf(disrupted)
    : -1;

  return {
    mode: context.mode,
    changeKind: "replace",
    replacedNodeId: disrupted?.id,
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
    originalNode: disrupted
      ? nodeSummary(disrupted, disruptedIndex)
      : undefined,
    replacementNode,
    preservedWaypoints,
    nextFixedAppointment,
  };
}

/* 창 안에 들어가는지의 계산을 한곳에 모은다. 다음 장소를 알려 준 경우에는 그
   도착 검증이 이미 끝났으므로 남는 여유를 그대로 쓰고, 알려 주지 않은 경우에는
   같은 보행 경로를 되짚어 오는 시간을 복귀로 잡는다. 왕복을 직선거리로
   추정하지 않고 실제 경로 구간을 재사용하는 것이 요점이다. */
function routeModeLabel(provider: WalkingRouteProvider): string {
  return provider === "tmap_car" ? "자동차" : "보행";
}

function openWindowProof(params: {
  context: ItineraryContext;
  windowStartAt: Date;
  travelToMinutes: number;
  appliedStayMinutes: number;
  arriveAt: Date;
  leaveAt: Date;
  route: Extract<WalkingRouteEvidence, { status: "routed" }>;
  nextFixedAppointment?: ScheduleDiff["nextFixedAppointment"];
}): OpenWindowProof | undefined {
  const window = params.context.openWindow;
  if (!window) return undefined;
  const windowMinutes = Math.max(
    0,
    Math.floor(
      (window.endAt.getTime() - params.windowStartAt.getTime()) / 60_000,
    ),
  );
  const returnMinutes = params.nextFixedAppointment
    ? (params.route.legs[1]?.durationMinutes ?? 0)
    : params.travelToMinutes;
  const returnBasis = params.nextFixedAppointment
    ? ("next_place_route" as const)
    : ("same_route_reversed" as const);
  const backAtMs = params.leaveAt.getTime() + returnMinutes * 60_000;
  const leftoverMinutes = Math.floor(
    (window.endAt.getTime() - backAtMs) / 60_000,
  );
  return {
    windowStartAt: params.windowStartAt.toISOString(),
    windowEndAt: window.endAt.toISOString(),
    windowMinutes,
    travelToMinutes: params.travelToMinutes,
    plannedStayMinutes: window.plannedStayMinutes,
    appliedStayMinutes: params.appliedStayMinutes,
    returnMinutes,
    returnBasis,
    leftoverMinutes,
    status: leftoverMinutes >= 0 ? "fits" : "at_risk",
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
    const route = await getRoute(routePoints, {
      signal,
      mode: input.travelMode,
    });
    if (
      route.status !== "routed" ||
      route.legs.length < routePoints.length - 1
    ) {
      rejected.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "ROUTE_UNAVAILABLE",
        reason:
          `대체 일정부터 복귀 지점까지 이어지는 전체 ${input.travelMode === "car" ? "자동차" : "보행"} 경로를 검증하지 못해 결과에서 제외했습니다.`,
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
    /* 빈 시간 추천에서 이동+체류+복귀가 창을 넘기는 후보. 체류를 줄이면
       들어가는 경우에는 그 최소 조정량을 반사실 근거로 남긴다. 30분 격자로만
       입력받으므로 조정 제안도 30분 단위로 내린다. */
    const windowProof = scheduleDiff.openWindow;
    if (windowProof && windowProof.status === "at_risk") {
      const shortfall = Math.abs(windowProof.leftoverMinutes);
      const reducedStay =
        Math.floor((windowProof.appliedStayMinutes - shortfall) / 30) * 30;
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "OPEN_WINDOW_OVERFLOW",
        reason:
          windowProof.returnBasis === "next_place_route"
            ? `다녀오면 다음 장소 도착이 ${shortfall}분 늦습니다.`
            : `다녀오면 남은 시간을 ${shortfall}분 넘깁니다.`,
        distanceMeters: routedDistance,
        changedNodeCount: 0,
        requiredRelaxation:
          reducedStay >= 30
            ? {
                constraint: "minimum_stay",
                amount: windowProof.appliedStayMinutes - reducedStay,
                unit: "minutes",
                currentLimit: windowProof.appliedStayMinutes,
                requiredLimit: reducedStay,
                description: `머무는 시간 ${windowProof.appliedStayMinutes}분 → ${reducedStay}분`,
                preservesLockedNodes: true,
                preservesNextFixedAppointment: true,
              }
            : undefined,
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
    objective: !context
      ? "minimize_travel_minutes_without_registered_itinerary"
      : context.changeKind === "insert"
        ? "maximize_fit_within_open_window"
        : "minimize_changed_nodes_then_travel_minutes",
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

/* 여행 목적 문장은 카드에 전용 블록(purpose-contract)이 따로 있다. 예전에는
   이 목록의 첫 항목으로도 넣어서 같은 문장이 카드마다 두 번 찍혔다.
   또한 영어 화면에서 이 목록만 한국어로 남았으므로 두 언어를 함께 만든다. */
function buildWhy(
  candidate: WorkingCandidate,
  input: RecoveryRequest,
): { ko: string[]; en: string[] } {
  const ko: string[] = [];
  const en: string[] = [];
  const push = (korean: string, english: string) => {
    ko.push(korean);
    en.push(english);
  };

  const meters = Math.round(candidate.distanceMeters);
  if (candidate.routeEvidence.status === "routed") {
    /* 어느 경로 공급자로 계산했는지 문장에 그대로 쓴다. 공급자 이름을
       고정해 두면 TMAP으로 계산한 결과에도 OpenStreetMap이라고 적힌다. */
    const routeSource =
      candidate.routeEvidence.provider === "tmap_pedestrian"
        ? { ko: "TMAP 보행자 경로", en: "TMAP pedestrian routing" }
        : candidate.routeEvidence.provider === "tmap_car"
          ? { ko: "TMAP 자동차 경로", en: "TMAP car routing" }
          : { ko: "OpenStreetMap 보행 경로", en: "OpenStreetMap walking route" };
    /* 수단도 문장에 드러나야 한다. 자차로 계산한 20분을 "보행 경로로 20분"이라고
       적으면 여행자가 걸어서 갈 수 있다고 읽는다. */
    const byCar = candidate.routeEvidence.provider === "tmap_car";
    push(
      `실제 ${byCar ? "자동차" : "보행"} 경로로 ${meters.toLocaleString("ko-KR")}m, 약 ${candidate.estimatedTravelMinutes}분입니다. (${routeSource.ko})`,
      `${meters.toLocaleString("en-US")} m on a real ${byCar ? "driving" : "walking"} route, about ${candidate.estimatedTravelMinutes} min (${routeSource.en}).`,
    );
    if (byCar && typeof candidate.routeEvidence.taxiFareKrw === "number") {
      push(
        `TMAP 예상 택시요금 ${candidate.routeEvidence.taxiFareKrw.toLocaleString("ko-KR")}원입니다. 자차 유류비·주차비는 포함하지 않습니다.`,
        `TMAP estimates a ${candidate.routeEvidence.taxiFareKrw.toLocaleString("en-US")} KRW taxi fare. Fuel and parking for your own car are not included.`,
      );
    }
  } else {
    push(
      `한국관광공사 좌표 기준 직선거리 ${meters.toLocaleString("ko-KR")}m입니다.`,
      `${meters.toLocaleString("en-US")} m in a straight line from the official coordinates.`,
    );
  }

  const appointment = candidate.scheduleDiff.nextFixedAppointment;
  if (appointment?.status === "preserved") {
    push(
      `다음 예약 '${appointment.title}'에 ${appointment.arrivalBufferMinutes}분 여유를 두고 도착합니다.`,
      `You arrive at '${appointment.title}' with ${appointment.arrivalBufferMinutes} min to spare.`,
    );
  }
  if (candidate.scheduleDiff.changedNodeCount === 1) {
    const original =
      candidate.scheduleDiff.originalNode?.title ?? "틀어진 일정";
    push(
      `'${original}' 한 곳만 바꾸고 나머지 일정은 그대로 둡니다.`,
      `Only '${original}' changes. Every other stop stays as it was.`,
    );
  }
  if (candidate.availability.status === "confirmed_open") {
    push(
      "도착 시각에 문을 여는지 한국관광공사 공식 운영정보로 확인했습니다.",
      "Official operating data confirms it is open at your arrival time.",
    );
  } else if (candidate.availability.status === "official_hours_unstructured") {
    push(
      "공식 운영시간은 있지만 자동으로 읽을 수 없어 출발 전 확인이 필요합니다.",
      "Official hours exist but cannot be parsed, so confirm before you set out.",
    );
  }
  if (candidate.indoor && (input.incident === "rain" || input.indoorOnly)) {
    push(
      "한국관광공사 콘텐츠 유형상 실내에서 지낼 수 있는 곳입니다.",
      "The official content type indicates you can stay indoors here.",
    );
  }
  if (candidate.accessibility.status === "verified") {
    push(
      "요청한 이동 조건에 맞는 편의정보를 무장애여행정보에서 확인했습니다.",
      "Barrier-free data confirms the facilities you asked for.",
    );
  }
  if (candidate.crowdRate !== undefined) {
    push(
      `집중률 예측 ${candidate.crowdRate.toFixed(2)}/100입니다. 현장 실시간 인원수는 아닙니다.`,
      `Concentration forecast ${candidate.crowdRate.toFixed(2)}/100 — a forecast, not a live headcount.`,
    );
  }
  if (candidate.relatedRank !== undefined) {
    push(
      `원래 일정과 함께 방문된 순위 ${candidate.relatedRank}위 기록이 있습니다.`,
      `Ranked #${candidate.relatedRank} among places visited together with your original stop.`,
    );
  }
  return { ko, en };
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
    /* 응답이 말한 제공자를 그대로 적는다. 고정 문자열이었을 때 TMAP으로 계산한
       결과에도 OpenStreetMap이라고 적혔다. */
    const routeProvider = candidate.routeEvidence.provider;
    contributions.push({
      source:
        routeProvider === "tmap_pedestrian"
          ? "TMAP 보행자 경로안내"
          : routeProvider === "tmap_car"
            ? "TMAP 자동차 경로안내"
            : "OpenStreetMap Routing",
      fields: ["distance", "duration", "legs", "geometry"],
      decision: `현재 위치→대체 일정→다음 고정 일정의 실제 ${routeModeLabel(routeProvider)} 경로와 도착 버퍼를 계산했습니다.`,
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
      /* 기상청으로 조회한 결과에 Open-Meteo라고 적으면, 국내 공식 기상자료를
         썼다는 주장과 원장이 서로 반대되는 말을 한다. */
      source:
        weather.provider === "kma_short_term"
          ? "기상청 단기예보"
          : "Open-Meteo",
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
  strategyLabel: { ko: string; en: string },
  requestId: string,
  input: RecoveryRequest,
): RecoveryOption {
  return {
    id: `${requestId}-${strategy}-${candidate.contentId}`,
    strategy,
    strategyLabel: strategyLabel.ko,
    /* 영어 화면에서 전략 배지가 한국어로 남지 않도록 두 벌을 함께 보낸다. */
    strategyLabelEn: strategyLabel.en,
    /* Travels with the option so the traveller is told which conditions were
       not confirmed. An option with gaps is a suggestion to check, never a
       verified result. */
    evidenceGaps: candidate.evidenceGaps,
    /* 활동 유형이 바뀐 후보도 확인 대상이다. 관광·체험을 하려던 사람에게
       식사나 쇼핑을 제안하는 것은 정당한 선택지이지만, 바뀐 것을 알리지
       않고 그대로 적용 가능으로 내보내면 화면은 "관광 → 식사"라고 쓰면서
       확인 없이 적용을 권하는 셈이 된다. 배포본 8건 측정에서 실제로 그런
       후보가 나왔다. 근거 공백과 같은 등급으로 확인을 요구한다. */
    confirmationRequired:
      candidate.evidenceGaps.length > 0 ||
      candidate.purposePreservation.status === "changed_visit_category",
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
            note: "한국관광공사 콘텐츠 유형으로 실내 여부를 판단했습니다. 건물 안 동선은 방문 전에 확인해 주세요.",
            noteEn:
              "Indoor fit is inferred from the official content type. Check the route inside the building before you go.",
          }
        : {
            status: "not_required",
            note: "이번 요청은 실내 여부를 필수 조건으로 쓰지 않았습니다.",
            noteEn: "This request did not require an indoor place.",
          },
    accessibility: candidate.accessibility,
    crowd:
      candidate.crowdRate === undefined
        ? {
            status: "unavailable",
            note: "이 곳과 정확히 일치하는 집중률 예측을 찾지 못했습니다.",
            noteEn:
              "No visitor-concentration forecast matched this place exactly.",
          }
        : {
            status: "available",
            relativeRate: candidate.crowdRate,
            baseDate: candidate.crowdBaseDate,
            note: "앞으로의 집중률 예측값입니다. 현장 실시간 인원수가 아닙니다.",
            noteEn:
              "A forward-looking concentration forecast, not a live headcount.",
          },
    relatedRank: candidate.relatedRank,
    purposePreservation: candidate.purposePreservation,
    ...(() => {
      const reasons = buildWhy(candidate, input);
      return { why: reasons.ko, whyEn: reasons.en };
    })(),
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

  /* 활동 유형이 바뀐 후보는 마지막 수단이다. 점수에서 관광 콘텐츠를 앞세우고
     있지만 목적 점수는 총점의 18%뿐이라, 가까운 식당이 먼 박물관을 제치고
     첫 카드가 되는 일이 실제로 있었다. `minimum_change` 정렬은 이동시간과
     변경 일정 수만 보므로 목적을 아예 고려하지 않는다.

     그래서 순위가 아니라 후보 풀에서 가른다. 목적을 지키는 후보가 하나라도
     있으면 그 안에서만 고르고, 하나도 없을 때에만 바뀐 후보를 제시한다.
     "박물관이 있는데 간장게장이 올라오는 일"이 점수 배분과 무관하게
     사라지고, 대안이 0개가 되는 일도 없다. 두 시간 공백을 식사로 채우는
     것은 여전히 유효한 선택지이며, 그때는 바뀐 사실을 확인받는다. */
  const purposePreserving = candidates.filter(
    (candidate) =>
      candidate.purposePreservation.status !== "changed_visit_category",
  );
  const pool = purposePreserving.length ? purposePreserving : candidates;

  const selected: Array<{
    candidate: WorkingCandidate;
    strategy: RecoveryOption["strategy"];
    label: { ko: string; en: string };
  }> = [];
  const used = new Set<string>();

  /* 세 카드는 서로 다른 이유로 뽑혀야 한다. 예전 구현은 각 정렬의 1위만
     보고, 이미 쓴 후보면 그 전략을 통째로 건너뛰었다. 대체로 같은 후보가
     세 정렬에서 모두 1위였기 때문에 2·3번 카드가 "추가 검증 대안"이라는
     같은 이름으로 채워졌고, 사용자는 무엇이 다른지 알 수 없었다.
     여기서는 각 정렬에서 아직 쓰지 않은 첫 후보를 고른다. */
  const addFirstUnused = (
    sorted: WorkingCandidate[],
    strategy: RecoveryOption["strategy"],
    label: { ko: string; en: string },
  ) => {
    const candidate = sorted.find((entry) => !used.has(entry.contentId));
    if (!candidate) return;
    used.add(candidate.contentId);
    selected.push({ candidate, strategy, label });
  };

  const travelMinutes = (candidate: WorkingCandidate) =>
    candidate.routeEvidence.status === "routed"
      ? candidate.routeEvidence.durationMinutes
      : candidate.estimatedTravelMinutes;

  addFirstUnused(
    [...pool].sort((a, b) => {
      const changed =
        a.scheduleDiff.changedNodeCount - b.scheduleDiff.changedNodeCount;
      if (changed) return changed;
      return travelMinutes(a) - travelMinutes(b) || b.baseScore - a.baseScore;
    }),
    "minimum_change",
    input.itinerary
      ? { ko: "예약을 지키는 가장 가까운 곳", en: "Closest place that keeps your booking" }
      : { ko: "지금 바로 갈 수 있는 가장 가까운 곳", en: "Closest place you can reach now" },
  );

  /* 두 번째 카드는 상황별로 사용자가 실제로 궁금해하는 축을 쓴다. */
  if (input.incident === "crowd") {
    addFirstUnused(
      [...pool].sort((a, b) => {
        const aRate = a.crowdRate ?? 101;
        const bRate = b.crowdRate ?? 101;
        return aRate - bRate || b.baseScore - a.baseScore;
      }),
      "comfortable",
      { ko: "덜 붐빌 것으로 예측된 곳", en: "Forecast to be less crowded" },
    );
  } else {
    addFirstUnused(
      [...pool].sort(
        (a, b) => b.comfortScore - a.comfortScore || b.baseScore - a.baseScore,
      ),
      "comfortable",
      input.audience === "general"
        ? { ko: "이동 부담이 가장 적은 곳", en: "Least walking and transfers" }
        : { ko: "이동 편의 조건이 가장 잘 맞는 곳", en: "Best match for your mobility need" },
    );
  }

  /* 세 번째 카드는 기획의 `지역 발견`이다. 연계 방문 데이터가 있으면
     그 근거로, 없으면 여유 시간이 가장 넉넉한 후보로 채운다. 어느 쪽이든
     라벨이 이유를 말한다. */
  const relatedFirst = [...pool]
    .filter((entry) => entry.relatedRank !== undefined)
    .sort(
      (a, b) => (a.relatedRank ?? 999) - (b.relatedRank ?? 999) ||
        b.baseScore - a.baseScore,
    );
  if (relatedFirst.some((entry) => !used.has(entry.contentId))) {
    addFirstUnused(
      relatedFirst,
      "local_discovery",
      { ko: "함께 방문이 많은 인근 관광지", en: "Often visited together with your stop" },
    );
  } else {
    addFirstUnused(
      [...pool].sort((a, b) => {
        const aBuffer =
          a.scheduleDiff.nextFixedAppointment?.arrivalBufferMinutes ?? -1;
        const bBuffer =
          b.scheduleDiff.nextFixedAppointment?.arrivalBufferMinutes ?? -1;
        return bBuffer - aBuffer || b.baseScore - a.baseScore;
      }),
      "local_discovery",
      { ko: "약속까지 여유가 가장 많은 곳", en: "Most spare time before your booking" },
    );
  }

  /* 위 세 축이 같은 후보로 겹쳐 자리가 남는 경우에만 총점 순으로 채운다.
     이때도 "추가 검증 대안" 같은 무의미한 이름을 쓰지 않고, 그 후보가
     상대적으로 나은 점을 라벨에 적는다. */
  for (const candidate of [...pool].sort(
    (a, b) => b.baseScore - a.baseScore,
  )) {
    if (selected.length >= 3) break;
    if (used.has(candidate.contentId)) continue;
    used.add(candidate.contentId);
    const tier = candidatePurpose(candidate.contentTypeId).tier;
    selected.push({
      candidate,
      strategy: "local_discovery",
      label:
        tier === "sightseeing"
          ? {
              ko: "조건을 통과한 다른 관광 콘텐츠",
              en: "Another attraction that passed every condition",
            }
          : tier === "meal"
            ? {
                ko: "시간을 채울 수 있는 식사 장소",
                en: "A place to eat while you wait",
              }
            : tier === "shopping"
              ? {
                  ko: "실내에서 머물 수 있는 쇼핑 장소",
                  en: "An indoor shopping stop",
                }
              : {
                  ko: "조건을 통과한 다른 곳",
                  en: "Another place that passed every condition",
                },
    });
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
  const context = recoveryContext(input);
  const recoveryMode: RecoveryMode =
    context?.mode ?? "proximity_fallback";
  const warnings = context
    ? [
        "운영정보와 경로는 호출 시점의 공식·공개 데이터를 기준으로 검증합니다. 예약 자체와 현장 안전을 보증하지 않으므로 출발 직전 운영기관 안내를 확인하세요.",
        ...(context.changeKind === "insert"
          ? [
              context.openWindow?.nextPlaceLabel
                ? `지금 비어 있는 시간에 한 곳을 더 넣는 추천입니다. 알려 주신 다음 장소 도착까지 실제 ${input.travelMode === "car" ? "자동차" : "보행"} 경로로 검증했습니다.`
                : `지금 비어 있는 시간에 한 곳을 더 넣는 추천입니다. 다음 장소를 알려 주지 않으셨으므로 같은 ${input.travelMode === "car" ? "자동차" : "보행"} 경로로 되돌아오는 시간을 복귀로 계산했으며, 목적 유지 여부는 판단하지 않았습니다.`,
            ]
          : []),
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
      itinerarySummary: summariseItinerary(context),
      openWindowSummary: summariseOpenWindow(context),
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
      ? /* 기준월은 어댑터가 정한다. 여기서 직전 달을 못박으면 아직 발행되지
           않은 달로 고정되어, 어댑터의 하강 폴백이 "호출자가 지정한 달"로
           읽고 그 달만 조회한다. 실제로 그래서 연관 관광지가 계속 0건이었다. */
        getRelatedTourism(
          { regionCode, districtCode },
          { signal: execution.signal, timeoutMs: 4_000, retry: false },
        )
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

  /* 연관 관광지의 기준점. 일정 복구는 문제가 생긴 장소를 기준으로 삼고, 빈 시간
     추천은 알려 준 다음 장소를 기준으로 삼는다. 다음 장소도 없으면 기준점이
     없으므로 연관 순위를 계산하지 않는다. */
  const relatedAnchorTitle =
    context?.disrupted?.title ??
    context?.openWindow?.nextPlaceLabel ??
    (context?.changeKind === "insert" ? undefined : input.origin.label);
  const relatedRanks = relatedAnchorTitle
    ? relatedRankByTitle(relatedItems, relatedAnchorTitle)
    : new Map<string, number>();
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
    const latitude = numberInRange(item.mapy, 32, 39.8);
    const longitude = numberInRange(item.mapx, 124, 132);
    if (!contentId || latitude === undefined || longitude === undefined) {
      rejected.push({
        contentId: contentId || undefined,
        title,
        reasonCode: "INVALID_COORDINATE",
        reason: "공식 위치 좌표를 확인하지 못했습니다.",
      });
      continue;
    }

    /* 일정 복구에서는 문제가 생긴 장소를, 빈 시간 추천에서는 알려 준 다음
       장소를 후보에서 뺀다. 지금 가려는 곳을 "지금 대신 갈 곳"으로 다시
       제시하면 안 된다. */
    const excludedTitle =
      context?.disrupted?.title ?? context?.openWindow?.nextPlaceLabel;
    if (
      excludedTitle &&
      normalizeName(title) === normalizeName(excludedTitle)
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "SAME_AS_DISRUPTED_PLACE",
        reason: context?.disrupted
          ? "문제가 생긴 원래 장소와 같은 장소이므로 대체 일정에서 제외했습니다."
          : "이미 가려고 하는 다음 장소와 같은 곳이므로 제외했습니다.",
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

    const apiDistance = numberInRange(item.dist, 0, 100_000);
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

    /* 사전 걸러내기의 보수 추정. 자차는 직선거리를 도보 속도로 환산하면
       실제로 10분이면 닿는 후보가 "가용시간 초과"로 떨어진다. 수단별 속도로
       나눈다. 이 값은 걸러내기 전용이고, 살아남은 후보의 이동시간은 아래에서
       실제 경로로 다시 계산해 덮어쓴다. */
    const estimatedTravelMinutes =
      input.travelMode === "car"
        ? conservativeDrivingMinutes(distanceMeters)
        : conservativeWalkingMinutes(distanceMeters);
    if (
      estimatedTravelMinutes > input.availableMinutes &&
      (!context ||
        estimatedTravelMinutes > input.availableMinutes + 30)
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "TIME_LIMIT",
        reason: `${input.travelMode === "car" ? "자동차" : "보행"} 보수 추정 이동시간이 가용시간 ${input.availableMinutes}분을 초과합니다.`,
        distanceMeters,
      });
      continue;
    }

    /* Rain/indoor is a safety-critical hard constraint. A candidate whose
       official content classification does not support indoor use is rejected
       rather than offered with a caveat. Accessibility and crowd coverage can
       remain partial, but those gaps stay explicit and force the overall
       response out of the verified state below. */
    const indoor = hasVerifiedIndoorEvidence(item);
    if (indoorRequired && !indoor) {
      rejected.push({
        contentId,
        title,
        reasonCode: "INDOOR_UNVERIFIED",
        reason:
          "공식 관광 콘텐츠 분류에서 실내 이용 가능성을 확인할 수 없어 실내 필수 후보에서 제외했습니다.",
        distanceMeters,
      });
      continue;
    }
    const evidenceGaps: EvidenceGap[] = [];

    if (input.audience !== "general" && !accessibleIds.has(contentId)) {
      evidenceGaps.push({
        code: "ACCESSIBILITY_UNVERIFIED",
        note: "무장애여행정보 목록에서 이 곳을 찾지 못했습니다.",
        noteEn: "This place is not in the barrier-free travel dataset.",
      });
    }

    const forecast = forecasts.get(normalizeName(title));
    if (input.incident === "crowd" && !forecast) {
      evidenceGaps.push({
        code: "CONCENTRATION_UNVERIFIED",
        note: "이 곳의 집중률 예측을 확인하지 못했습니다.",
        noteEn: "No concentration forecast is available for this place.",
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
              noteEn: candidate.accessibility.noteEn,
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
      option.confirmationRequired ||
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
    itinerarySummary: summariseItinerary(context),
    openWindowSummary: summariseOpenWindow(context),
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
