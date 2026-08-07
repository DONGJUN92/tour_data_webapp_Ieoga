/* Types, constants and pure helpers lifted out of ProductApp.
   ProductApp had grown past four thousand lines, which made the remaining
   screen-by-screen migration hard to review. Nothing here holds state or
   renders — it is the data model and formatting layer only. */

import type { JourneyExecution } from "@/lib/recovery/execution";
import { statusLabel, statusTone } from "@/lib/text/status-labels";

export type TabId = "recover" | "discover" | "insights" | "transparency";
export type Incident = "rain" | "delay" | "crowd" | "less_walk";
/* `assisted`는 유아차·휠체어·고령자를 하나로 합친 값이다. 세 갈래로 물었지만
   판정은 두 갈래였고(휠체어와 고령자는 완전히 동일), 고르는 사람에게는 결과를
   바꾸지 않는 선택이 하나 더 있는 셈이었다. 예전 세 값은 저장된 일정을 계속
   읽기 위해 타입에 남긴다. */
export type Audience =
  | "general"
  | "assisted"
  | "stroller"
  | "wheelchair"
  | "senior";
export type LoadState = "idle" | "loading" | "success" | "error";
export type LocationMode = "unselected" | "automatic" | "manual";
export type RecoveryOutcome = "idle" | "applied" | "arrived" | "not_arrived";
export type Language = "ko" | "en";

export const GUIDE_STORAGE_KEY = "ieoga-simulation-guide-seen-v1";

export type JourneyStop = {
  id: string;
  time: string;
  type: "visit" | "reservation" | "meal" | "transit" | "stay" | "other";
  title: string;
  address: string;
  fixed: boolean;
  reservationCode: string;
  latitude?: number;
  longitude?: number;
  areaCode?: string;
  sigunguCode?: string;
};

export type JourneyPlan = {
  id: string;
  title: string;
  date: string;
  audience: Audience;
  stops: JourneyStop[];
  savedAt: string;
};

export type OpenWindowProof = {
  windowStartAt?: string;
  windowEndAt?: string;
  windowMinutes?: number;
  travelToMinutes: number;
  plannedStayMinutes?: number;
  appliedStayMinutes: number;
  returnMinutes: number;
  returnBasis: "next_place_route" | "same_route_reversed";
  leftoverMinutes: number;
  status?: "fits" | "at_risk";
};

export type ScheduleDiff = {
  mode?: string;
  changeKind?: "replace" | "insert";
  openWindow?: OpenWindowProof;
  replacementNode?: {
    id?: string;
    title?: string;
    startAt?: string;
    endAt?: string;
    durationMinutes?: number;
  };
  replacedNodeId?: string;
  changedNodeIds?: string[];
  unchangedNodeIds?: string[];
  lockedNodeIds?: string[];
  preservedLockedNodeIds?: string[];
  preservedCount?: number;
  changedCount?: number;
  changedNodeCount?: number;
  nextFixedStopPreserved?: boolean;
  nextFixedAppointmentPreserved?: boolean;
  nextFixedAppointment?: unknown;
  preservedWaypoints?: Array<{
    nodeId?: string;
    title?: string;
    scheduledAt?: string;
    estimatedArrivalAt?: string;
    arrivalBufferMinutes?: number;
    requiredBufferMinutes?: number;
    status?: string;
  }>;
  arrivalTime?: string;
  safetyBufferMinutes?: number;
  note?: string;
};

export type Counterfactual = {
  proofType?: string;
  /* 이 판정이 어디까지 확인된 것인가. `pre_filter`는 거리·시간만 비교한 단계라
     예약 보존을 주장할 수 없다. */
  verificationDepth?: "pre_filter" | "route_verified";
  title?: string;
  reason?: string;
  reasonCode?: string;
  distanceMeters?: number;
  requiredRelaxation?: {
    constraint?: string;
    amount?: number;
    unit?: string;
    currentLimit?: number;
    requiredLimit?: number;
    description?: string;
    preservesLockedNodes?: boolean;
    preservesNextFixedAppointment?: boolean;
  };
};

export type DataContribution = {
  source?: string;
  decision?: string;
  effect?: string;
  status?: string;
};

export type Region = {
  code: string;
  name: string;
  status?: string;
  coverage?: unknown;
  metrics?: Record<string, unknown>;
  sourceDate?: string;
};

export type District = {
  code: string;
  name: string;
};

export type PlaceSearchResult = {
  contentId?: string;
  contentTypeId?: string;
  provider?: "kto" | "kakao_local" | "forward_geocoder";
  providerId?: string;
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  areaCode?: string;
  sigunguCode?: string;
  sourceLabel?: string;
  externalUrl?: string;
  retention?: "persistable" | "ephemeral";
  matchScore?: number;
};

export type RecoveryOption = {
  id: string;
  strategyLabel?: string;
  strategyLabelEn?: string;
  evidenceGaps?: Array<{
    code?:
      | "INDOOR_UNVERIFIED"
      | "ACCESSIBILITY_UNVERIFIED"
      | "CONCENTRATION_UNVERIFIED"
      | string;
    note?: string;
    noteEn?: string;
  }>;
  confirmationRequired?: boolean;
  contentId?: string;
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  contentTypeId?: string;
  score?: number;
  distanceMeters?: number;
  estimatedTravelMinutes?: number;
  travelEstimate?: unknown;
  /* 경로 제공자가 돌려준 좌표열. 엔진이 이미 보내는데 화면에서 쓰지 않아
     "몇 분"만 보이고 그 길이 어디로 가는지 알 수 없었다. */
  routeGeometry?: Array<{ latitude: number; longitude: number }>;
  availability?: unknown;
  indoorSuitability?: unknown;
  accessibility?: unknown;
  /* 정렬 축으로 쓰려면 이 필드의 모양을 알아야 한다. `unknown`으로 두면
     제네릭 추론이 붕괴하고, 그때 나오는 오류는 원인을 찾기 어렵다.
     나머지 필드는 화면이 문자열로만 쓰므로 열어 둔다. */
  crowd?: {
    status?: string;
    relativeRate?: number;
    baseDate?: string;
    percentileOfSeries?: number;
    seriesDays?: number;
    /* 이 값이 이 장소를 직접 잰 것인지, 주변·시군구에서 빌려 온 것인지.
       정렬 가중치가 여기에 달려 있으므로 화면 타입에도 있어야 한다. */
    basis?: "place" | "nearby" | "district";
    level?: string;
    relatedRank?: number;
    note?: string;
    noteEn?: string;
  };
  /* 시점별 날씨(지금·1시간 후·2시간 후). 순위에는 쓰지 않는다. */
  weatherGlance?: Array<{
    hoursAhead: number;
    at: string;
    precipitationType?: number;
    skyCode?: number;
    precipitationProbabilityPercent?: number;
    temperatureCelsius?: number;
  }>;
  purposePreservation?: {
    status?: string;
    originalPurpose?: string;
    replacementPurpose?: string;
    originalStopTitle?: string;
    replacementTitle?: string;
    evidenceSource?: string;
    relatedRank?: number;
    statement?: string;
    statementEn?: string;
  };
  why?: string[];
  whyEn?: string[];
  sources?: unknown[];
  scheduleDiff?: ScheduleDiff;
  proof?: Record<string, unknown>;
  dataContributions?: DataContribution[];
  continuityProof?: Record<string, unknown>;
};

export type RecoveryResponse = {
  requestId: string;
  status: string;
  persistence: {
    status: "persisted" | "failed";
    runId?: string;
  };
  scope?: unknown;
  options: RecoveryOption[];
  /* 원래 가려던 곳(또는 현재 위치)의 시점별 날씨. 대안과 같은 시점으로 나란히
     비교하는 기준이다. */
  originWeatherGlance?: RecoveryOption["weatherGlance"];
  originWeatherLabel?: string;
  rejectedCount?: number;
  sourceLedger?: unknown[];
  warnings?: string[];
  generatedAt?: string;
  counterfactual?: Counterfactual;
  scheduleDiff?: ScheduleDiff;
  dataContributions?: DataContribution[];
  recoveryMode?: string;
  itinerarySummary?: Record<string, unknown>;
  ablation?: {
    disabledSources?: string[];
    lostCapabilities?: string[];
    verifiedOptionCount?: number;
    confirmationRequiredCount?: number;
    relatedEvidenceCount?: number;
    crowdEvidenceCount?: number;
    accessibilityVerifiedCount?: number;
  };
};

export type HealthResponse = {
  overall?: string;
  sources?: Record<string, unknown>[];
  checkedAt?: string;
  stale?: boolean;
};

export const INCIDENTS: { value: Incident; title: string; description: string; marker: string }[] = [
  {
    value: "rain",
    title: "비·기상 변화",
    description: "실내 중심으로 바꾸되 원래 여행의 관심사는 최대한 유지합니다.",
    marker: "비",
  },
  {
    value: "delay",
    title: "일정 지연",
    description: "남은 시간 안에 다음 고정 일정으로 복귀할 수 있는 후보만 찾습니다.",
    marker: "시",
  },
  {
    value: "crowd",
    title: "혼잡 회피",
    description: "연관성은 지키면서 상대적으로 분산된 대안을 우선 검토합니다.",
    marker: "혼",
  },
  {
    value: "less_walk",
    title: "이동 부담 감소",
    description: "이동거리와 접근성 확인 여부를 가장 크게 반영해 정렬합니다.",
    marker: "쉼",
  },
];

export const INCIDENTS_EN: Record<Incident, { title: string; description: string }> = {
  rain: {
    title: "Weather change",
    description: "Switch the disrupted segment indoors while preserving the original interest.",
  },
  delay: {
    title: "Schedule delay",
    description: "Keep only options that can return you to the next fixed appointment.",
  },
  crowd: {
    title: "Avoid crowds",
    description: "Prioritize a less concentrated option with a similar travel purpose.",
  },
  less_walk: {
    title: "Reduce mobility burden",
    description: "Ranks by travel distance and confirmed accessibility first.",
  },
};

/* 이동수단은 두 화면이 같은 목록을 써야 한다. 화면마다 따로 두면 한쪽에만 수단이
   추가되어 같은 엔진이 다른 선택지를 받게 된다.

   확인된 국내 제공자가 있는 수단만 둔다. 2026-08-04 실호출 결과:
   - 도보·자차: TMAP. 같은 `TMAP_APP_KEY`로 동작한다.
   - 대중교통·자전거: 카카오맵 `dapi.kakao.com/v2/routing/publictraffic`·`/bicycle`.
     `KAKAO_REST_API_KEY`로 동작하고, 자전거는 `via`로 경유지 구간이 갈린다.
   (카카오 *내비* API `apis-navi.kakaomobility.com`은 자동차 전용이어서 여기 쓰지
   않는다. 유효 priority가 RECOMMEND·TIME·DISTANCE뿐이고 대중교통·자전거 경로는
   404다. 처음 그 호스트만 확인해 두 수단이 불가능하다고 잘못 판단했다.)

   반경·거리 상한은 수단별로 다르다. 도보 기준을 그대로 쓰면 차나 지하철로 20분이면
   닿는 곳이 후보에 들어오지도 않는다. */
export const TRAVEL_MODES = [
  {
    value: "walk",
    ko: "걸어서",
    en: "Walking",
    radius: 8_000,
    distance: 5_000,
  },
  {
    value: "transit",
    ko: "대중교통",
    en: "Transit",
    radius: 20_000,
    distance: 20_000,
  },
  {
    value: "bicycle",
    ko: "자전거",
    en: "Bicycle",
    radius: 15_000,
    distance: 12_000,
  },
  {
    value: "car",
    ko: "자차·택시",
    en: "By car",
    radius: 20_000,
    distance: 20_000,
  },
] as const;

export type TravelMode = (typeof TRAVEL_MODES)[number]["value"];

/* 제거실험으로 끌 수 있는 공사 서비스와, 끄면 사라지는 판정 근거. 후보 수만
   비교하면 "별 차이 없다"로 읽히므로 무엇을 잃는지 화면이 먼저 말한다. */
export const ABLATION_SOURCES = [
  {
    id: "TarRlteTarService1",
    label: "관광지 연관관계",
    lost: "원래 일정과 함께 방문된 기록이 사라져, 의도 보존 근거와 세 번째 카드의 축이 없어집니다.",
  },
  {
    id: "TatsCnctrRateService",
    label: "관광지 집중률",
    lost: "향후 집중률 예측이 사라져 혼잡 회피 판정과 순위 보정을 할 수 없습니다.",
  },
  {
    id: "KorWithService2",
    label: "무장애 관광정보",
    lost: "유아차·휠체어·고령자 편의정보 검증이 사라져 모든 후보가 접근성 미확인이 됩니다.",
  },
] as const;

/* 화면에는 켜고 끄는 하나만 남긴다. 세 갈래로 물어도 판정이 갈리지 않으므로
   고르는 수고만 늘리는 선택이었다. */
export const AUDIENCES: { value: Audience; label: string }[] = [
  { value: "general", label: "일반 여행" },
  { value: "assisted", label: "이동 도움이 필요해요" },
];

export const AUDIENCES_EN: Record<Audience, string> = {
  general: "General travel",
  assisted: "Someone needs step-free access",
  stroller: "With a stroller",
  wheelchair: "Wheelchair user",
  senior: "With a senior traveler",
};

export const OPEN_APIS = [
  { id: "KorService2", label: "국문 관광정보", use: "전국 관광지·좌표·상세정보" },
  { id: "TarRlteTarService1", label: "관광지 연관관계", use: "원래 여행 의도와 가까운 대안" },
  { id: "TatsCnctrRateService", label: "관광지 집중률", use: "혼잡·집중 위험 보조 판단" },
  { id: "KorWithService2", label: "무장애 관광정보", use: "접근성 조건 검증" },
  { id: "LocgoHubTarService1", label: "지역 관광 허브", use: "지역 내 대체 거점 탐색" },
  { id: "AreaTarDemDsService", label: "지역별 관광 수요", use: "지역 수요 구조 진단" },
  { id: "AreaTarResDemService", label: "지역별 관광 자원 수요", use: "관광 자원 수요 공백 진단" },
  { id: "AreaTarDivService", label: "지역 관광 다양성", use: "콘텐츠 편중·공백 진단" },
];

export const POLICY_APIS = OPEN_APIS.slice(4);
/* 주소에서 시·군 단위를 뽑는다.
 *
 * 앞 두 토막을 그대로 쓰면 `대전광역시 서구`와 `대전광역시 유성구`가 다른
 * 지역으로 갈린다. 같은 대전 안에서 구만 다른 것을 "다른 지역이니 기존 일정을
 * 지울까요"라고 묻는 것은 말이 안 된다.
 *
 * 광역시·특별시·특별자치시는 그 자체가 단위다. 도는 그 아래 시·군이 단위다
 * (`경기도 수원시` → `수원시`, `강원특별자치도 양양군` → `양양군`). */
const WIDE_CITY = /(특별시|광역시|특별자치시)$/u;
const PROVINCE = /(^|[가-힣])도$|특별자치도$/u;
const CITY_OR_COUNTY = /(시|군)$/u;

export function administrativeUnit(address: string): string {
  const tokens = address.trim().split(/\s+/u).filter(Boolean);
  for (const [index, token] of tokens.entries()) {
    if (WIDE_CITY.test(token)) return token;
    if (PROVINCE.test(token)) {
      /* 도 다음에 오는 시·군을 찾는다. `경기도 성남시 분당구`에서 `분당구`가
         아니라 `성남시`를 잡아야 한다. */
      const next = tokens.slice(index + 1).find((entry) => CITY_OR_COUNTY.test(entry));
      if (next) return next;
    }
  }
  /* 도 표기를 생략한 주소도 흔하다. */
  return tokens.find((token) => CITY_OR_COUNTY.test(token)) ?? "";
}

export function sameAdministrativeArea(left: string, right: string): boolean {
  const a = administrativeUnit(left);
  const b = administrativeUnit(right);
  return Boolean(a) && a === b;
}

export function makeStop(overrides: Partial<JourneyStop> = {}): JourneyStop {
  return {
    id: crypto.randomUUID(),
    time: "",
    type: "visit",
    title: "",
    address: "",
    fixed: false,
    reservationCode: "",
    ...overrides,
  };
}

export function stopTypeFromTourismContent(
  contentTypeId?: string,
): JourneyStop["type"] {
  if (contentTypeId === "39") return "meal";
  if (contentTypeId === "32") return "stay";
  return "visit";
}

export function emptyJourneyDraft(): JourneyPlan {
  return {
    id: "new-journey",
    title: "오늘의 여행",
    date: todayInKorea(),
    audience: "general",
    stops: [
      makeStop({ id: "initial-stop-1" }),
      makeStop({ id: "initial-stop-2", type: "reservation", fixed: true }),
    ],
    savedAt: "",
  };
}

export function todayInKorea(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export const MIN_APPOINTMENT_MINUTES = 15;
export const MAX_APPOINTMENT_MINUTES = 24 * 60;

export function appointmentAfterMinutesInKorea(
  now: Date,
  minutes: number,
): { date: string; time: string } {
  const target = new Date(now.getTime() + minutes * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(target);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function appointmentMinutesFromNow(
  date: string,
  time: string,
  nowMs = Date.now(),
): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
  ) {
    return null;
  }
  const target = Date.parse(`${date}T${time}:00+09:00`);
  if (!Number.isFinite(target) || !Number.isFinite(nowMs)) return null;

  /* Date.parse normalises impossible calendar dates (for example 02-30)
     instead of rejecting them. Round-trip through KST so a malformed value
     can never become a different, apparently valid appointment. */
  const normalized = appointmentAfterMinutesInKorea(new Date(target), 0);
  if (normalized.date !== date || normalized.time !== time) return null;

  return Math.floor((target - nowMs) / 60_000);
}

export function parseKoreaCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (typeof value !== "string" && typeof value !== "number")
  ) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

export function practiceJourneySchedule(): {
  date: string;
  firstTime: string;
  fixedTime: string;
} {
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    nowParts.map((part) => [part.type, part.value]),
  );
  const currentMinutes = Number(values.hour) * 60 + Number(values.minute);
  const formatMinutes = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
      minutes % 60,
    ).padStart(2, "0")}`;

  if (currentMinutes <= 19 * 60) {
    return {
      date: `${values.year}-${values.month}-${values.day}`,
      firstTime: formatMinutes(currentMinutes + 45),
      fixedTime: formatMinutes(currentMinutes + 165),
    };
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(tomorrow);
  const tomorrowValues = Object.fromEntries(
    tomorrowParts.map((part) => [part.type, part.value]),
  );
  return {
    date: `${tomorrowValues.year}-${tomorrowValues.month}-${tomorrowValues.day}`,
    firstTime: "10:00",
    fixedTime: "12:00",
  };
}

export function minutesUntil(date: string, time: string): number | null {
  return appointmentMinutesFromNow(date, time);
}

export function formatStopTime(time: string): string {
  if (!time) return "시간 미정";
  const [hour, minute] = time.split(":");
  const numericHour = Number(hour);
  if (!Number.isFinite(numericHour)) return time;
  return `${numericHour < 12 ? "오전" : "오후"} ${numericHour % 12 || 12}:${minute}`;
}

export function inferRecoveryContext(plan: JourneyPlan): {
  affectedStopId: string;
  nextFixedStopId: string;
} {
  const nowParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(
    nowParts.find((part) => part.type === "hour")?.value ?? 0,
  );
  const minute = Number(
    nowParts.find((part) => part.type === "minute")?.value ?? 0,
  );
  const currentMinutes = hour * 60 + minute;
  const sameDay = plan.date === todayInKorea();
  const toMinutes = (value: string) => {
    const [stopHour, stopMinute] = value.split(":").map(Number);
    return stopHour * 60 + stopMinute;
  };
  const eligible = plan.stops.flatMap((stop, index) => {
    if (stop.fixed || stop.type === "reservation") return [];
    const nextFixed = plan.stops
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.fixed || candidate.type === "reservation",
      );
    return nextFixed ? [{ stop, index, nextFixed }] : [];
  });
  const current =
    [...eligible]
      .reverse()
      .find(
        ({ stop }) =>
          !sameDay ||
          !stop.time ||
          toMinutes(stop.time) <= currentMinutes,
      ) ?? eligible[0];
  return {
    affectedStopId: current?.stop.id ?? plan.stops[0]?.id ?? "",
    nextFixedStopId: current?.nextFixed.id ?? "",
  };
}

export function formatIsoTime(value?: string): string {
  if (!value) return "도착 시각 확인";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function dateTimePartsInKorea(
  value: string,
): { date: string; time: string } | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = valueOf("year");
  const month = valueOf("month");
  const day = valueOf("day");
  const hour = valueOf("hour");
  const minute = valueOf("minute");
  return year && month && day && hour && minute
    ? { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` }
    : null;
}

export function normalizeJourneyPlan(payload: unknown): JourneyPlan | null {
  const root = asRecord(payload);
  const itinerary =
    asRecord(root?.itinerary) ??
    asRecord(root?.current) ??
    asRecord(asRecord(root?.data)?.itinerary) ??
    root;
  const nodes = Array.isArray(itinerary?.nodes) ? itinerary.nodes : [];
  if (!itinerary || nodes.length < 2) return null;
  const stops = nodes.flatMap((entry, index): JourneyStop[] => {
    const node = asRecord(entry);
    const title = readText(node, ["title", "name"]);
    if (!node || !title) return [];
    const startAt = readText(node, ["startAt"]);
    const location = asRecord(node.location);
    const rawType = readText(node, ["type"]);
    const type: JourneyStop["type"] = [
      "visit",
      "reservation",
      "meal",
      "transit",
      "stay",
      "other",
    ].includes(rawType)
      ? (rawType as JourneyStop["type"])
      : "visit";
    const latitude =
      typeof location?.latitude === "number"
        ? location.latitude
        : typeof location?.latitude === "string" &&
            location.latitude.trim() !== ""
          ? Number(location.latitude)
          : Number.NaN;
    const longitude =
      typeof location?.longitude === "number"
        ? location.longitude
        : typeof location?.longitude === "string" &&
            location.longitude.trim() !== ""
          ? Number(location.longitude)
          : Number.NaN;
    const kstParts = dateTimePartsInKorea(startAt);
    return [
      {
        id: readText(node, ["id"]) || `stored-stop-${index}`,
        time: kstParts?.time ?? startAt.match(/T(\d{2}:\d{2})/)?.[1] ?? "",
        type,
        title,
        address: readText(location, ["label", "address"]),
        fixed: Boolean(node.locked ?? node.reservation),
        reservationCode: node.reservation ? "예약 있음" : "",
        latitude: Number.isFinite(latitude) ? latitude : undefined,
        longitude: Number.isFinite(longitude) ? longitude : undefined,
        areaCode: readText(location, ["areaCode"]) || undefined,
        sigunguCode: readText(location, ["sigunguCode"]) || undefined,
      },
    ];
  });
  if (stops.length < 2) return null;
  const firstStart = readText(asRecord(nodes[0]), ["startAt"]);
  const firstStartKst = dateTimePartsInKorea(firstStart);
  return {
    id: readText(itinerary, ["id"]) || "stored-journey",
    title: readText(itinerary, ["title"]) || "나의 여행",
    date:
      firstStartKst?.date ??
      firstStart.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ??
      "",
    audience:
      AUDIENCES.some((item) => item.value === itinerary.audience)
        ? (itinerary.audience as Audience)
        : "general",
    stops,
    savedAt: readText(itinerary, ["updatedAt", "createdAt", "savedAt"]) || "",
  };
}

export function normalizeJourneyExecution(payload: unknown): JourneyExecution | null {
  const root = asRecord(payload);
  const execution =
    asRecord(root?.execution) ??
    asRecord(asRecord(root?.data)?.execution) ??
    root;
  if (
    !execution ||
    typeof execution.id !== "string" ||
    !Array.isArray(execution.steps)
  ) {
    return null;
  }
  return execution as unknown as JourneyExecution;
}

export function itineraryNodeStart(date: string, time: string): string | undefined {
  if (!date || !time) return undefined;
  return `${date}T${time}:00+09:00`;
}

export function itineraryContract(
  plan: JourneyPlan,
  disruptedNodeId?: string,
  nextFixedNodeId?: string,
) {
  return {
    id: plan.id === "new-journey" ? undefined : plan.id,
    title: plan.title,
    timezone: "Asia/Seoul",
    audience: plan.audience,
    occurredAt: new Date().toISOString(),
    disruptedNodeId: disruptedNodeId ?? plan.stops.find((stop) => !stop.fixed)?.id ?? plan.stops[0]?.id,
    nextFixedNodeId: nextFixedNodeId || undefined,
    nodes: plan.stops.map((stop, index) => ({
      id: stop.id,
      sequence: index + 1,
      type: stop.type,
      title: stop.title,
      startAt: itineraryNodeStart(plan.date, stop.time),
      locked: stop.fixed,
      reservation: stop.type === "reservation" || Boolean(stop.reservationCode),
      location:
        typeof stop.latitude === "number" && typeof stop.longitude === "number"
          ? {
              latitude: stop.latitude,
              longitude: stop.longitude,
              label: stop.address || stop.title,
              areaCode: stop.areaCode,
              sigunguCode: stop.sigunguCode,
            }
          : undefined,
    })),
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readText(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

export function pickArray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  for (const key of keys) {
    if (Array.isArray(root?.[key])) return root[key] as unknown[];
    if (Array.isArray(data?.[key])) return data[key] as unknown[];
  }
  if (Array.isArray(root?.items)) return root.items as unknown[];
  if (Array.isArray(data?.items)) return data.items as unknown[];
  return [];
}

export function normalizeRegions(payload: unknown): Region[] {
  return pickArray(payload, ["regions", "areas"]).flatMap((item) => {
    const row = asRecord(item);
    const code = readText(row, ["code", "areaCode", "lDongRegnCd"]);
    const name = readText(row, ["name", "areaName", "lDongRegnNm"]);
    if (!code || !name) return [];
    return [
      {
        code,
        name,
        status: readText(row, ["status"]) || undefined,
        coverage: row?.coverage,
        metrics: asRecord(row?.metrics) ?? undefined,
        sourceDate: readText(row, ["sourceDate", "updatedAt"]) || undefined,
      },
    ];
  });
}

export function normalizeDistricts(payload: unknown): District[] {
  return pickArray(payload, ["districts", "sigungu", "areas"]).flatMap((item) => {
    const row = asRecord(item);
    const code = readText(row, ["code", "sigunguCode", "lDongSignguCd"]);
    const name = readText(row, ["name", "sigunguName", "lDongSignguNm"]);
    return code && name ? [{ code, name }] : [];
  });
}

export function normalizePlaceResults(payload: unknown): PlaceSearchResult[] {
  return pickArray(payload, [
    "places",
    "items",
    "results",
    "candidates",
  ]).flatMap((item): PlaceSearchResult[] => {
    const row = asRecord(item);
    const title = readText(row, ["title", "name"]);
    const latitude = Number(row?.latitude ?? row?.mapY);
    const longitude = Number(row?.longitude ?? row?.mapX);
    if (
      !title ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return [];
    }
    const provider = readText(row, ["provider"]);
    const retention = readText(row, ["retention"]);
    return [
      {
        contentId: readText(row, ["contentId", "id"]) || undefined,
        contentTypeId:
          readText(row, ["contentTypeId", "contenttypeid"]) || undefined,
        provider: ["kto", "kakao_local", "forward_geocoder"].includes(
          provider,
        )
          ? (provider as PlaceSearchResult["provider"])
          : undefined,
        providerId: readText(row, ["providerId"]) || undefined,
        title,
        address: readText(row, ["address", "addr1"]) || undefined,
        latitude,
        longitude,
        areaCode:
          readText(row, ["regionCode", "areaCode"]) || undefined,
        sigunguCode:
          readText(row, ["districtCode", "sigunguCode"]) || undefined,
        sourceLabel: readText(row, ["sourceLabel"]) || undefined,
        externalUrl: readText(row, ["externalUrl"]) || undefined,
        retention:
          retention === "persistable" || retention === "ephemeral"
            ? retention
            : undefined,
        matchScore:
          typeof row?.matchScore === "number"
            ? row.matchScore
            : undefined,
      },
    ];
  });
}

/* 상태 코드는 공용 라벨 사전을 통해서만 화면으로 나간다. 예전 구현은
   화이트리스트에 없는 값을 `String(value)`로 흘려보내 `confirmed_open`,
   `bounded` 같은 내부 코드가 사용자에게 노출됐다. */
export function humanizeStatus(
  value: unknown,
  language: Language = "ko",
): string {
  return statusLabel(value, language);
}

export { statusTone };

export function compactValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "확인되지 않음";
  if (typeof value === "boolean") return value ? "확인" : "미확인";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("ko-KR") : value.toFixed(1);
  if (typeof value === "string") {
    // 이미 사람이 읽는 문장이면 그대로, 내부 코드(snake_case 등)면 라벨로.
    return /[가-힣]/.test(value) ? value : statusLabel(value);
  }
  if (Array.isArray(value)) {
    const texts = value.map((entry) => compactValue(entry)).filter(Boolean);
    return texts.slice(0, 3).join(", ") || "확인되지 않음";
  }
  const record = asRecord(value);
  if (!record) return "확인되지 않음";
  const preferred = readText(record, ["label", "status", "name", "value", "description", "reason"]);
  if (preferred) return humanizeStatus(preferred);
  const first = Object.values(record).find(
    (entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
  return first === undefined ? "확인되지 않음" : compactValue(first);
}

export function formatMetricLabel(key: string): string {
  const known: Record<string, string> = {
    resilienceScore: "회복 준비도",
    coverage: "데이터 커버리지",
    contentCoverage: "콘텐츠 커버리지",
    dataCoverage: "데이터 충족도",
    demand: "관광 수요",
    diversity: "관광 다양성",
    stayDemand: "체류 수요",
    candidateCount: "대안 후보",
    poiCount: "관광 콘텐츠",
    updatedAt: "갱신 시각",
    sourceDate: "기준일",
  };
  if (known[key]) return known[key];
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

export function formatCoverage(value: unknown): string {
  if (typeof value === "number") return value <= 1 ? `${Math.round(value * 100)}%` : `${Math.round(value)}%`;
  return compactValue(value);
}

/* 화면 전체가 같은 날짜 표기를 쓰도록 여기 한 곳에서만 만든다. 예전에는
   `2026-08-03`, `2026. 8. 3. 오전 10:48`, `202606`, `2026년 06월 기준`이
   같은 화면에 섞여 나왔다. */
export function formatDate(value?: string): string {
  if (!value) return "기준일 미제공";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** 시각 없이 날짜만. 예: 2026년 8월 3일 */
export function formatDayOnly(value?: string): string {
  if (!value) return "기준일 미제공";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${year}년 ${Number(month)}월 ${Number(day)}일`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/** 기준월(`202606`)·기준일(`20260603`)처럼 자릿수만 있는 값도 문장으로 만든다. */
export function formatReferenceDate(value?: string): string {
  if (!value) return "기준일 미제공";
  if (/^\d{6}$/.test(value)) {
    return `${value.slice(0, 4)}년 ${Number(value.slice(4, 6))}월`;
  }
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}년 ${Number(value.slice(4, 6))}월 ${Number(value.slice(6, 8))}일`;
  }
  return formatDayOnly(value);
}

/* 붐빔 정도를 아이콘 한 개와 단어 하나로.
   `예측지수 39.0`은 여행자가 해석할 수 없는 숫자였다 — 39가 높은지 낮은지
   알려면 다른 곳의 값과 비교해야 하는데 그 비교는 우리가 이미 했다.
   색만으로 뜻을 나르지 않도록 아이콘 옆에 항상 단어를 붙인다. */
const CROWD_LEVELS: Record<string, { icon: string; ko: string; en: string }> = {
  easy: { icon: "🟢", ko: "원활", en: "Quiet" },
  normal: { icon: "🟡", ko: "보통", en: "Average" },
  busy: { icon: "🔴", ko: "혼잡", en: "Busy" },
};

export function crowdLevelBadge(
  value: unknown,
  language: "ko" | "en" = "ko",
): { icon: string; label: string } | undefined {
  const record = asRecord(value);
  const level = typeof record?.level === "string" ? record.level : undefined;
  const entry = level ? CROWD_LEVELS[level] : undefined;
  if (!entry) return undefined;
  return { icon: entry.icon, label: language === "en" ? entry.en : entry.ko };
}

/* 붐빔 표시는 **한 함수만 쓴다.** 두 화면이 따로 적어 두었더니 갈라졌다:
   `FlowApp`은 `note`를 읽어 `🟡 보통 (주변 기준)`을 냈는데, 이 함수는
   `CROWD_LEVELS` 라벨만 써서 꼬리표를 통째로 버렸다 — 주변에서 빌려 온 값이
   그 장소를 직접 잰 값처럼 보였다. 인기 순위(`popularity_rank`)는 `level`이
   없어 `compactValue`로 떨어졌고, 매핑에 없는 코드라 **"확인 중"**이 나왔다.
   값을 갖고 있으면서 확인 중이라고 적는 것은 사실이 아니다. */
export function formatCrowd(value: unknown, language: "ko" | "en" = "ko"): string {
  const record = asRecord(value);
  const note =
    (language === "en"
      ? typeof record?.noteEn === "string"
        ? record.noteEn
        : undefined
      : undefined) ??
    (typeof record?.note === "string" ? record.note : undefined) ??
    "";
  /* 인기 순위는 붐빔과 다른 축이다. 신호등을 쓰면 초록을 "지금 한산하다"로
     읽는데 실제로는 월 단위 인기 집계다. */
  if (record?.status === "popularity_rank") return note ? `⭐ ${note}` : "";
  const badge = crowdLevelBadge(value, language);
  if (badge) return `${badge.icon} ${note || badge.label}`;
  return note || compactValue(value);
}

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const record = asRecord(payload);
    const nestedError = asRecord(record?.error);
    const message =
      readText(nestedError, ["message", "detail"]) ||
      readText(record, ["message", "detail"]) ||
      `요청에 실패했습니다. (${response.status})`;
    const requestId =
      response.headers.get("x-request-id") ||
      readText(record, ["requestId"]) ||
      readText(nestedError, ["requestId"]);
    throw new Error(
      requestId && !message.includes(requestId)
        ? `${message} · Request ID ${requestId}`
        : message,
    );
  }
  return payload;
}

export function sourceName(source: unknown): string {
  const record = asRecord(source);
  return readText(record, ["name", "source", "api", "apiName", "service", "id"]) || compactValue(source);
}

export function sourceStatus(source: unknown): string {
  const record = asRecord(source);
  return readText(record, ["status", "result", "availability"]) || "사용";
}

export function sourceDecisionEffect(source: unknown): string {
  const name = sourceName(source);
  if (name.includes("KorService2")) return "공식 장소·좌표·운영 근거를 확인";
  if (name.includes("TarRlteTarService1")) return "원래 일정의 관광 목적과 연결성 비교";
  if (name.includes("TatsCnctrRateService")) return "혼잡 상황에서 집중도가 높은 후보 제외";
  if (name.includes("KorWithService2")) return "유아차·휠체어·고령자 접근 조건 확인";
  if (name.includes("LocgoHubTarService1")) return "지역 내 대체 관광 거점 확인";
  if (name.includes("AreaTarDemDsService")) return "지역 수요 맥락으로 대안 지속 가능성 보조";
  if (name.includes("AreaTarResDemService")) return "지역 관광 자원 수요 공백 확인";
  if (name.includes("AreaTarDivService")) return "지역 콘텐츠 편중과 대안 다양성 확인";
  return "이 복구안의 조건 판정에 사용";
}

/* 대안 목록의 정렬 축.
 *
 * 집중률을 점수 안에 24% 가중치로 녹여 두면 사용자는 왜 이 순서인지 알 수 없고
 * 되돌릴 수도 없다. 심사에서도 확인할 방법이 없다. 정렬 축으로 빼면 그 축을 고른
 * 행위가 곧 동의가 되고, 순서가 바뀌는 것이 눈에 보인다.
 *
 * 방향을 둘 다 두는 이유: 붐빔을 피하려는 여행자와 활기를 찾는 여행자가 모두
 * 있다. 라벨에 방향을 적어 두면 어느 쪽도 오해하지 않는다. */
export const OPTION_SORTS = [
  {
    value: "recommended",
    ko: "추천순",
    en: "Recommended",
    hint: "검증 결과를 종합한 기본 순서입니다.",
    hintEn: "The default order from all verified evidence.",
  },
  {
    value: "quiet_first",
    ko: "한적한 순",
    en: "Quietest first",
    hint: "집중률 예측이 낮은 곳부터 봅니다.",
    hintEn: "Lowest predicted crowding first.",
  },
  {
    value: "busy_first",
    ko: "붐비는 순",
    en: "Busiest first",
    hint: "집중률 예측이 높은 곳부터 봅니다.",
    hintEn: "Highest predicted crowding first.",
  },
  {
    value: "nearest_first",
    ko: "가까운 순",
    en: "Nearest first",
    hint: "현재 위치에서 가까운 곳부터 봅니다. 직선거리가 아니라 실제 경로 거리입니다.",
    hintEn: "Closest first, by the actual routed distance.",
  },
  {
    value: "open_first",
    ko: "운영 여부",
    en: "Open now first",
    hint: "지금 열려 있다고 확인된 곳부터 봅니다. 확인하지 못한 곳이 그다음이고, 닫힌 곳은 마지막입니다.",
    hintEn: "Confirmed open first, unconfirmed next, closed last.",
  },
] as const;

export type OptionSort = (typeof OPTION_SORTS)[number]["value"];

/* 정렬 결과를 두 묶음으로 나눈다.
 *
 * 측정하면 집중률 예측을 가진 후보는 유형별로 25~36%(관광지), 0%(음식점·레포츠)
 * 수준이다. 즉 값이 없는 후보가 다수다. 그것을 중립값으로 한 목록에 섞으면
 * "왜 이 위치인가"를 설명할 수 없고, 예전에 신뢰를 깎았던 라벨 모순과 같은
 * 종류의 문제가 된다. 값이 있는 것끼리 정렬하고, 없는 것은 이유를 적어 따로
 * 내린다. */
export type SortedOptionGroups<T> = {
  ranked: T[];
  /* 집중률 예측이 없어 이 축으로 줄 세울 수 없는 후보. */
  unranked: T[];
};

/* 운영 여부의 순서. 낮은 값이 먼저 온다.
   `confirmed_open`이 가장 쓸모 있고, 확인하지 못한 곳이 그다음, 닫힌 곳이
   마지막이다. 닫힌 곳도 **지우지 않는다** — 30분 뒤에 열릴 수도 있고, 근처에
   있다는 사실 자체가 판단에 쓰인다. */
const AVAILABILITY_ORDER: Record<string, number> = {
  confirmed_open: 0,
  official_hours_unstructured: 1,
  unknown: 2,
  confirmed_closed: 3,
};

function availabilityRank(option: RecoveryOption): number {
  const status =
    typeof option.availability === "object" && option.availability
      ? (option.availability as { status?: string }).status
      : undefined;
  return AVAILABILITY_ORDER[status ?? "unknown"] ?? 2;
}

/* 카드 목록 정렬. 화면 셋(여행 복구·등록 없이 찾기·시간이 비었어요)이 같은
   축을 쓰므로 함수도 하나만 둔다. `FlowApp`이 자기 것을 따로 갖고 있었을 때
   `basis` 가중치가 빠져 빌려 온 붐빔 값이 직접 잰 값과 똑같이 겨뤘다. */
export type SimpleOptionSort =
  | "recommended"
  | "nearest_first"
  | "quiet_first"
  | "busy_first";

export function sortSimpleOptions<
  T extends { distanceMeters?: number; crowd?: unknown },
>(options: T[], sort: SimpleOptionSort): T[] {
  if (sort === "recommended") return options;
  const keyed = options.map((option, index) => ({ option, index }));
  if (sort === "nearest_first") {
    keyed.sort(
      (a, b) =>
        (a.option.distanceMeters ?? Number.POSITIVE_INFINITY) -
          (b.option.distanceMeters ?? Number.POSITIVE_INFINITY) ||
        a.index - b.index,
    );
    return keyed.map((entry) => entry.option);
  }
  /* 주변·시군구에서 빌려 온 값은 중립 쪽으로 눌러 직접 잰 후보를 이기지
     못하게 한다. 엔진의 추천순 점수와 같은 가중치다. */
  const rate = (option: T) => {
    const crowd = option.crowd as
      | { relativeRate?: number; basis?: string }
      | undefined;
    if (typeof crowd?.relativeRate !== "number") return undefined;
    const weight =
      crowd.basis === "district" ? 0.25 : crowd.basis === "nearby" ? 0.6 : 1;
    return 50 + (crowd.relativeRate - 50) * weight;
  };
  const direction = sort === "quiet_first" ? 1 : -1;
  keyed.sort((a, b) => {
    const left = rate(a.option);
    const right = rate(b.option);
    if (left === undefined && right === undefined) return a.index - b.index;
    /* 값이 없는 후보는 뒤로 보내되 지우지 않는다. */
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return (left - right) * direction || a.index - b.index;
  });
  return keyed.map((entry) => entry.option);
}

export function sortOptionsByCrowd(
  options: RecoveryOption[],
  sort: OptionSort,
): SortedOptionGroups<RecoveryOption> {
  if (sort === "recommended") return { ranked: options, unranked: [] };
  if (sort === "nearest_first") {
    /* 거리는 후보마다 있다(경로를 못 얻으면 직선 추정이라도 들어간다). 값이
       없는 후보만 뒤로 보낸다 — 지우지는 않는다. */
    const meters = (option: RecoveryOption) =>
      typeof option.distanceMeters === "number"
        ? option.distanceMeters
        : Number.POSITIVE_INFINITY;
    return {
      ranked: options
        .map((option, index) => ({ option, index }))
        .sort(
          (a, b) =>
            meters(a.option) - meters(b.option) || a.index - b.index,
        )
        .map((entry) => entry.option),
      unranked: [],
    };
  }
  if (sort === "open_first") {
    /* 운영 여부는 모든 후보에 값이 있다(모르면 `unknown`). 그래서 따로 내릴
       묶음이 없다. */
    return {
      ranked: options
        .map((option, index) => ({ option, index }))
        .sort(
          (a, b) =>
            availabilityRank(a.option) - availabilityRank(b.option) ||
            a.index - b.index,
        )
        .map((entry) => entry.option),
      unranked: [],
    };
  }
  /* 원시 집중률로 정렬하면 **빌려 온 값이 직접 잰 값과 똑같이 겨룬다.**
     엔진은 주변 대체를 0.6배, 시군구 값을 0.25배로 눌러 순위에 끼어들지
     못하게 하는데, 이 정렬만 그 규칙 밖에 있었다. 강릉처럼 여덟 후보가 모두
     시군구 값을 받은 지역에서는 순서가 무의미하게 흔들린다.

     같은 축소를 여기서도 쓴다 — 방향은 그대로 두고 크기만 줄이므로 직접 잰
     후보가 같은 값에서 앞선다. */
  const rate = (option: RecoveryOption) => {
    const raw = option.crowd?.relativeRate;
    if (raw === undefined) return undefined;
    const weight =
      option.crowd?.basis === "district"
        ? 0.25
        : option.crowd?.basis === "nearby"
          ? 0.6
          : 1;
    return 50 + (raw - 50) * weight;
  };
  const ranked = options.filter((option) => rate(option) !== undefined);
  const unranked = options.filter((option) => rate(option) === undefined);
  const direction = sort === "quiet_first" ? 1 : -1;
  return {
    /* 원래 순서를 타이브레이커로 쓴다 — 같은 값일 때 순서가 흔들리면 사용자가
       같은 화면을 다시 볼 때마다 카드가 움직인다. */
    ranked: ranked
      .map((option, index) => ({ option, index }))
      .sort(
        (a, b) =>
          ((rate(a.option) as number) - (rate(b.option) as number)) *
            direction ||
          a.index - b.index,
      )
      .map((entry) => entry.option),
    unranked,
  };
}

/* 일정 시각 선택지 — 30분 단위.
 *
 * 여행자는 분 단위로 계획하지 않는다. `type="time"` 입력은 시와 분을 각각
 * 조작해야 하고 모바일에서는 스크롤 휠 두 개가 뜬다. "오후 2시쯤"을 넣으려고
 * 두 번 조작하는 것은 위기 순간에 쓰는 도구로서 문턱이 높다. 30분 단위 드롭다운
 * 하나로 줄인다. */
export const HALF_HOUR_TIMES: Array<{ value: string; label: string }> = (() => {
  const out: Array<{ value: string; label: string }> = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const meridiem = hour < 12 ? "오전" : "오후";
    const display = hour % 12 === 0 ? 12 : hour % 12;
    out.push({
      value,
      label: `${meridiem} ${display}:${String(minute).padStart(2, "0")}`,
    });
  }
  return out;
})();

/* 이미 저장된 분 단위 값을 가장 가까운 30분으로 맞춘다. 목록에 없는 값이 들어
   오면 드롭다운이 빈 채로 보이고 사용자는 자기가 넣은 시각을 잃는다. */
export function toHalfHour(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "";
  const rounded = Math.round((hour * 60 + minute) / 30) * 30;
  const clamped = Math.min(rounded, 23 * 60 + 30);
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}
