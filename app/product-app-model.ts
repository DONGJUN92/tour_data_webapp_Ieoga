/* Types, constants and pure helpers lifted out of ProductApp.
   ProductApp had grown past four thousand lines, which made the remaining
   screen-by-screen migration hard to review. Nothing here holds state or
   renders — it is the data model and formatting layer only. */

import type { JourneyExecution } from "@/lib/recovery/execution";
import { statusLabel, statusTone } from "@/lib/text/status-labels";

export type TabId = "recover" | "discover" | "insights" | "transparency";
export type Incident = "rain" | "delay" | "crowd" | "less_walk";
export type Audience = "general" | "stroller" | "wheelchair" | "senior";
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
  availability?: unknown;
  indoorSuitability?: unknown;
  accessibility?: unknown;
  crowd?: unknown;
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
  rejectedCount?: number;
  sourceLedger?: unknown[];
  warnings?: string[];
  generatedAt?: string;
  counterfactual?: Counterfactual;
  scheduleDiff?: ScheduleDiff;
  dataContributions?: DataContribution[];
  recoveryMode?: string;
  itinerarySummary?: Record<string, unknown>;
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
    description: "보행 부담과 접근성 조건을 먼저 통과한 후보만 제시합니다.",
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
    description: "Check walking and accessibility constraints before showing an option.",
  },
};

/* 이동수단은 두 화면이 같은 목록을 써야 한다. 화면마다 따로 두면 한쪽에만 수단이
   추가되어 같은 엔진이 다른 선택지를 받게 된다.

   확인된 국내 제공자가 있는 수단만 둔다. 2026-08-04 실호출 결과: TMAP 보행자와
   TMAP 자동차는 같은 `TMAP_APP_KEY`로 동작하고, Kakao Navi는 자동차 전용이며
   (유효 priority는 RECOMMEND·TIME·DISTANCE뿐) 대중교통·자전거 엔드포인트는
   404였다. 고를 수는 있는데 검증은 못 하는 수단을 목록에 두면 여행자에게 잘못된
   도착 시각을 주는 것과 같으므로 넣지 않는다. */
export const TRAVEL_MODES = [
  {
    value: "walk",
    ko: "걸어서",
    en: "Walking",
    radius: 8_000,
    distance: 5_000,
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

export const AUDIENCES: { value: Audience; label: string }[] = [
  { value: "general", label: "일반 여행" },
  { value: "stroller", label: "유아차 동반" },
  { value: "wheelchair", label: "휠체어 이용" },
  { value: "senior", label: "고령자 동반" },
];

export const AUDIENCES_EN: Record<Audience, string> = {
  general: "General travel",
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

export function formatCrowd(value: unknown): string {
  const record = asRecord(value);
  if (typeof record?.relativeRate === "number") {
    return `예측지수 ${(record.relativeRate as number).toFixed(1)}`;
  }
  return compactValue(value);
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
