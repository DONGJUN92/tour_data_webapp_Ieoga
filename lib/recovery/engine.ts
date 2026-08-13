import {
  CONCENTRATION_PAGE_SIZE,
  KTO_CANDIDATE_PAGE_SIZE,
  KTO_CANDIDATE_RADIUS_METERS,
  getAccessibilityDetail,
  getConcentrationForecast,
  getNearbyAccessibleTourism,
  getNearbyTourism,
  getRelatedTourism,
  normalizeAnalysisCodes,
} from "@/lib/kto/adapters";
import { ktoTourismCategory } from "@/lib/kto/category";
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
  conservativeCyclingMinutes,
  conservativeDrivingMinutes,
  conservativeTransitMinutes,
  conservativeWalkingMinutes,
  haversineMeters,
} from "@/lib/geo";
import {
  getRoute,
  type WalkingRouteEvidence,
  type WalkingRouteProvider,
} from "@/lib/mobility/routing";
import { toKmaGrid } from "@/lib/weather/kma";
import { getWeatherEvidence } from "@/lib/weather/service";
import {
  outdoorTemperatureStrain,
  summariseStayWeather,
  weatherGlance,
  type StayWeather,
  type WeatherGlanceSlot,
} from "@/lib/weather/window";
import { withParticle } from "@/lib/text/korean";
import { strictFiniteNumber } from "@/lib/validation/numbers";
import type { RecoveryRequest } from "./schema";
import { recoveryReferenceTime } from "./reference-time";
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
  RejectionReasonCode,
  ScheduleDiff,
  ScheduleNodeSummary,
  TravelPurposeProof,
} from "./types";

export const RECOVERY_RULE_VERSION = "2026.08-continuity-v3";
/* Provider and latency guardrails, not traveller distance preferences.
   `locationBasedList2` itself caps radius at 20 km. We scan more pages while
   enough of the request's 20-second budget remains, then verify in small
   batches so failed candidates can be replaced without an unbounded burst. */
const CANDIDATE_DISCOVERY_MAX_PAGES = 4;
const CANDIDATE_EXPANSION_TIMEOUT_MS = 2_500;
const CANDIDATE_DISCOVERY_RESERVE_MS = 10_000;
const CONTINUITY_RESULT_LIMIT = 12;
const CONTINUITY_VERIFICATION_HARD_LIMIT = 18;
const CONTINUITY_VERIFICATION_BATCH_SIZE = 3;
const CONTINUITY_VERIFICATION_RESERVE_MS = 2_500;
const ACCESSIBILITY_DETAIL_RESERVE_MS = 8_000;

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
  /* 오늘 값이 그 장소 자신의 30일 분포에서 몇 번째 백분위인가. 장소 간 절대값
     비교와 달리 단위 정의에 의존하지 않는다. */
  crowdPercentile?: number;
  crowdSeriesDays?: number;
  /* 이 값이 **이 장소 자신의 것**인지, 주변 장소에서 빌려 온 것인지. 빌려 온
     값을 직접 측정한 값과 같은 얼굴로 보여 주면 근거를 부풀리는 것이다. */
  crowdBasis?: "place" | "nearby" | "district";
  crowdNeighborCount?: number;
  crowdNeighborMeters?: number;
  /* 이 후보에 **머무는 시간대**의 날씨. 출발지의 지금 하늘이 아니다. */
  stayWeather?: StayWeather;
  /* 이 후보 지점의 시점별 날씨(지금·1시간 후·2시간 후). 순위에는 쓰지 않고
     화면에서 지정 여행지와 나란히 비교하는 용도다. */
  weatherGlance?: WeatherGlanceSlot[];
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

function candidateDiscoveryKey(item: KtoItem): string {
  const contentId = stringValue(item.contentid);
  if (contentId) return `content:${contentId}`;
  /* Invalid records are rejected later, but a bad record repeated on several
     pages must not inflate work or rejection counts. */
  return [
    "fallback",
    stringValue(item.contenttypeid),
    normalizeName(stringValue(item.title)),
    stringValue(item.mapx),
    stringValue(item.mapy),
  ].join(":");
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
  const legacyCategoryCode = stringValue(item.cat3).toUpperCase();
  const officialLevel2Code = stringValue(item.lclsSystm2).toUpperCase();
  const officialLevel3Code = stringValue(item.lclsSystm3).toUpperCase();
  /* 신분류의 공원/자연휴양 분류는 이름과 콘텐츠 유형보다 우선한다. 반대로
     VE07 전시·문화시설은 공식 분류 자체가 실내 근거다. */
  if (["VE02", "VE03", "NA04"].includes(officialLevel2Code)) return false;
  if (
    officialLevel2Code === "VE07" ||
    officialLevel3Code.startsWith("VE07")
  ) {
    return true;
  }

  const explicitOutdoor =
    /공원|산책로|둘레길|트레킹|해변|해수욕장|광장|정원|수목원|숲|산\b|계곡|폭포|캠핑|야영|전망대|유적|고궁|궁궐|성곽|섬|항구|시장/i.test(
      `${title} ${stringValue(item.cat1)} ${stringValue(item.cat2)}`,
    );
  if (explicitOutdoor) return false;
  if (VERIFIED_INDOOR_CATEGORY_CODES.has(legacyCategoryCode)) return true;

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
  /* `단차 없음`·`턱 없음`·`장애물 없음`은 장애물이 **없다**는 뜻이므로 무장애
     여행자에게는 가장 강한 긍정 진술이다. `없음`이라는 글자만 보고 부정으로
     처리하면 동선을 가장 정확하게 적어 둔 기록이 버려지고, 대신 `대여 가능`처럼
     동선과 무관한 한 줄이 등급을 올린다 — 운영시간 판정에서 겪은 역선택과 같은
     형태다. 부정 판정 전에 이 표현을 걷어낸다. */
  const withoutBarrierAbsence = value.replace(
    /(?:단차|문턱|턱|계단|장애물|경사)\s*(?:이|가)?\s*없(?:음|다|이|어|습니다)/gu,
    " ",
  );
  return !/(없음|불가|미제공|해당\s*없음|미확인|확인\s*불가|not available|none)/i.test(
    withoutBarrierAbsence,
  );
}

/* 무장애 필드의 값이 "빌려준다"만 말하는가.
 *
 * `wheelchair` 필드는 동선 정보일 때도 있고 대여 정보일 때도 있다. 부정 키워드가
 * 없다는 것만 확인하면 `'대여가능(동백섬 내 누리마루)'`이 "내부 이동 확인"으로
 * 승격되고, 그 한 줄로 야외 해안 산책로가 등급 A·자동 적용 가능이 됐다. 가상
 * 페르소나 조사에서 실제로 그랬고, 기획 14.2의 `정보 없는 후보의 오인 통과 0건`의
 * 반례 1호였다.
 *
 * 휠체어를 직접 가져오는 이용자에게 "대여 1대 있음"은 동선 근거가 아니다. 대여
 * 이야기만 있으면 필수 항목을 충족시키지 않고 보조 정보로만 남긴다. 정보를 버리는
 * 것이 아니라 등급을 올리는 근거로 쓰지 않는 것이다. */
function rentalOnlyAccessibility(value: string): boolean {
  if (!value) return false;
  const mentionsRental = /(대여|렌탈|렌털|보유|rental|rent)/i.test(value);
  if (!mentionsRental) return false;
  /* 같은 문장에 동선 표현이 함께 있으면 동선 근거로 인정한다. */
  const mentionsMobility =
    /(이동|통행|접근|진입|경사|단차|턱\s*없|평탄|엘리베이터|승강기|리프트|ramp|accessible|step[-\s]?free)/i.test(
      value,
    );
  return !mentionsMobility;
}

function accessibilityFields(
  audience: RecoveryRequest["audience"],
): string[] {
  /* `assisted`는 유아차·휠체어·고령자를 하나로 합친 값이다.
     셋을 따로 두었지만 실제 판정은 갈리지 않았다 — 휠체어와 고령자는 조회
     필드도 필수 항목도 **완전히 같았고**, 유아차만 `stroller` 필드를 따로
     봤다. 고르는 사람에게는 세 갈래인데 결과는 두 갈래였으니, 그 선택은
     대부분 아무 일도 하지 않으면서 입력 부담만 늘렸다.

     합치면서 확인 대상은 셋의 합집합으로 둔다. 좁히는 것이 아니라 넓히는
     방향이다 — 유아차 이용자도 엘리베이터가 확인되면 내부 이동을 인정받고,
     휠체어 이용자도 유아차 통행 기록이 있으면 근거로 쓴다. */
  if (audience === "assisted") {
    return [
      "stroller",
      "wheelchair",
      "elevator",
      "exit",
      "restroom",
      "parking",
      "lactationroom",
      "babysparechair",
    ];
  }
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
  const requiredGroups =
    audience === "assisted"
      ? [
          { label: "출입 동선", fields: ["exit"] },
          {
            /* 유아차·휠체어·보행보조 중 무엇이든 안에서 다닐 수 있다는
               근거가 하나라도 있으면 인정한다. */
            label: "내부 이동",
            fields: ["elevator", "wheelchair", "stroller"],
          },
        ]
      : audience === "stroller"
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
  /* 필수 항목을 충족시킬 수 있는 필드에서 대여 전용 값을 뺀다. `elevator`는
     설비 자체를 말하므로 그대로 두고, `wheelchair`처럼 대여로도 쓰이는 필드만
     걸러진다. */
  const confirmedForRequired = new Set(
    allFields
      .filter((entry) => !rentalOnlyAccessibility(entry.value))
      .map((entry) => entry.field),
  );
  const requiredChecks = requiredGroups.map((group) => ({
    label: group.label,
    status: group.fields.some((field) => confirmedForRequired.has(field))
      ? ("confirmed" as const)
      : ("missing" as const),
    fields: group.fields,
  }));
  const confirmedRequiredCount = requiredChecks.filter(
    (check) => check.status === "confirmed",
  ).length;
  const supplementalFieldNames =
    audience === "assisted"
      ? ["lactationroom", "babysparechair", "restroom", "parking"]
      : audience === "stroller"
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
  reason?: string,
): KtoAudit {
  return {
    apiName: service,
    operation,
    status: "not_required",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: [],
    ...(reason ? { errorCode: reason } : {}),
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

function operatingStatusRejection(params: {
  candidate: Pick<
    WorkingCandidate,
    "contentId" | "title" | "distanceMeters"
  >;
  availability: PublicAvailabilityEvidence;
  lookupFailed: boolean;
  changedNodeCount: number;
}): RejectedCandidate | undefined {
  if (params.availability.status === "confirmed_open") return undefined;
  const reasonCode: RejectionReasonCode =
    params.availability.status === "confirmed_closed"
      ? "OFFICIALLY_CLOSED"
      : params.lookupFailed
        ? "OPERATING_STATUS_UPSTREAM_UNAVAILABLE"
        : "OPERATING_STATUS_UNCONFIRMED";
  const reason =
    reasonCode === "OFFICIALLY_CLOSED"
      ? "공식 운영정보상 제안된 방문 구간에 운영하지 않아 제외했습니다."
      : reasonCode === "OPERATING_STATUS_UPSTREAM_UNAVAILABLE"
        ? "공식 운영정보 제공자에 연결하지 못해 방문 가능 여부를 검증할 수 없어 제외했습니다. 잠시 후 다시 시도할 수 있습니다."
        : "공식 응답은 받았지만 제안된 체류 구간 전체가 운영 중임을 확인할 수 없어 제외했습니다.";
  return {
    contentId: params.candidate.contentId,
    title: params.candidate.title,
    reasonCode,
    reason,
    distanceMeters: params.candidate.distanceMeters,
    changedNodeCount: params.changedNodeCount,
    verificationDepth: "route_verified",
  };
}

/* 집중률 예측의 오늘 값과, 그 값이 **그 장소 자신의 최근 분포에서 어디인지.**
 *
 * 이 API는 시군구당 관광지 x 30일 시계열을 준다. 예전에는 오늘 하루치만 쓰고
 * 29일치를 버렸다. 서울 종로 113곳 x 30일을 실측해 분산을 나눠 보면 장소 간
 * 변동 13.49, 장소 내 변동 13.28로 **거의 같다.** 즉 버린 29일치에 값의 절반이
 * 들어 있었다 — 같은 60점이 그 장소의 평소보다 유난히 붐비는 날일 수도, 유난히
 * 한적한 날일 수도 있다.
 *
 * 백분위는 단위 정의에 의존하지 않으므로 절대값과 함께 쓸 수 있다. 시간 단위
 * 값은 이 API에 없으므로 "지금 붐빔이 오르고 있다"는 판정은 하지 않는다. */
function currentForecastByTitle(
  items: KtoItem[],
  referenceAt = new Date(),
): Map<
  string,
  {
    rate: number;
    baseDate: string;
    /* 0~100. 오늘 값이 30일 분포에서 몇 번째 백분위인가. */
    percentileOfSeries?: number;
    seriesDays?: number;
    seriesMin?: number;
    seriesMax?: number;
  }
> {
  const koreaDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceAt);
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

  const selected = new Map<
    string,
    {
      rate: number;
      baseDate: string;
      percentileOfSeries?: number;
      seriesDays?: number;
      seriesMin?: number;
      seriesMax?: number;
    }
  >();
  for (const [name, values] of grouped) {
    values.sort((a, b) => a.baseDate.localeCompare(b.baseDate));
    const chosen =
      values.find((value) => value.baseDate >= today) ??
      values[values.length - 1];
    /* 하루치만 온 장소는 분포가 없다. 그때 백분위를 0이나 100으로 적으면
       없는 근거를 만들어 내는 것이므로 비워 둔다. */
    if (values.length < 7) {
      selected.set(name, chosen);
      continue;
    }
    const rates = values.map((value) => value.rate);
    const atOrBelow = rates.filter((rate) => rate <= chosen.rate).length;
    selected.set(name, {
      ...chosen,
      percentileOfSeries: Math.round((atOrBelow / rates.length) * 100),
      seriesDays: rates.length,
      seriesMin: Math.min(...rates),
      seriesMax: Math.max(...rates),
    });
  }
  return selected;
}

/* 혼잡을 피하려는 사용자에게 줄 수 있는 점수. 높을수록 덜 붐빈다.
 *
 * 이 지표가 무엇인지 실측으로 확인한 것과 확인하지 못한 것을 나눠 둔다.
 *
 * 확인한 것 (서울 종로 113곳 x 30일):
 * - 장소 간 변동(각 장소 30일 평균의 표준편차) 13.49, 장소 내 변동(각 장소
 *   30일 표준편차의 평균) 13.28. **비율 1.02로 두 성분이 거의 같다.** 즉 값은
 *   절반은 그 장소의 성격이고 절반은 그날의 사정이다. 어느 한쪽으로만 읽으면
 *   절반을 버린다.
 * - 장소 평균은 실제 유동인구를 따르지 않는다. 청와대 37.1이 경운동민병옥가옥
 *   81.5보다 낮다. 따라서 이 값을 "사람 수"로 읽으면 안 된다. 좁은 한옥이
 *   적은 인원으로도 포화될 수 있다는 뜻의 **포화도**에 가깝다.
 * - 값은 일 단위다. 시간 단위가 없으므로 "지금 붐빔이 오르는 중"은 판정하지
 *   않는다.
 *
 * 확인하지 못한 것: 공식 필드 정의. 그래서 어느 쪽도 단정하지 않고 두 성분을
 * 모두 쓴다. 절대값을 주 축으로 두되(포화도로서 여행객의 체감에 가깝다),
 * 그 장소 자신의 최근 분포에서 유난히 높거나 낮은 날은 양 끝에서만 보정한다.
 * 보정 폭을 작게 두는 이유는 어느 해석도 확정되지 않았기 때문이다.
 *
 * 점수와 정렬과 라벨이 이 함수 하나를 쓴다. 따로 적어 두면 갈라진다. 실제로
 * 갈려서 집중률 63.77 후보에 "덜 붐빌 것으로 예측된 곳" 라벨이 붙고 그 위
 * 카드가 14.01이었다. */
function crowdComfortScore(candidate: {
  crowdRate?: number;
  crowdPercentile?: number;
  crowdBasis?: "place" | "nearby" | "district";
}): number {
  if (candidate.crowdRate === undefined) return 50;
  /* 단조 감소로 바꿨다. 예전에는 60·80을 경계로 한 3단 계단이어서 61과 79가
     같은 점수를 받았다. 이제 후보 대부분이 값을 받으므로 그 손실을 감출
     이유가 없다. */
  let score = 100 - candidate.crowdRate * 0.8;
  if (candidate.crowdPercentile !== undefined) {
    if (candidate.crowdPercentile >= 85) score -= 12;
    else if (candidate.crowdPercentile <= 15) score += 8;
  }
  /* 주변에서 빌려 온 값은 중립 쪽으로 줄인다. 같은 크기라도 이 장소를 직접
     잰 값보다 확실하지 않으므로, 직접 잰 후보와 나란히 놓았을 때 그것을
     이기고 올라가서는 안 된다. */
  if (candidate.crowdBasis === "nearby") score = 50 + (score - 50) * 0.6;
  /* 시군구 전체 값은 후보 사이를 가르지 못한다(모두 같은 값을 받는다). 순위에
     끼어들지 못하도록 더 크게 줄인다 — 보여 줄 값이지 정렬할 값이 아니다. */
  if (candidate.crowdBasis === "district") score = 50 + (score - 50) * 0.25;
  return Math.round(Math.min(100, Math.max(0, score)));
}

/* 붐빔 조회는 완전 일치만 봤다. 그래서 서울 종로에서 집중률 3,390행과
   1,650행을 **정상으로 받고도** 대안 8건이 전부 "공식 정보 없음"이었다.
   호출이 아니라 이름이 문제였다: 공사의 두 API가 같은 곳을 `성심당` /
   `성심당본점`처럼 다르게 적는다.

   연관 관광지 쪽에는 이미 앞뒤 부분 일치가 있었는데 이쪽에만 없었다. 같은
   규칙을 준다. 접두·접미로만 맞추고 최소 길이를 두는 것은 `관`·`공원` 같은
   짧은 조각이 아무 곳에나 붙는 것을 막기 위해서다. */
const FORECAST_MIN_SHARED_LENGTH = 3;

function findForecastMatch<T>(
  forecasts: Map<string, T>,
  title: string,
): T | undefined {
  const normalized = normalizeName(title);
  if (!normalized) return undefined;
  const exact = forecasts.get(normalized);
  if (exact) return exact;
  let best: T | undefined;
  let bestLength = 0;
  for (const [name, value] of forecasts) {
    if (name.length < FORECAST_MIN_SHARED_LENGTH) continue;
    if (!normalized.startsWith(name) && !normalized.endsWith(name)) continue;
    /* 여러 개가 걸리면 가장 긴 것을 쓴다 — 더 구체적인 이름이 더 옳다. */
    if (name.length > bestLength) {
      best = value;
      bestLength = name.length;
    }
  }
  return best;
}

/* 집중률 데이터셋은 **관광지 전용**이다. 반경 5km 후보를 유형별로 세어 보면
   음식점은 대전 중구 45곳·서울 종로구 86곳에서 매칭 0곳이고, 축제행사·숙박·
   레포츠도 0%다. 관광지조차 26~27%에 그친다. 표본이 적어서가 아니라 대상에
   없다.

   그런데 우리는 이미 **시군구 전체 30일 시계열**을 받아 온다(종로 3,390행).
   매칭된 곳에는 좌표가 있으므로, 값이 없는 후보는 가까운 이웃들의 값을 빌려
   올 수 있다. 추가 호출이 한 건도 들지 않는다.

   성심당 옆 골목 식당에 "이 일대가 오늘 얼마나 붐비는가"는 실제로 유효한
   정보다. 다만 빌려 온 값임을 반드시 밝힌다 — 그 장소를 직접 잰 값과 같은
   얼굴로 내보내면 근거를 부풀리는 것이다.

   중앙값을 쓴다. 평균은 관광지 한 곳의 극단값이 골목 전체를 물들인다. */
function districtRatesFrom(items: KtoItem[]): number[] {
  let latest = "";
  for (const item of items) {
    const date = stringValue(item.baseYmd);
    if (date && date > latest) latest = date;
  }
  if (!latest) return [];
  const rates: number[] = [];
  for (const item of items) {
    if (stringValue(item.baseYmd) !== latest) continue;
    const rate = numberInRange(item.cnctrRate, 0, 100);
    if (rate !== undefined) rates.push(rate);
  }
  return rates;
}

const CROWD_NEIGHBOR_RADIUS_METERS = 800;
const CROWD_NEIGHBOR_MIN_SAMPLES = 2;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function withNeighborCrowd<
  T extends {
    latitude: number;
    longitude: number;
    crowdRate?: number;
    crowdPercentile?: number;
    crowdBaseDate?: string;
    crowdBasis?: "place" | "nearby" | "district";
    crowdNeighborCount?: number;
    crowdNeighborMeters?: number;
  },
>(candidates: T[], districtRates: number[]): T[] {
  const measured = candidates.filter(
    (candidate) => candidate.crowdBasis === "place",
  );
  /* 시군구 전체의 오늘 값. 이 지역에 집중률 데이터가 한 줄이라도 있으면
     **모든 후보가 최소한 이 값은 받는다.** 그 장소를 잰 값이 아니므로 가장
     약한 근거지만, 아무것도 못 주는 것보다는 낫다 — 여행자가 다른 지역과
     견줄 때 쓸 수 있고, 무엇 기준인지 꼬리표로 밝힌다. */
  const districtRate = districtRates.length
    ? medianOf(districtRates)
    : undefined;
  if (!measured.length && districtRate === undefined) return candidates;
  return candidates.map((candidate) => {
    if (candidate.crowdBasis === "place") return candidate;
    const near = measured
      .map((other) => ({
        other,
        meters: haversineMeters(candidate, other),
      }))
      .filter((entry) => entry.meters <= CROWD_NEIGHBOR_RADIUS_METERS);
    if (near.length < CROWD_NEIGHBOR_MIN_SAMPLES) {
      if (districtRate === undefined) return candidate;
      return {
        ...candidate,
        crowdRate: districtRate,
        crowdBasis: "district" as const,
      };
    }
    const percentiles = near
      .map((entry) => entry.other.crowdPercentile)
      .filter((value): value is number => value !== undefined);
    return {
      ...candidate,
      crowdRate: medianOf(near.map((entry) => entry.other.crowdRate ?? 0)),
      crowdPercentile: percentiles.length ? medianOf(percentiles) : undefined,
      crowdBaseDate: near[0].other.crowdBaseDate,
      crowdBasis: "nearby" as const,
      crowdNeighborCount: near.length,
      crowdNeighborMeters: Math.round(
        Math.min(...near.map((entry) => entry.meters)),
      ),
    };
  });
}

/* 붐빔 정도를 세 단계로. **점수와 같은 함수에서 뽑는다** — 따로 계산하면
   갈라지고, 이 프로젝트는 그 갈림으로 라벨이 자기 카드의 수치와 반대가 된 적이
   있다.

   숫자를 그대로 보여 주던 문구("집중률 예측 39.04/100이고, 최근 30일 예측 중
   60번째 백분위입니다")는 여행자가 묻지 않은 것을 답한다. 알고 싶은 것은
   "붐비나?" 하나이고, 백분위는 그 답을 계산하라고 떠넘기는 것이다. 원문 수치는
   근거 확인용으로 남겨 두고 카드에서는 세 단어로 말한다. */
export type CrowdLevel = "easy" | "normal" | "busy";

function crowdLevelOf(candidate: {
  crowdRate?: number;
  crowdPercentile?: number;
  crowdBasis?: "place" | "nearby" | "district";
}): CrowdLevel | undefined {
  if (candidate.crowdRate === undefined) return undefined;
  const score = crowdComfortScore(candidate);
  if (score >= 70) return "easy";
  if (score >= 40) return "normal";
  return "busy";
}

/* 연관 관광지의 대분류를 후보의 콘텐츠 유형으로 옮긴다. 실데이터의 대분류는
   `음식`·`숙박`·`관광지` 셋뿐이어서(서울 종로·부산 해운대·제주 3,000여 행 확인)
   모호함 없이 매핑된다. */
function relatedCategoryAllowsType(
  majorCategory: string,
  contentTypeId: string,
): boolean {
  if (majorCategory === "음식") return contentTypeId === "39";
  if (majorCategory === "숙박") return contentTypeId === "32";
  if (majorCategory === "관광지") {
    return contentTypeId !== "39" && contentTypeId !== "32";
  }
  /* 모르는 분류는 통과시키지 않는다. 새 분류가 생겼을 때 조용히 느슨해지는
     것보다 연결하지 않는 쪽이 안전하다. */
  return false;
}

type RelatedMatch = { rank: number; majorCategory: string };

function relatedRankByTitle(
  items: KtoItem[],
  originLabel: string,
): Map<string, RelatedMatch> {
  const ranks = new Map<string, RelatedMatch>();
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
    if (current === undefined || rank < current.rank) {
      ranks.set(name, {
        rank,
        majorCategory: stringValue(item.rlteCtgryLclsNm),
      });
    }
  }
  return ranks;
}

/* 두 공사 API가 같은 장소를 다르게 표기한다. 연관 관광지는 `동백섬`, 국문
   관광정보는 `해운대 동백섬`처럼 시군구 접두어가 붙는다. 정확 일치만 보면
   실측에서 50개 연관 후보 중 6개만 연결됐다.

   그래서 한쪽이 다른 쪽을 경계에서 포함하는 경우까지 허용하되, **분류가
   맞을 때만** 연결한다. 분류 검사가 없으면 `동백섬횟집`(음식점)이 `동백섬`
   (자연관광)에 붙어 "함께 방문한 기록이 있는 곳"이라는 사실 주장이 거짓이 된다.
   실측 표본에서 이 규칙은 참 1건을 더 얻고 거짓 1건을 정확히 배제했다.

   기획 7.5의 "자동 매칭 신뢰도가 기준 미만이면 연결하지 않음"을 따른다. */
function findRelatedMatch(
  ranks: Map<string, RelatedMatch>,
  title: string,
  contentTypeId: string,
): number | undefined {
  const normalized = normalizeName(title);
  if (!normalized) return undefined;

  const exact = ranks.get(normalized);
  /* 이름이 같으면 그 자체로 가장 강한 신호다. 분류가 어긋나는 경우는 두 API의
     분류 체계 차이일 수 있으므로 이름 일치를 우선한다. */
  if (exact) return exact.rank;

  const MIN_SHARED_LENGTH = 3;
  let best: number | undefined;
  for (const [relatedName, match] of ranks) {
    if (relatedName.length < MIN_SHARED_LENGTH) continue;
    if (
      !normalized.startsWith(relatedName) &&
      !normalized.endsWith(relatedName)
    ) {
      continue;
    }
    if (!relatedCategoryAllowsType(match.majorCategory, contentTypeId)) {
      continue;
    }
    if (best === undefined || match.rank < best) best = match.rank;
  }
  return best;
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
    /* TourAPI content type 12 means the broad official "관광지" class. It
       does not prove that a place is nature tourism: streets, food alleys and
       media installations can legitimately use the same content type.
       Calling every item "자연 관광" invents a narrower classification and
       makes otherwise correct official data look broken to the traveller. */
    "12": { key: "attraction", label: "관광 명소", tier: "sightseeing" },
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
        originalPurpose: "조회 기준 시각부터 비어 있는 시간",
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
      originalPurpose: "조회 기준 시각부터 비어 있는 시간",
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
      /* 문장은 비운다. 관광 목적끼리 이어지는 것은 이 앱이 후보를 고르는
         전제라 모든 카드에 똑같이 붙었고, 같은 말이 모든 카드에 있으면
         카드를 고르는 데 아무 도움이 되지 않는다. 판정 자체(`status`)는
         남아 목적이 **바뀐** 경우에만 문장이 나간다. */
      statement: "",
      statementEn: "",
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
  const occurredAt = new Date(recoveryReferenceTime(input).at);
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
  const requestedDepartureAt = new Date(
    recoveryReferenceTime(input).at,
  );
  const occurredAt = Number.isNaN(requestedDepartureAt.getTime())
    ? new Date()
    : requestedDepartureAt;

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
    title: "조회 기준 시각부터 비어 있는 시간",
    occurredAt,
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

/* 제거실험 요약. 후보 수만 비교하면 "API를 끄니 별 차이 없다"로 읽히므로,
   사라진 판정 근거를 함께 센다. 실제로 연관 관광지를 끄면 후보 수는 그대로여도
   "함께 방문한 기록" 근거가 0이 되고 세 번째 카드의 축이 사라진다. */
const ABLATION_CAPABILITY: Record<string, string> = {
  TarRlteTarService1: "원래 일정과의 연계 방문 근거 (의도 보존)",
  TatsCnctrRateService: "향후 집중률 예측 기반 혼잡 회피",
  KorWithService2: "무장애·영유아·고령자 편의정보 검증",
};

function summariseAblation(
  input: RecoveryRequest,
  options: RecoveryOption[],
): RecoveryResult["ablation"] {
  const disabledSources = input.disabledSources ?? [];
  return {
    disabledSources,
    lostCapabilities: disabledSources.map(
      (source) => ABLATION_CAPABILITY[source] ?? source,
    ),
    verifiedOptionCount: options.filter(
      (option) => !option.confirmationRequired,
    ).length,
    confirmationRequiredCount: options.filter(
      (option) => option.confirmationRequired,
    ).length,
    relatedEvidenceCount: options.filter(
      (option) => option.relatedRank !== undefined,
    ).length,
    crowdEvidenceCount: options.filter(
      (option) => option.crowd.status === "available",
    ).length,
    accessibilityVerifiedCount: options.filter(
      (option) => option.accessibility.status === "verified",
    ).length,
  };
}

function summariseOpenWindow(
  context: ItineraryContext | undefined,
): RecoveryResult["openWindowSummary"] {
  const window = context?.openWindow;
  if (!context || !window) return undefined;
  return {
    windowStartAt: context.occurredAt.toISOString(),
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
  const minimumStayMinutes = input.minimumStayMinutes ?? 30;
  const safetyBufferMinutes = input.safetyBufferMinutes ?? 15;
  const openWindowStartMs = Date.parse(input.openWindow?.departureAt ?? "");
  const openWindowEndMs = Date.parse(input.openWindow?.availableUntil ?? "");
  const authoritativeAvailableMinutes =
    Number.isFinite(openWindowStartMs) && Number.isFinite(openWindowEndMs)
      ? Math.max(
          0,
          Math.floor((openWindowEndMs - openWindowStartMs) / 60_000),
        )
      : input.availableMinutes;
  const windowProof = candidate.scheduleDiff.openWindow;
  const appointmentProof = candidate.scheduleDiff.nextFixedAppointment;
  /* 거리값은 같은 5km라도 이동수단·경로에 따라 부담이 전혀 다르다. 실제 검증
     뒤에는 왕복/다음 장소까지의 경로 시간을, 그 전에는 수단별 보수 추정을 쓴다. */
  const travelBurdenMinutes = windowProof
    ? windowProof.travelToMinutes + windowProof.returnMinutes
    : input.openWindow && !input.openWindow.nextPlace
      ? candidate.estimatedTravelMinutes * 2
      : candidate.estimatedTravelMinutes;
  const availableTravelMinutes = Math.max(
    1,
    authoritativeAvailableMinutes -
      minimumStayMinutes -
      safetyBufferMinutes,
  );
  const timeBurdenScore = Math.max(
    0,
    Math.min(
      100,
      100 - (travelBurdenMinutes / availableTravelMinutes) * 100,
    ),
  );
  const slackMinutes = appointmentProof
    ? (appointmentProof.arrivalBufferMinutes ?? 0) -
      appointmentProof.safetyBufferMinutes
    : windowProof
      ? windowProof.leftoverMinutes - windowProof.requiredBufferMinutes
      : authoritativeAvailableMinutes -
        minimumStayMinutes -
        safetyBufferMinutes -
        travelBurdenMinutes;
  const slackScore = Math.max(0, Math.min(100, 50 + slackMinutes * 2));
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
  const crowdScore = crowdComfortScore(candidate);
  const accessScore =
    input.audience === "general"
      ? 75
      : candidate.accessibility.status === "verified"
        ? 100
        : 0;
  const indoorScore = candidate.indoor ? 100 : 35;
  let baseScore: number;
  if (input.incident === "rain") {
    baseScore =
      timeBurdenScore * 0.15 +
      indoorScore * 0.25 +
      accessScore * 0.13 +
      purposeScore * 0.18 +
      crowdScore * 0.04 +
      slackScore * 0.25;
  } else if (input.incident === "crowd") {
    baseScore =
      timeBurdenScore * 0.14 +
      crowdScore * 0.24 +
      accessScore * 0.14 +
      purposeScore * 0.18 +
      slackScore * 0.3;
  } else if (input.incident === "less_walk") {
    /* `less_walk`는 엔진에 아예 없었다. 화면은 "보행 부담과 접근성 조건을 먼저
       통과한 후보만 제시합니다"라고 약속하는데 실제로는 `delay`와 똑같이 계산됐다.
       고른 상황이 결과를 바꾸지 않으면 그 선택지는 화면 장식이다.

       이동 부담을 줄이는 것이 목적이므로 실제 이동시간 가중을 가장 크게 두고
       접근성을 그다음에 둔다. 거리는 표시 정보일 뿐 탈락·점수 기준이 아니다. */
    baseScore =
      timeBurdenScore * 0.38 +
      accessScore * 0.22 +
      purposeScore * 0.12 +
      indoorScore * 0.04 +
      crowdScore * 0.02 +
      slackScore * 0.22;
  } else {
    baseScore =
      timeBurdenScore * 0.23 +
      accessScore * 0.13 +
      purposeScore * 0.18 +
      crowdScore * 0.06 +
      slackScore * 0.4;
  }

  const comfortScore =
    accessScore * 0.27 +
    indoorScore * 0.2 +
    crowdScore * 0.14 +
    timeBurdenScore * 0.12 +
    purposeScore * 0.1 +
    slackScore * 0.17;

  /* 날씨는 순위에 넣지 않는다.
     체류 시간대 강수·기온을 감점으로 넣어 봤지만, 그 임계값(강수확률 30·60%,
     기온 33℃)은 **실측으로 조정한 값이 아니다.** 검증되지 않은 숫자를 순위에
     박아 넣으면 사용자는 왜 이 순서인지 알 수 없고 우리도 방어할 수 없다.
     대신 예보를 시점별 아이콘으로 그대로 보여 주고 판단은 사용자가 한다.

     우천 상황을 고른 요청에서 실내를 선호하는 것은 그대로 동작한다 —
     `indoorScore`가 `rain` 분기에서 25% 가중치를 갖고, 그것은 사용자가 직접
     선언한 조건이다. 이 감점을 빼도 그 시나리오는 잃지 않는다. */
  return {
    baseScore: Math.round(baseScore * 10) / 10,
    comfortScore: Math.round(comfortScore * 10) / 10,
  };
}

/* 점수 상위가 한 분류에 몰려 공원·문화유산·식당이 검증 단계에 도달하지 못하는
   것을 막는다. 공식 KTO 분류별 큐에서 한 곳씩 순환하므로 각 분류 내부 점수순은
   유지하면서 검증 풀의 발견 다양성을 확보한다. */
function diversifyCandidatesByCategory(
  candidates: WorkingCandidate[],
): WorkingCandidate[] {
  const buckets = new Map<string, WorkingCandidate[]>();
  for (const candidate of candidates) {
    const code = ktoTourismCategory(candidate.item).code;
    const bucket = buckets.get(code) ?? [];
    bucket.push(candidate);
    buckets.set(code, bucket);
  }

  const diversified: WorkingCandidate[] = [];
  while (diversified.length < candidates.length) {
    let appended = false;
    for (const bucket of buckets.values()) {
      const candidate = bucket.shift();
      if (!candidate) continue;
      diversified.push(candidate);
      appended = true;
    }
    if (!appended) break;
  }
  return diversified;
}

async function accessibilityDetails(
  candidates: WorkingCandidate[],
  audience: RecoveryRequest["audience"],
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<{ details: Map<string, KtoItem>; audits: KtoAudit[] }> {
  if (audience === "general") return { details: new Map(), audits: [] };

  const details = new Map<string, KtoItem>();
  const audits: KtoAudit[] = [];

  for (let offset = 0; offset < candidates.length; offset += 4) {
    if (
      signal?.aborted ||
      (deadlineAt !== undefined &&
        deadlineAt - Date.now() <= ACCESSIBILITY_DETAIL_RESERVE_MS)
    ) {
      break;
    }
    const group = candidates.slice(offset, offset + 4);
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
  referenceAt = new Date(),
): ScheduleDiff {
  const startAt = new Date(
    referenceAt.getTime() + candidate.estimatedTravelMinutes * 60_000,
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
  /* Required for an open window without a next appointment. It is a real
     candidate→origin request, never an outbound-duration estimate. */
  returnRoute?: Extract<WalkingRouteEvidence, { status: "routed" }>;
  stayMinutes: number;
  safetyBufferMinutes: number;
}): ScheduleDiff {
  const {
    context,
    candidate,
    route,
    returnRoute,
    stayMinutes,
    safetyBufferMinutes,
  } = params;
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
        returnRoute,
        nextFixedAppointment,
        requiredBufferMinutes: safetyBufferMinutes,
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
        : `비어 있는 시간에 한 곳을 더 넣고, 후보지에서 출발지로 돌아오는 실제 역방향 ${routeModeLabel(returnRoute?.provider ?? route.provider)} 경로를 별도로 조회해 왕복 시간이 남은 시간 안에 들어가는지 검증했습니다.`,
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
const PROVIDER_MODE_LABEL: Record<
  WalkingRouteProvider,
  { ko: string; en: string }
> = {
  tmap_pedestrian: { ko: "보행", en: "walking" },
  openstreetmap_osrm: { ko: "보행", en: "walking" },
  tmap_car: { ko: "자동차", en: "driving" },
  kakao_transit: { ko: "대중교통", en: "transit" },
  kakao_bicycle: { ko: "자전거", en: "cycling" },
};

function routeModeLabel(provider: WalkingRouteProvider): string {
  return PROVIDER_MODE_LABEL[provider].ko;
}

/* 사용자가 고른 수단의 이름. 경로 조회 이전 단계의 문구에 쓴다. */
/* 실내 조건은 여기 한 곳에서만 결정한다. 예전에는 세 곳에서 각자
   `incident === "rain" || indoorOnly`를 계산해, 클라이언트가 실내를 끄고
   보내도 엔진이 우천이라는 이유로 다시 켰다. 여행자에게는 되돌릴 방법이
   없는 상태였다. 명시적으로 보낸 값이 항상 이긴다. */
function indoorRequirement(input: RecoveryRequest): boolean {
  return input.indoorOnly ?? input.incident === "rain";
}

function travelModeLabel(mode: RecoveryRequest["travelMode"]): string {
  return mode === "car"
    ? "자동차"
    : mode === "transit"
      ? "대중교통"
      : mode === "bicycle"
        ? "자전거"
        : "보행";
}

function openWindowProof(params: {
  context: ItineraryContext;
  windowStartAt: Date;
  travelToMinutes: number;
  appliedStayMinutes: number;
  arriveAt: Date;
  leaveAt: Date;
  route: Extract<WalkingRouteEvidence, { status: "routed" }>;
  returnRoute?: Extract<WalkingRouteEvidence, { status: "routed" }>;
  nextFixedAppointment?: ScheduleDiff["nextFixedAppointment"];
  requiredBufferMinutes: number;
}): OpenWindowProof | undefined {
  const window = params.context.openWindow;
  if (!window) return undefined;
  const windowMinutes = Math.max(
    0,
    Math.floor(
      (window.endAt.getTime() - params.windowStartAt.getTime()) / 60_000,
    ),
  );
  const nextPlaceLeg = params.route.legs[1];
  const returnRoute = params.returnRoute;
  if (!params.nextFixedAppointment && !returnRoute) return undefined;
  const returnMinutes = params.nextFixedAppointment
    ? (nextPlaceLeg?.durationMinutes ?? 0)
    : (returnRoute?.durationMinutes ?? 0);
  const returnBasis = params.nextFixedAppointment
    ? ("next_place_route" as const)
    : ("origin_return_route" as const);
  const returnProvider = params.nextFixedAppointment
    ? params.route.provider
    : (returnRoute?.provider ?? params.route.provider);
  const returnDistanceMeters = params.nextFixedAppointment
    ? (nextPlaceLeg?.distanceMeters ?? 0)
    : (returnRoute?.distanceMeters ?? 0);
  const returnCalculatedAt = params.nextFixedAppointment
    ? params.route.calculatedAt
    : (returnRoute?.calculatedAt ?? params.route.calculatedAt);
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
    returnProvider,
    returnDistanceMeters,
    returnCalculatedAt,
    requiredBufferMinutes: params.requiredBufferMinutes,
    leftoverMinutes,
    status:
      leftoverMinutes >= params.requiredBufferMinutes ? "fits" : "at_risk",
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
  let availabilityLookupFailed = false;

  if (context) {
    const routePoints = [
      input.origin,
      { latitude: candidate.latitude, longitude: candidate.longitude },
      ...context.continuityNodes.map((node) => ({
        latitude: node.location!.latitude,
        longitude: node.location!.longitude,
      })),
    ];
    const requiresOriginReturn = Boolean(
      context.openWindow && !context.nextFixed,
    );
    const route = await getRoute(routePoints, {
      signal,
      mode: input.travelMode,
      departureAt: context.occurredAt.toISOString(),
      arriveBy: context.nextFixed?.startAt,
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
          `대체 일정부터 복귀 지점까지 이어지는 전체 ${travelModeLabel(input.travelMode)} 경로를 검증하지 못해 결과에서 제외했습니다.`,
        distanceMeters: candidate.distanceMeters,
        changedNodeCount: 1,
      });
      return null;
    }
    /* Return traffic/timetables depend on when the visit really ends. Query
       only after the verified outbound duration is known; a preliminary
       straight-line estimate must never become a provider departure time. */
    const rawReturnRoute = requiresOriginReturn
      ? await getRoute(
          [
            {
              latitude: candidate.latitude,
              longitude: candidate.longitude,
            },
            input.origin,
          ],
          {
            signal,
            mode: input.travelMode,
            departureAt: new Date(
              context.occurredAt.getTime() +
                ((route.legs[0]?.durationMinutes ?? route.durationMinutes) +
                  Math.max(minimumStay, context.originalDurationMinutes)) *
                  60_000,
            ).toISOString(),
            arriveBy: context.openWindow?.endAt.toISOString(),
          },
        )
      : undefined;
    if (
      requiresOriginReturn &&
      (!rawReturnRoute || rawReturnRoute.status !== "routed")
    ) {
      rejected.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "ROUTE_UNAVAILABLE",
        reason:
          "후보지에서 출발지로 돌아오는 실제 역방향 경로를 검증하지 못해 왕복 추천에서 제외했습니다.",
        distanceMeters: candidate.distanceMeters,
        changedNodeCount: 0,
      });
      return null;
    }
    const returnRoute =
      rawReturnRoute?.status === "routed" ? rawReturnRoute : undefined;

    const firstLeg = route.legs[0];
    const routedDistance =
      firstLeg?.distanceMeters ?? route.distanceMeters;
    const routedMinutes =
      firstLeg?.durationMinutes ?? route.durationMinutes;
    /* 체류시간은 등록 일정 또는 빈 시간 입력의 계획값이 권위 원천이다.
       레거시 availableMinutes로 조용히 줄이지 않고, 맞지 않으면 아래 연속성/창
       검증에서 명시적으로 탈락시킨다. */
    let stayMinutes = Math.max(minimumStay, context.originalDurationMinutes);
    scheduleDiff = itineraryScheduleDiff({
      context,
      candidate,
      route,
      returnRoute,
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
          returnRoute,
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
        availabilityLookupFailed = true;
        sourceLedger.push(
          auditFromFailure("KorService2", "detailIntro2", error),
        );
        availability = unknownAvailability(
          "한국관광공사 상세 운영정보 호출에 실패해 운영 여부를 확정하지 못했습니다.",
        );
      }
    }

    const violations: RejectedCandidate[] = [];
    const operatingViolation = operatingStatusRejection({
      candidate,
      availability,
      lookupFailed: availabilityLookupFailed,
      changedNodeCount: context.changeKind === "insert" ? 0 : 1,
    });
    if (operatingViolation) violations.push(operatingViolation);
    /* 거리 자체는 탈락 조건이 아니다. 등록 일정/빈 시간에서는 아래 연속성·창
       증명이 이동+체류+복귀(또는 다음 일정)를 실제 시각으로 fail-closed 한다.
       컨텍스트 없는 구형 호출만 호환 시간 한도를 사용한다. */
    if (!context && routedMinutes > input.availableMinutes) {
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
      /* A counterfactual is used in a later request, after time has already
         advanced. Suggesting the exact mathematical boundary can therefore
         fail again seconds later. Round the stay reduction up to a five-minute
         step and reserve an additional execution margin. Never suggest
         weakening the declared safety buffer: it is a safety contract, not a
         ranking preference. */
      const counterfactualReduction =
        Math.ceil((shortfall + 2) / 5) * 5;
      const minimumStayAfterRelaxation =
        minimumStay - counterfactualReduction;
      const requiredRelaxation =
        minimumStayAfterRelaxation >= 10
          ? {
              constraint: "minimum_stay" as const,
              amount: counterfactualReduction,
              unit: "minutes" as const,
              currentLimit: minimumStay,
              requiredLimit: minimumStayAfterRelaxation,
              description: `최소 체류 ${minimumStay}분 → ${minimumStayAfterRelaxation}분`,
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
      const shortfall = Math.max(
        0,
        windowProof.requiredBufferMinutes - windowProof.leftoverMinutes,
      );
      const reducedStay =
        Math.floor((windowProof.appliedStayMinutes - shortfall) / 30) * 30;
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "OPEN_WINDOW_OVERFLOW",
        reason:
          windowProof.returnBasis === "next_place_route"
            ? `다녀오면 다음 장소에 필요한 ${windowProof.requiredBufferMinutes}분 안전여유가 ${shortfall}분 부족합니다.`
            : `다녀오면 복귀 뒤 필요한 ${windowProof.requiredBufferMinutes}분 안전여유가 ${shortfall}분 부족합니다.`,
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
    /* 운영시간은 소프트 순위 조건이 아니다. 제안한 체류 구간 전체가 공식
       정보로 열려 있다고 확인된 후보만 실행 가능한 옵션이 된다. 휴무·데이터
       부족·제공자 장애는 서로 다른 사유로 원장에 남겨, 여행자에게는 헛걸음을
       막고 운영자에게는 재시도 가능한 장애인지 구분해 준다. */

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
      availabilityLookupFailed = true;
      sourceLedger.push(
        auditFromFailure("KorService2", "detailIntro2", error),
      );
      availability = unknownAvailability(
        "한국관광공사 상세 운영정보 호출에 실패해 운영 여부를 확정하지 못했습니다.",
      );
    }
  }

  if (!context) {
    const operatingViolation = operatingStatusRejection({
      candidate,
      availability,
      lookupFailed: availabilityLookupFailed,
      changedNodeCount: 0,
    });
    if (operatingViolation) {
      rejected.push(operatingViolation);
      return null;
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

  /* 체류 시간대의 날씨. 예보 시계열은 이미 받아 둔 것이므로 추가 호출이 없다.
     지금 하늘이 아니라 "내가 거기 있을 동안"을 판정한다. */
  const stayWeather = summariseStayWeather(
    weatherEvidence,
    new Date(scheduleDiff.replacementNode.startAt),
    new Date(scheduleDiff.replacementNode.endAt),
  );
  /* 시점별 아이콘용. 기준 시각은 요청의 조회 기준 시각이다 — 지정 여행지와 대안을 같은
     시점으로 놓아야 비교가 되고, 후보마다 체류 시작이 달라 그것을 기준으로
     하면 카드 간 시점이 어긋난다. */
  const glance = weatherGlance(
    weatherEvidence,
    new Date(recoveryReferenceTime(input).at),
    { preferForecast: recoveryReferenceTime(input).mode === "assumed" },
  );

  const withoutScores = {
    ...candidate,
    availability,
    routeEvidence,
    scheduleDiff,
    continuityProof,
    stayWeather,
    weatherGlance: glance,
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
    const provider = candidate.routeEvidence.provider;
    const routeSource =
      provider === "tmap_pedestrian"
        ? { ko: "TMAP 보행자 경로", en: "TMAP pedestrian routing" }
        : provider === "tmap_car"
          ? { ko: "TMAP 자동차 경로", en: "TMAP car routing" }
          : provider === "kakao_transit"
            ? { ko: "카카오맵 대중교통", en: "KakaoMap transit" }
            : provider === "kakao_bicycle"
              ? { ko: "카카오맵 자전거 경로", en: "KakaoMap cycling route" }
              : {
                  ko: "OpenStreetMap 보행 경로",
                  en: "OpenStreetMap walking route",
                };
    /* 수단도 문장에 드러나야 한다. 자차로 계산한 20분을 "보행 경로로 20분"이라고
       적으면 여행자가 걸어서 갈 수 있다고 읽는다. */
    const modeWords = PROVIDER_MODE_LABEL[provider];
    push(
      `실제 ${modeWords.ko} 경로로 ${meters.toLocaleString("ko-KR")}m, 약 ${candidate.estimatedTravelMinutes}분입니다. (${routeSource.ko})`,
      `${meters.toLocaleString("en-US")} m on a real ${modeWords.en} route, about ${candidate.estimatedTravelMinutes} min (${routeSource.en}).`,
    );
    if (typeof candidate.routeEvidence.taxiFareKrw === "number") {
      push(
        "TMAP 자동차 경로가 반환한 택시요금은 자차 유류비·통행료·주차비와 다른 값이므로 자차 비용으로 표시하지 않습니다.",
        "The taxi estimate returned with the TMAP car route is not shown as a driving cost because it is not fuel, toll or parking expense.",
      );
    }
    const transitFare = candidate.routeEvidence.fareKrw;
    const transfers = candidate.routeEvidence.transfers;
    if (typeof transitFare === "number" || typeof transfers === "number") {
      push(
        `복구 전체 대중교통 경로 기준 요금 ${
          typeof transitFare === "number"
            ? `${transitFare.toLocaleString("ko-KR")}원`
            : "미확인"
        }, 환승 ${typeof transfers === "number" ? `${transfers}회` : "횟수 미확인"}입니다.`,
        `For the whole recovered transit route, the fare is ${
          typeof transitFare === "number"
            ? `${transitFare.toLocaleString("en-US")} KRW`
            : "unavailable"
        } and transfers are ${typeof transfers === "number" ? transfers : "unavailable"}.`,
      );
    }
    /* 배차를 모르는 값이므로 확정 도착 시각처럼 제시하지 않는다. 도보·자차와
       같은 등급으로 보여 주면 도착 시각을 보증하는 셈이 된다. */
    if (candidate.routeEvidence.scheduleDependent) {
      push(
        "대중교통 소요시간은 배차 간격에 따라 달라질 수 있습니다. 출발 직전 실시간 도착 정보를 확인해 주세요.",
        "Transit time varies with service frequency. Check live arrivals before you set out.",
      );
    }
  } else {
    push(
      `한국관광공사 좌표 기준 직선거리 ${meters.toLocaleString("ko-KR")}m입니다.`,
      `${meters.toLocaleString("en-US")} m in a straight line from the official coordinates.`,
    );
  }

  /* 연락처는 운영 정보 상자에서 뺐다. 그 상자는 "몇 시에 여는가" 하나만
     답해야 읽히고, 전화번호는 그 답이 아니라 다음 행동이다. 버리지 않고
     행동 목록인 이 불릿으로 옮긴다. */
  const availabilityContact = candidate.availability?.contact;
  if (availabilityContact) {
    push(
      `운영시간을 도착 전에 확인하려면 ${availabilityContact}로 문의할 수 있습니다.`,
      `To confirm the hours before you go, call ${availabilityContact}.`,
    );
  }

  const appointment = candidate.scheduleDiff.nextFixedAppointment;
  if (appointment?.status === "preserved") {
    push(
      `다음 예약 '${appointment.title}'에 ${appointment.arrivalBufferMinutes}분 여유를 두고 도착합니다.`,
      `You arrive at '${appointment.title}' with ${appointment.arrivalBufferMinutes} min to spare.`,
    );
  }
  /* "한 곳만 바꾸고 나머지는 그대로 둡니다"를 뺐다. 이 앱이 하는 일이 그것
     하나뿐이므로 모든 카드에 똑같이 붙었고, 모든 카드에 같은 문장이 있으면
     카드를 고르는 데 아무 도움이 되지 않는다.

     운영시간을 읽지 못했다는 문장도 뺐다. 같은 사실을 근거 항목이 **원문과
     함께** 말하므로("공식 운영시간은 …입니다"), 여기서 한 번 더 적으면 원문
     없는 쪽이 먼저 눈에 들어와 오히려 불친절하다. */
  if (candidate.availability.status === "confirmed_open") {
    push(
      "도착 시각에 문을 여는지 한국관광공사 공식 운영정보로 확인했습니다.",
      "Official operating data confirms it is open at your arrival time.",
    );
  }
  if (candidate.indoor && indoorRequirement(input)) {
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
  } else if (input.audience !== "general") {
    /* 접근성이 확인되지 않은 후보가 1순위이거나 유일 추천인데, 추천 이유 다섯
       문장에 그 사실이 한 줄도 없었다. `evidenceGaps`에는 "자동 복구안에서
       제외합니다"라고 적혀 있는데 화면은 그것을 추천으로 보여주는 상태였다.
       휠체어·유아차 이용자에게는 그 한 줄이 이 앱을 쓰는 이유다. */
    const missing = candidate.accessibility.requiredChecks
      .filter((check) => check.status === "missing")
      .map((check) => check.label);
    push(
      missing.length
        ? `요청한 이동 조건 중 ${missing.join("·")}을 공식 정보에서 확인하지 못했습니다. 출발 전에 직접 확인해 주세요.`
        : "요청한 이동 조건을 공식 무장애여행정보에서 확인하지 못했습니다. 출발 전에 직접 확인해 주세요.",
      missing.length
        ? `Official data does not confirm ${missing.join(", ")}. Please check before you set out.`
        : "Official barrier-free data does not confirm the conditions you asked for. Please check before you set out.",
    );
  }
  /* 체류 시간대의 날씨. 지금 하늘이 아니라 "내가 거기 있을 동안"을 말한다.
     실외 후보에만 붙인다 — 실내에 들어가 있는 동안의 강수는 결정을 바꾸지
     않으므로 카드 한 줄을 쓸 값어치가 없다. */
  const stay = candidate.stayWeather;
  if (stay && stay.status !== "unknown" && !candidate.indoor) {
    const startsAt = stay.precipitationStartsAt
      ? new Intl.DateTimeFormat("ko-KR", {
          timeZone: "Asia/Seoul",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(stay.precipitationStartsAt))
      : undefined;
    if (stay.status !== "dry") {
      push(
        [
          "머무는 시간대에",
          startsAt
            ? `${startsAt}부터 ${stay.precipitationKind ?? "강수"}가 예보돼 있습니다`
            : `강수확률이 최고 ${stay.maxPrecipitationProbabilityPercent}%입니다`,
          "(실외 장소입니다).",
          stay.status === "rain_likely"
            ? "우산이 필요할 가능성이 높습니다."
            : "예보가 확정은 아니니 출발 전에 다시 확인해 주세요.",
        ].join(" "),
        [
          "During your stay",
          startsAt
            ? `precipitation is forecast from ${startsAt}`
            : `the peak chance of precipitation is ${stay.maxPrecipitationProbabilityPercent}%`,
          "(this is an outdoor place).",
          stay.status === "rain_likely"
            ? "You will likely need an umbrella."
            : "A forecast is not a certainty — check again before you set out.",
        ].join(" "),
      );
    }
    const strain = outdoorTemperatureStrain(stay);
    if (strain) {
      /* 조건을 밝히지 않은 요청에도 문장은 보여 준다. 순위는 바꾸지 않되
         판단할 근거는 준다. */
      push(
        strain.kind === "heat"
          ? `머무는 시간대 기온이 최고 ${strain.celsius}℃로 예보됐습니다. 실외 장소이므로 그늘과 물을 확인해 주세요.`
          : `머무는 시간대 기온이 최저 ${strain.celsius}℃로 예보됐습니다. 실외 장소이므로 방한을 확인해 주세요.`,
        strain.kind === "heat"
          ? `The forecast high during your stay is ${strain.celsius}°C at this outdoor place — check for shade and water.`
          : `The forecast low during your stay is ${strain.celsius}°C at this outdoor place — dress for the cold.`,
      );
    }
  }
  if (candidate.crowdRate !== undefined) {
    push(
      /* 여행자가 알고 싶은 것은 "붐비나?" 하나다. 숫자와 백분위를 늘어놓으면
         그 답을 직접 계산하라고 떠넘기는 것이 된다. 원문 수치는 근거 화면에
         남아 있으므로 "무엇을 근거로 그렇게 말했는가"는 여전히 답할 수 있다. */
      crowdLevelOf(candidate) === "easy"
        ? "조회 기준일 예측으로는 원활한 편입니다. 사람 수가 아니라 일별 붐빔 정도 예측이며, 현장 실시간 인원수는 아닙니다."
        : crowdLevelOf(candidate) === "busy"
          ? "조회 기준일 예측으로는 붐비는 편입니다. 사람 수가 아니라 일별 붐빔 정도 예측이며, 현장 실시간 인원수는 아닙니다."
          : "조회 기준일 예측으로는 보통 수준입니다. 사람 수가 아니라 일별 붐빔 정도 예측이며, 현장 실시간 인원수는 아닙니다.",
      crowdLevelOf(candidate) === "easy"
        ? "Forecast to be quiet. A crowding forecast, not a live headcount."
        : crowdLevelOf(candidate) === "busy"
          ? "Forecast to be busy. A crowding forecast, not a live headcount."
          : "Forecast to be about average. A crowding forecast, not a live headcount.",
    );
  }
  /* 붐빔 칸이 비어 이 순위가 그 자리로 올라간 경우에는 불릿에 다시 적지
     않는다. 같은 값을 한 카드에 두 번 적으면 카드만 길어진다. */
  if (candidate.relatedRank !== undefined && candidate.crowdRate !== undefined) {
    push(
      `원래 일정과 함께 방문된 순위 ${candidate.relatedRank}위 기록이 있습니다.`,
      `Ranked #${candidate.relatedRank} among places visited together with your original stop.`,
    );
  }
  if (input.incident === "less_walk") {
    /* 무엇을 기준으로 정렬했는지 밝힌다. 밝히지 않으면 "이동 부담 감소"를 골랐을
       때 결과가 왜 이렇게 나왔는지 알 수 없다. */
    push(
      "이동 부담을 가장 크게 반영해 정렬했습니다. 이동거리와 접근성 확인 여부를 먼저 봅니다.",
      "Ranked with travel burden weighted highest — distance and confirmed accessibility come first.",
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
            : routeProvider === "kakao_transit"
              ? "카카오맵 대중교통 길찾기"
              : routeProvider === "kakao_bicycle"
                ? "카카오맵 자전거 길찾기"
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
    weatherGlance: candidate.weatherGlance?.length
      ? candidate.weatherGlance
      : undefined,
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
    tourismCategory: ktoTourismCategory(candidate.item),
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
      indoorRequirement(input)
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
        ? candidate.relatedRank !== undefined
          ? {
              /* 붐빔은 못 구했지만 **다른 공사 API에 이 곳의 자리는 있다.**
                 연관 관광지 순위는 집중률이 못 덮는 유형을 정확히 덮는다 —
                 측정하면 음식점 16~35%, 쇼핑 17~60%, 축제행사 26%다.

                 다만 이것은 붐빔이 아니라 **인기**다. 월 단위 집계라 요일도
                 없다. 같은 단어로 부르면 없는 근거를 만드는 것이므로 축을
                 갈라 놓고, 임의의 등급을 매기지 않고 순위 자체를 적는다. */
              status: "popularity_rank",
              relatedRank: candidate.relatedRank,
              note: `인기 ${candidate.relatedRank}위`,
              noteEn: `Popularity #${candidate.relatedRank}`,
            }
          : {
              /* 세 축 어디에도 없다. 우리 판정 과정을 설명하는 대신 사실만
                 짧게 적는다. */
              status: "unavailable",
              note: "공식 정보 없음",
              noteEn: "No official data",
            }
        : {
            status: "available",
            relativeRate: candidate.crowdRate,
            baseDate: candidate.crowdBaseDate,
            percentileOfSeries: candidate.crowdPercentile,
            seriesDays: candidate.crowdSeriesDays,
            /* 카드에 쓰는 것은 세 단계뿐이다. `60번째 백분위`는 여행자가
               "붐비나?"의 답을 직접 계산하게 만든다. 원문 수치는 위 필드에
               그대로 남아 근거 확인에 쓸 수 있다. */
            level: crowdLevelOf(candidate),
            /* 빌려 온 값이면 반드시 밝힌다. 꼬리표 없이 내보내면 이 장소를
               직접 잰 것처럼 읽힌다. */
            basis: candidate.crowdBasis ?? "place",
            neighborCount: candidate.crowdNeighborCount,
            neighborMeters: candidate.crowdNeighborMeters,
            note: `${
              crowdLevelOf(candidate) === "easy"
                ? "원활"
                : crowdLevelOf(candidate) === "busy"
                  ? "혼잡"
                  : "보통"
            }${
              candidate.crowdBasis === "nearby"
                ? " (주변 기준)"
                : candidate.crowdBasis === "district"
                  ? " (지역 기준)"
                  : ""
            }`,
            noteEn: `${
              crowdLevelOf(candidate) === "easy"
                ? "Quiet"
                : crowdLevelOf(candidate) === "busy"
                  ? "Busy"
                  : "Average"
            }${
              candidate.crowdBasis === "nearby"
                ? " (nearby)"
                : candidate.crowdBasis === "district"
                  ? " (district)"
                  : ""
            }`,
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
    /* 라벨이 고른 후보에 따라 달라져야 하는 경우가 있다. 접근성 카드가 그렇다 —
       조건이 확인되지 않은 후보에 "조건이 가장 잘 맞는 곳"이라고 붙이면 같은
       카드 안의 미확인 경고와 정면으로 모순된다. */
    label:
      | { ko: string; en: string }
      | ((candidate: WorkingCandidate) => { ko: string; en: string }),
  ) => {
    const candidate = sorted.find((entry) => !used.has(entry.contentId));
    if (!candidate) return;
    used.add(candidate.contentId);
    selected.push({
      candidate,
      strategy,
      label: typeof label === "function" ? label(candidate) : label,
    });
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
      : { ko: "조회 기준 시각에 갈 수 있는 가장 가까운 곳", en: "Closest place you can reach at the selected time" },
  );

  /* 두 번째 카드는 상황별로 사용자가 실제로 궁금해하는 축을 쓴다. */
  if (input.incident === "crowd") {
    addFirstUnused(
      /* 점수와 같은 함수로 정렬한다. 따로 적어 두면 갈라지고, 실제로 갈려서
         라벨이 자기 카드의 수치와 반대가 됐다. 높을수록 덜 붐빈다. */
      [...pool].sort(
        (a, b) =>
          crowdComfortScore(b) - crowdComfortScore(a) ||
          b.baseScore - a.baseScore,
      ),
      "comfortable",
      /* 최저 집중률 후보가 앞 카드에 이미 쓰였으면 이 카드는 차순위를 물려받는데,
         라벨만 "덜 붐빌 것으로 예측된 곳"으로 남아 자기 카드의 수치와 정반대가
         됐다. 실측에서 이 카드의 예측지수가 63.77인데 위 카드가 14.01이었다.
         붐빔을 피하려 들어온 화면에서 가장 중요한 한 줄이 틀리면, 같은 카드의
         "경사로 있음"이나 "운영시간 확인" 같은 정직한 문장까지 함께 의심받는다.
         그래서 실제로 더 낮을 때만 그렇게 말한다. */
      (candidate) => {
        if (candidate.crowdRate === undefined) {
          return {
            ko: "집중률 예측을 확인하지 못한 곳",
            en: "No crowd forecast available",
          };
        }
        const score = crowdComfortScore(candidate);
        const lowerAlreadyShown = selected.some(
          (entry) =>
            entry.candidate.crowdRate !== undefined &&
            crowdComfortScore(entry.candidate) >= score,
        );
        return lowerAlreadyShown
          ? {
              ko: "집중률 예측을 확인한 곳",
              en: "Crowd forecast confirmed",
            }
          : {
              ko: "덜 붐빌 것으로 예측된 곳",
              en: "Forecast to be less crowded",
            };
      },
    );
  } else {
    addFirstUnused(
      [...pool].sort(
        (a, b) => b.comfortScore - a.comfortScore || b.baseScore - a.baseScore,
      ),
      "comfortable",
      /* 접근성이 확인되지 않은 후보에 "조건이 가장 잘 맞는 곳"이라고 붙이면,
         같은 카드 안의 "요청한 조건을 확인하지 못했습니다"와 정면으로 모순된다.
         확인된 경우에만 그렇게 말한다. */
      (candidate) =>
        input.audience === "general"
          ? { ko: "이동 부담이 가장 적은 곳", en: "Least walking and transfers" }
          : candidate.accessibility.status === "verified"
            ? {
                ko: "이동 편의 조건이 확인된 곳",
                en: "Mobility need confirmed by official data",
              }
            : {
                ko: "이동 부담이 가장 적은 곳 (편의 조건 미확인)",
                en: "Least travel burden (mobility need unconfirmed)",
              },
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

  /* 전략 카드 세 장을 고른 뒤, **검증한 나머지 후보를 전부 점수순으로 아래에
     붙인다.** 예전에는 검증한 후보 중 세 장만 돌려주어 안전 조건을 통과한
     선택지를 숨겼다. 여행에 정답은 없으므로 위에는 조건을 가장 잘 맞춘 곳,
     아래에는 그 밖의 검증 완료 후보를 점수순으로 둔다. */
  const remaining = [...pool]
    .filter((candidate) => !used.has(candidate.contentId))
    .sort((a, b) => b.baseScore - a.baseScore);
  for (const candidate of remaining) {
    used.add(candidate.contentId);
    selected.push({
      candidate,
      strategy: "local_discovery",
      label: { ko: "근처의 다른 선택지", en: "Another nearby choice" },
    });
  }

  return selected.map(({ candidate, strategy, label }) =>
    toOption(candidate, strategy, label, requestId, input),
  );
}

/* Groups rejections by reason so an empty result can explain itself. */
function summariseRejections(
  rejected: RejectedCandidate[],
): Array<{ reasonCode: RejectionReasonCode; count: number }> {
  const counts = new Map<RejectionReasonCode, number>();
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
      /* 경로까지 검증한 탈락안이 먼저다. 같은 "조건 하나만 풀면 된다"라도
         예약 보존을 확인한 쪽이 사용자에게 더 확실한 정보이기 때문이다.
         사전 걸러내기 단계 탈락안은 그것이 없을 때만 올라온다. */
      const depthRank = (entry: RejectedCandidate) =>
        entry.verificationDepth === "route_verified" ? 0 : 1;
      const depth = depthRank(a) - depthRank(b);
      if (depth) return depth;
      /* 단위를 비교 가능한 축으로 환산한다. 조건 해제는 숫자 완화와 견줄 수
         없으므로 가장 뒤로 보낸다 — "5분만 더"가 있으면 그것이 더 가깝다. */
      const normalize = (
        relaxation: NonNullable<RejectedCandidate["requiredRelaxation"]>,
      ) =>
        relaxation.unit === "meters"
          ? relaxation.amount / 100
          : relaxation.unit === "condition"
            ? Number.MAX_SAFE_INTEGER
            : relaxation.amount;
      return (
        normalize(a.requiredRelaxation) - normalize(b.requiredRelaxation) ||
        (a.distanceMeters ?? Number.POSITIVE_INFINITY) -
          (b.distanceMeters ?? Number.POSITIVE_INFINITY)
      );
    });
  const best = eligible[0];
  if (!best) return undefined;
  return {
    ...best,
    proofType: "single_constraint_minimum_relaxation",
    verificationDepth: best.verificationDepth ?? "pre_filter",
  };
}

export async function recoverTrip(
  input: RecoveryRequest,
  requestId = crypto.randomUUID(),
  execution: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<RecoveryResult> {
  const referenceTime = recoveryReferenceTime(input);
  const referenceAt = new Date(referenceTime.at);
  const context = recoveryContext(input);
  const recoveryMode: RecoveryMode =
    context?.mode ?? "proximity_fallback";
  const warnings = context
    ? [
        "운영시간·경로·날씨는 선택한 조회 기준 시각에 맞춰 검증합니다. 공식 데이터는 요청할 때 조회한 정보이므로 예약 자체와 현장 안전을 보증하지 않으며, 출발 직전 운영기관 안내를 확인하세요.",
        ...(context.changeKind === "insert"
          ? [
              context.openWindow?.nextPlaceLabel
                ? `조회 기준 시각부터 비어 있는 시간에 한 곳을 더 넣는 추천입니다. 알려 주신 다음 장소 도착까지 실제 ${travelModeLabel(input.travelMode)} 경로로 검증했습니다.`
                : `조회 기준 시각부터 비어 있는 시간에 한 곳을 더 넣는 추천입니다. 다음 장소를 알려 주지 않으셨으므로 후보지에서 출발지로 돌아오는 실제 역방향 ${travelModeLabel(input.travelMode)} 경로를 별도로 조회했으며, 목적 유지 여부는 판단하지 않았습니다.`,
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
      radius: KTO_CANDIDATE_RADIUS_METERS,
      pageNo: 1,
      numOfRows: KTO_CANDIDATE_PAGE_SIZE,
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
  } catch (error) {
    sourceLedger.push(
      auditFromFailure("KorService2", "locationBasedList2", error),
    );
    return {
      requestId,
      referenceTime,
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

  sourceLedger.push(nearby.audit);
  const discoveredItems: KtoItem[] = [];
  const discoveredKeys = new Set<string>();
  const appendDiscoveryPage = (items: KtoItem[]) => {
    for (const item of items) {
      const key = candidateDiscoveryKey(item);
      if (discoveredKeys.has(key)) continue;
      discoveredKeys.add(key);
      discoveredItems.push(item);
    }
  };
  appendDiscoveryPage(nearby.items);

  const reportedTotal = Math.max(nearby.totalCount, nearby.items.length);
  const reportedPages = Math.max(
    1,
    Math.ceil(reportedTotal / KTO_CANDIDATE_PAGE_SIZE),
  );
  const pageLimit = Math.min(reportedPages, CANDIDATE_DISCOVERY_MAX_PAGES);
  let pagesFetched = 1;
  let expansionStoppedByDeadline = false;

  /* Page 1 is mandatory; pages 2+ are opportunistic. A later-page failure
     never erases the valid first page. No user-entered radius participates:
     20 km is the provider's documented endpoint maximum, not a rejection
     rule imposed by this product. */
  for (let pageNo = 2; pageNo <= pageLimit; pageNo += 1) {
    const deadlineAt = execution.deadlineAt ?? Date.now() + 18_000;
    const remainingMs = deadlineAt - Date.now();
    if (
      execution.signal?.aborted ||
      remainingMs <= CANDIDATE_DISCOVERY_RESERVE_MS
    ) {
      expansionStoppedByDeadline = true;
      break;
    }

    try {
      const page = await getNearbyTourism(
        {
          longitude: input.origin.longitude,
          latitude: input.origin.latitude,
          radius: KTO_CANDIDATE_RADIUS_METERS,
          pageNo,
          numOfRows: KTO_CANDIDATE_PAGE_SIZE,
        },
        {
          signal: execution.signal,
          timeoutMs: Math.min(
            CANDIDATE_EXPANSION_TIMEOUT_MS,
            remainingMs - CANDIDATE_DISCOVERY_RESERVE_MS,
          ),
          retry: false,
        },
      );
      sourceLedger.push(page.audit);
      pagesFetched = pageNo;
      appendDiscoveryPage(page.items);
      if (page.items.length < KTO_CANDIDATE_PAGE_SIZE) break;
    } catch (error) {
      sourceLedger.push(
        auditFromFailure("KorService2", "locationBasedList2", error),
      );
      warnings.push(
        "후보 추가 페이지를 불러오지 못해 이미 확인한 관광지만 검증했습니다.",
      );
      break;
    }
  }

  nearby = {
    ...nearby,
    items: discoveredItems,
    totalCount: reportedTotal,
  };
  warnings.push(
    "후보 탐색은 한국관광공사가 제공하는 관광정보의 최대 검색 범위 20km 안에서 수행합니다.",
  );
  if (
    expansionStoppedByDeadline ||
    reportedPages > CANDIDATE_DISCOVERY_MAX_PAGES ||
    pagesFetched < pageLimit
  ) {
    warnings.push(
      `공사 API가 알린 ${reportedTotal.toLocaleString("ko-KR")}건 중 중복을 제외한 ${discoveredItems.length.toLocaleString("ko-KR")}건을 응답 시간·호출량 예산 안에서 탐색했습니다.`,
    );
  }

  const firstCodes = nearby.items[0]
    ? normalizeAnalysisCodes(nearby.items[0])
    : {};
  const regionCode = input.origin.areaCode ?? firstCodes.regionCode;
  const districtCode = input.origin.sigunguCode ?? firstCodes.districtCode;

  /* 제거실험으로 끈 서비스는 호출하지 않는다. 호출해 놓고 결과만 버리면
     "API가 없으면 무엇이 깨지는가"를 보여 주는 것이 아니라 같은 호출량으로
     같은 답을 내는 것이 된다. */
  const disabled = new Set(input.disabledSources ?? []);
  const relatedPromise =
    regionCode && districtCode && !disabled.has("TarRlteTarService1")
      ? /* 기준월은 어댑터가 정한다. 여기서 직전 달을 못박으면 아직 발행되지
           않은 달로 고정되어, 어댑터의 하강 폴백이 "호출자가 지정한 달"로
           읽고 그 달만 조회한다. 실제로 그래서 연관 관광지가 계속 0건이었다. */
        getRelatedTourism(
          { regionCode, districtCode },
          { signal: execution.signal, timeoutMs: 4_000, retry: false },
        )
      : Promise.resolve(undefined);
  /* 집중률은 후보가 실제로 속한 시군구들로 조회한다.
     출발지 시군구 하나로만 조회하고 있었는데, 반경 8km 후보는 시군구 경계를
     넘나든다 — 서울시청 기준 실측에서 후보 100건이 중구 71 / 종로 29로 갈렸다.
     즉 어느 쪽을 출발지로 잡아도 약 30%의 후보는 조회 대상조차 아니었고,
     그 후보들은 실제 혼잡도와 무관하게 중립값을 받았다.

     후보 수가 많은 시군구부터 최대 3곳까지만 부른다. 20초 예산 안에서 병렬로
     돌리되 무한정 늘릴 수는 없고, 자른 사실은 아래에서 밝힌다. */
  const candidateDistricts = (() => {
    const counts = new Map<
      string,
      { regionCode: string; districtCode: string; count: number }
    >();
    for (const item of nearby.items) {
      const codes = normalizeAnalysisCodes(item);
      if (!codes.regionCode || !codes.districtCode) continue;
      const key = `${codes.regionCode}:${codes.districtCode}`;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else
        counts.set(key, {
          regionCode: codes.regionCode,
          districtCode: codes.districtCode,
          count: 1,
        });
    }
    /* 출발지 시군구는 후보가 적어도 포함한다 — 사용자가 서 있는 곳이다. */
    if (regionCode && districtCode) {
      const key = `${regionCode}:${districtCode}`;
      if (!counts.has(key)) {
        counts.set(key, { regionCode, districtCode, count: 0 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  })();
  const CROWD_DISTRICT_LIMIT = 3;
  const crowdDistricts = disabled.has("TatsCnctrRateService")
    ? []
    : candidateDistricts.slice(0, CROWD_DISTRICT_LIMIT);
  const crowdDistrictsSkipped = disabled.has("TatsCnctrRateService")
    ? 0
    : Math.max(candidateDistricts.length - crowdDistricts.length, 0);
  const crowdPromise = crowdDistricts.length
    ? Promise.allSettled(
        crowdDistricts.map((scope) =>
          getConcentrationForecast(scope, {
            signal: execution.signal,
            timeoutMs: 4_000,
            retry: false,
          }),
        ),
      )
    : Promise.resolve(undefined);
  const accessiblePromise =
    input.audience === "general" || disabled.has("KorWithService2")
      ? Promise.resolve(undefined)
      : getNearbyAccessibleTourism({
          longitude: input.origin.longitude,
          latitude: input.origin.latitude,
          radius: KTO_CANDIDATE_RADIUS_METERS,
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
  } else if (disabled.has("TarRlteTarService1")) {
    /* 제거실험으로 끈 호출을 오류로 적으면 안 된다. 실제로 그렇게 기록돼
       원장에 `error`로 남았고, 그 상태는 "공사 데이터 공백" 판정의 근거로도
       쓰이는 값이다. 요구되지 않았음을 사유와 함께 남긴다. */
    sourceLedger.push(
      notRequiredAudit(
        "TarRlteTarService1",
        "areaBasedList1",
        "DISABLED_FOR_ABLATION",
      ),
    );
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
  /* 시군구별 호출 결과를 합친다. 일부 시군구만 실패해도 나머지는 살린다 —
     하나가 실패하면 전부 버리는 편이 코드는 짧지만, 그러면 후보 대부분이
     이유 없이 중립값을 받는다. */
  const crowdOutcomes =
    crowdSettled.status === "fulfilled" && crowdSettled.value
      ? crowdSettled.value
      : [];
  const crowdSucceeded = crowdOutcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<KtoCallResult> =>
      outcome.status === "fulfilled",
  );
  const crowdFailedCount = crowdOutcomes.length - crowdSucceeded.length;
  if (crowdSucceeded.length) {
    crowdItems = crowdSucceeded.flatMap((outcome) => outcome.value.items);
    for (const outcome of crowdSucceeded) {
      sourceLedger.push(outcome.value.audit);
    }
    /* 상한을 넘어 잘렸으면 밝힌다. 조용히 잘리는 것이 원래 결함이었으므로
       같은 실패를 반복하지 않도록 사용자가 볼 수 있는 자리에 남긴다. */
    const truncatedScopes = crowdSucceeded.filter(
      (outcome) =>
        outcome.value.audit.totalCount > outcome.value.audit.resultCount,
    );
    if (truncatedScopes.length) {
      warnings.push(
        `관광 집중률 예측을 시군구 ${truncatedScopes.length}곳에서 일부만 받았습니다(응답 상한 ${CONCENTRATION_PAGE_SIZE.toLocaleString("ko-KR")}행). 받지 못한 관광지는 혼잡 근거 없이 중립으로 처리했습니다.`,
      );
    }
    if (crowdFailedCount) {
      warnings.push(
        `관광 집중률 예측을 시군구 ${crowdFailedCount}곳에서 조회하지 못했습니다. 그 지역 후보는 혼잡 근거 없이 중립으로 처리했습니다.`,
      );
      for (const outcome of crowdOutcomes) {
        if (outcome.status === "rejected") {
          sourceLedger.push(
            auditFromFailure(
              "TatsCnctrRateService",
              "tatsCnctrRatedList",
              outcome.reason,
            ),
          );
        }
      }
    }
    if (crowdDistrictsSkipped) {
      warnings.push(
        `후보가 시군구 ${candidateDistricts.length}곳에 걸쳐 있어 후보가 많은 ${crowdDistricts.length}곳만 집중률을 조회했습니다. 나머지 ${crowdDistrictsSkipped}곳 후보는 혼잡 근거 없이 중립으로 처리했습니다.`,
      );
    }
  } else if (disabled.has("TatsCnctrRateService")) {
    sourceLedger.push(
      notRequiredAudit(
        "TatsCnctrRateService",
        "tatsCnctrRatedList",
        "DISABLED_FOR_ABLATION",
      ),
    );
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
  } else if (disabled.has("KorWithService2")) {
    sourceLedger.push(
      notRequiredAudit(
        "KorWithService2",
        "locationBasedList2",
        "DISABLED_FOR_ABLATION",
      ),
    );
    warnings.push(
      "제거실험으로 무장애여행정보를 끈 요청입니다. 접근성 조건은 검증하지 않았습니다.",
    );
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
  const referenceWeather = weatherGlance(weatherEvidence, referenceAt, {
    preferForecast: referenceTime.mode === "assumed",
  })[0];
  const referenceWeatherShowsRain =
    (referenceWeather?.precipitationType !== undefined &&
      referenceWeather.precipitationType > 0) ||
    (referenceWeather?.precipitationProbabilityPercent ?? 0) >= 50;
  if (
    context &&
    input.incident === "rain" &&
    weatherEvidence?.status === "available" &&
    referenceWeather &&
    !referenceWeatherShowsRain
  ) {
    warnings.push(
      "조회 기준 시각의 자동 기상 확인에서는 강수가 감지되지 않았지만 사용자가 선택한 우천 상황을 우선 적용했습니다.",
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
    : new Map<string, RelatedMatch>();
  const forecasts = currentForecastByTitle(crowdItems, referenceAt);
  const accessibleIds = new Set(
    accessibleItems.map((item) => stringValue(item.contentid)).filter(Boolean),
  );
  const indoorRequired = indoorRequirement(input);

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

    const relatedRank = findRelatedMatch(relatedRanks, title, contentTypeId);
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
    /* 사전 걸러내기의 보수 추정. 자차는 직선거리를 도보 속도로 환산하면
       실제로 10분이면 닿는 후보가 "가용시간 초과"로 떨어진다. 수단별 속도로
       나눈다. 이 값은 걸러내기 전용이고, 살아남은 후보의 이동시간은 아래에서
       실제 경로로 다시 계산해 덮어쓴다. */
    const estimatedTravelMinutes =
      input.travelMode === "car"
        ? conservativeDrivingMinutes(distanceMeters)
        : input.travelMode === "bicycle"
          ? conservativeCyclingMinutes(distanceMeters)
          : input.travelMode === "transit"
            ? conservativeTransitMinutes(distanceMeters)
            : conservativeWalkingMinutes(distanceMeters);
    if (!context && estimatedTravelMinutes > input.availableMinutes) {
      rejected.push({
        contentId,
        title,
        reasonCode: "TIME_LIMIT",
        reason: `${travelModeLabel(input.travelMode)} 보수 추정 이동시간이 가용시간 ${input.availableMinutes}분을 초과합니다.`,
        distanceMeters,
        requiredRelaxation: {
          constraint: "available_time",
          amount: Math.ceil(estimatedTravelMinutes - input.availableMinutes),
          unit: "minutes",
          currentLimit: input.availableMinutes,
          requiredLimit: Math.ceil(estimatedTravelMinutes),
          description: `사용 가능한 시간 ${input.availableMinutes}분 → ${Math.ceil(estimatedTravelMinutes)}분`,
          preservesLockedNodes: false,
          preservesNextFixedAppointment: false,
        },
        verificationDepth: "pre_filter",
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
        /* 실측에서 가장 많은 탈락 사유였다. 숫자 한도가 아니라 켜고 끄는
           조건이므로 완화량은 "조건 1건 해제"다. 실내를 요구하지 않으면
           검토 대상이 된다는 사실 자체가 사용자에게 가장 실행 가능한
           정보인데, 예전에는 이것이 반사실 설명에 전혀 나타나지 않았다. */
        requiredRelaxation: {
          constraint: "indoor_requirement",
          amount: 1,
          unit: "condition",
          currentLimit: 1,
          requiredLimit: 0,
          description: "실내 필수 조건을 해제",
          preservesLockedNodes: false,
          preservesNextFixedAppointment: false,
        },
        verificationDepth: "pre_filter",
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

    const forecast = findForecastMatch(forecasts, title);
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
    }, referenceAt);
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
      crowdBasis: forecast ? ("place" as const) : undefined,
      crowdBaseDate: forecast?.baseDate,
      crowdPercentile: forecast?.percentileOfSeries,
      crowdSeriesDays: forecast?.seriesDays,
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

  /* 이웃 대체는 후보가 **모두 모인 뒤에** 해야 한다. 한 곳씩 처리하는
     동안에는 주변에 무엇이 있는지 알 수 없다. 값이 바뀌었으므로 점수도 다시
     매긴다 — 옛 점수로 정렬하면 대체값이 순위에 반영되지 않는다. */
  /* 지역 바닥값은 **원본 행**에서 뽑는다. `forecasts`는 오늘 값이 있는 곳만
     담는데, 부산 해운대구는 570행을 정상으로 받고도 그 맵이 비어 8건 모두
     빈칸이었다 — 시계열 창이 지역마다 다르다. 응답에 가장 최근으로 들어 있는
     날짜를 쓰면 한 줄이라도 온 지역은 반드시 값을 얻는다. */
  const withNeighbors = withNeighborCrowd(
    preliminary,
    districtRatesFrom(crowdItems),
  ).map((candidate) => ({
    ...candidate,
    ...scoreCandidate(candidate, input),
  }));
  preliminary.length = 0;
  preliminary.push(...withNeighbors);

  preliminary.sort(
    (a, b) => b.baseScore - a.baseScore || a.distanceMeters - b.distanceMeters,
  );

  const verificationPool = diversifyCandidatesByCategory(preliminary).slice(
    0,
    CONTINUITY_VERIFICATION_HARD_LIMIT,
  );

  /* 제거실험으로 무장애 정보를 끈 경우에는 상세 조회도 하지 않는다. 목록만
     끄고 상세는 호출하면 "무장애 정보 없이도 검증된다"는 잘못된 비교가 된다. */
  const { details, audits: detailAudits } = await accessibilityDetails(
    verificationPool,
    disabled.has("KorWithService2") ? "general" : input.audience,
    execution.signal,
    execution.deadlineAt,
  );
  sourceLedger.push(...detailAudits);

  const accessibilityVerified = verificationPool
    .map((candidate) => {
      const accessibility = evaluateAccessibility(
        input.audience,
        disabled.has("KorWithService2")
          ? undefined
          : details.get(candidate.contentId),
      );
      const withAccessibility = { ...candidate, accessibility };
      return {
        ...withAccessibility,
        ...scoreCandidate(withAccessibility, input),
      };
    })
    .map((candidate) => {
      if (input.audience === "general") return candidate;

      /* 앞 단계는 "주변 무장애 목록에 이 곳이 있는가"만 보고 공백을 붙인다.
         그 목록에 없더라도 `detailWithTour2`가 필수 동선을 확인해 주는 경우가
         있는데, 예전 구현은 공백을 지우지 않아 확인된 곳도 영구히 미확인으로
         남았다. 그러면 유아차·휠체어·고령자를 고른 여행자는 접근성이 실제로
         확인된 후보조차 적용할 수 없다. 상세 조회 결과가 최종 판정이다. */
      if (candidate.accessibility.status === "verified") {
        return {
          ...candidate,
          evidenceGaps: candidate.evidenceGaps.filter(
            (gap) => gap.code !== "ACCESSIBILITY_UNVERIFIED",
          ),
        };
      }

      /* Same three-tier rule as the earlier checks: a detail lookup that came
         back without accessibility fields records a gap, it does not delete
         the candidate. */
      if (
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
  /* 공식 분류를 순환해 최대 12곳을 검증한다. 각 후보는 실제 경로와 운영시간을
     모두 통과해야 하며, 20초 요청 신호가 끝나면 미검증 후보는 결과에 넣지 않는다. */
  const shortlist = diversifyCandidatesByCategory(
    accessibilityVerified,
  );
  if (Date.now() >= continuityDeadlineAt || execution.signal?.aborted) {
    warnings.push(
      "위기 순간 응답시간을 지키기 위해 상위 후보 검증을 중단했습니다. 확인하지 않은 후보를 결과처럼 표시하지 않았습니다.",
    );
  } else {
    /* 후보 지점의 예보를 따로 가져온다. 출발지 한 점의 예보를 모든 후보에
       재사용하면 시간상 도달 가능한 먼 후보의 실제 날씨가 달라도 놓친다.
       격자가 같은 후보는 한 번만 조회하며, 실패하면 출발지 예보로 물러서고
       그 사실을 밝힌다 — 다른 지점의 예보를 이 곳의 예보인 것처럼 쓰면 안 된다. */
    const gridWeather = new Map<
      string,
      Awaited<ReturnType<typeof getWeatherEvidence>>
    >();
    let candidateForecastFallbacks = 0;
    const gridKey = (candidate: WorkingCandidate) => {
      const { nx, ny } = toKmaGrid(candidate.latitude, candidate.longitude);
      return `${nx},${ny}`;
    };
    const originGrid = toKmaGrid(input.origin.latitude, input.origin.longitude);
    const distinctGrids = new Map<string, WorkingCandidate>();
    for (const candidate of shortlist) {
      const key = gridKey(candidate);
      if (key === `${originGrid.nx},${originGrid.ny}`) continue;
      if (!distinctGrids.has(key)) distinctGrids.set(key, candidate);
    }
    if (distinctGrids.size) {
      const fetched = await Promise.allSettled(
        [...distinctGrids.entries()].map(async ([key, candidate]) => {
          const evidence = await getWeatherEvidence(
            candidate.latitude,
            candidate.longitude,
            { signal: execution.signal },
          );
          return [key, evidence] as const;
        }),
      );
      for (const entry of fetched) {
        if (entry.status === "fulfilled") {
          gridWeather.set(entry.value[0], entry.value[1]);
        } else {
          candidateForecastFallbacks += 1;
        }
      }
    }
    if (candidateForecastFallbacks) {
      warnings.push(
        `후보 ${candidateForecastFallbacks}곳의 기상 예보를 따로 확인하지 못해 출발지 예보로 판단했습니다. 거리가 멀면 실제 날씨가 다를 수 있습니다.`,
      );
    }

    let attemptedCandidates = 0;
    for (
      let offset = 0;
      offset < shortlist.length &&
      continuityCandidates.length < CONTINUITY_RESULT_LIMIT;
      offset += CONTINUITY_VERIFICATION_BATCH_SIZE
    ) {
      if (
        execution.signal?.aborted ||
        continuityDeadlineAt - Date.now() <=
          CONTINUITY_VERIFICATION_RESERVE_MS
      ) {
        break;
      }

      /* Three matches the KTO client's measured safe concurrency. A failed
         route or closed venue therefore consumes only its own slot, and the
         next category-diversified batch is tried while time remains. */
      const batch = shortlist.slice(
        offset,
        offset + CONTINUITY_VERIFICATION_BATCH_SIZE,
      );
      attemptedCandidates += batch.length;
      const settled = await Promise.allSettled(
        batch.map((candidate) =>
          enrichForContinuity({
            candidate,
            input,
            context,
            sourceLedger,
            rejected,
            weatherEvidence:
              gridWeather.get(gridKey(candidate)) ?? weatherEvidence,
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

    if (
      attemptedCandidates < shortlist.length &&
      continuityCandidates.length < CONTINUITY_RESULT_LIMIT
    ) {
      warnings.push(
        `응답 시간 예산 안에서 ${attemptedCandidates}곳을 실제 경로·운영시간으로 검증했습니다. 검증하지 못한 후보는 결과처럼 표시하지 않았습니다.`,
      );
    }
  }

  const options = pickOptions(continuityCandidates, requestId, input).slice(
    0,
    CONTINUITY_RESULT_LIMIT,
  );
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
  const availabilityProviderBlocked = rejected.some(
    (candidate) =>
      candidate.reasonCode ===
      "OPERATING_STATUS_UPSTREAM_UNAVAILABLE",
  );
  /* A single failed detail lookup must not turn an otherwise completed
     recovery into a service-wide 503. The incident that exposed this had
     four successful discovery pages and six successful operating-detail
     responses; one transient NETWORK_ERROR nevertheless promoted all 202
     rejections to `upstream_unavailable`. Keep every unverified candidate
     fail-closed, but reserve 503 for the case where the operating-information
     provider did not answer any of the detail checks needed by this run. */
  const availabilityAudits = sourceLedger.filter(
    (audit) =>
      audit.apiName === "KorService2" &&
      audit.operation === "detailIntro2",
  );
  const availabilityProviderUnavailable =
    availabilityProviderBlocked &&
    availabilityAudits.some((audit) => audit.status === "error") &&
    !availabilityAudits.some(
      (audit) => audit.status === "live" || audit.status === "empty",
    );
  const availabilityPartiallyUnavailable =
    availabilityProviderBlocked && !availabilityProviderUnavailable;
  const status =
    options.length === 0
      ? availabilityProviderUnavailable
        ? "upstream_unavailable"
        : "no_valid_candidate"
      : hasSourceFailure || hasConditionalEvidence
        ? "degraded"
        : "verified";

  if (!options.length) {
    warnings.push(
      availabilityProviderUnavailable
        ? "공식 운영정보 제공자 장애로 후보의 실제 운영 여부를 확인하지 못했습니다. 데이터가 없다고 간주하지 않았으며, 검증 없이 장소를 추천하지 않습니다. 잠시 후 다시 시도해 주세요."
        : availabilityPartiallyUnavailable
          ? "일부 후보의 공식 운영정보를 일시적으로 확인하지 못해 해당 후보만 제외했습니다. 확인된 다른 후보는 계속 검증했으며, 검증 없이 장소를 추천하지 않습니다."
        : context?.nextFixed
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
    referenceTime,
    status,
    recoveryMode,
    itinerarySummary: summariseItinerary(context),
    /* 비교 기준 지점의 시점별 날씨. 일정 복구는 문제가 생긴 장소, 빈 시간
       추천은 현재 위치가 기준이다. 대안 카드의 같은 시점과 나란히 놓여야
       "여기가 나은가"를 판단할 수 있다. */
    originWeatherGlance: (() => {
      const glance = weatherGlance(weatherEvidence, referenceAt, {
        preferForecast: referenceTime.mode === "assumed",
      });
      return glance.length ? glance : undefined;
    })(),
    originWeatherLabel:
      context?.disrupted?.title ?? input.origin.label ?? "현재 위치",
    openWindowSummary: summariseOpenWindow(context),
    ablation: summariseAblation(input, options),
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
