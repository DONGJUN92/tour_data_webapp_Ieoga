import { getTourismIntro } from "@/lib/kto/adapters";
import type { KtoAudit, KtoItem } from "@/lib/kto/types";

export type AvailabilityEvidence = {
  status:
    | "confirmed_open"
    | "confirmed_closed"
    | "official_hours_unstructured"
    | "unknown";
  operatingHours?: string;
  restDate?: string;
  contact?: string;
  checkedAt: string;
  note: string;
  audit: KtoAudit;
};

const DAY_NAMES = [
  "일요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
] as const;

function text(item: KtoItem, fields: string[]): string {
  for (const field of fields) {
    const value = String(item[field] ?? "").trim();
    if (value) return value.replace(/<br\s*\/?>/gi, " · ");
  }
  return "";
}

function koreaDate(now = new Date()): Date {
  return new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }),
  );
}

function compactDate(value: string): number | null {
  const digits = value.replace(/\D/g, "");
  return /^\d{8}$/.test(digits) ? Number(digits) : null;
}

function currentDateNumber(now = new Date()): number {
  const date = koreaDate(now);
  return Number(
    `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`,
  );
}

function parseTimeRanges(value: string): Array<[number, number]> {
  const normalized = value
    .replace(/시\s*(\d{1,2})\s*분/g, ":$1")
    .replace(/(\d{1,2})시/g, "$1:00");
  const matches = [
    ...normalized.matchAll(
      /(\d{1,2})\s*[:시]\s*(\d{2})?\s*(?:~|–|—|-|부터)\s*(\d{1,2})\s*[:시]\s*(\d{2})?/g,
    ),
  ];
  return matches.flatMap((match) => {
    const startHour = Number(match[1]);
    const startMinute = Number(match[2] ?? 0);
    const endHour = Number(match[3]);
    const endMinute = Number(match[4] ?? 0);
    if (
      startHour > 24 ||
      endHour > 24 ||
      startMinute > 59 ||
      endMinute > 59
    ) {
      return [];
    }
    return [[startHour * 60 + startMinute, endHour * 60 + endMinute]];
  });
}

function isRestDay(restDate: string, now = new Date()): boolean {
  if (!restDate) return false;
  const currentDay = DAY_NAMES[koreaDate(now).getDay()];
  return (
    restDate.includes(currentDay) &&
    /(매주|휴무|휴관|쉬는|정기)/u.test(restDate)
  );
}

export function evaluateAvailabilityItem(
  item: KtoItem,
  audit: KtoAudit,
  visitStart = new Date(),
  visitEnd = visitStart,
): AvailabilityEvidence {
  const checkedAt = new Date().toISOString();
  const operatingHours = text(item, [
    "usetime",
    "opentime",
    "opentimefood",
    "usetimefestival",
    "checkintime",
  ]);
  const restDate = text(item, [
    "restdate",
    "restdateshopping",
    "restdatefood",
  ]);
  const contact = text(item, ["infocenter"]);
  const eventStart = compactDate(text(item, ["eventstartdate"]));
  const eventEnd = compactDate(text(item, ["eventenddate"]));
  const today = currentDateNumber(visitStart);

  if (
    (eventStart !== null && today < eventStart) ||
    (eventEnd !== null && today > eventEnd) ||
    isRestDay(restDate, visitStart)
  ) {
    return {
      status: "confirmed_closed",
      operatingHours: operatingHours || undefined,
      restDate: restDate || undefined,
      contact: contact || undefined,
      checkedAt,
      note:
        eventEnd !== null && today > eventEnd
          ? "한국관광공사 행사 종료일이 지났습니다."
          : eventStart !== null && today < eventStart
            ? "한국관광공사 행사 시작일 전입니다."
            : `한국관광공사 휴무 정보에 방문일(${DAY_NAMES[koreaDate(visitStart).getDay()]})이 포함됩니다.`,
      audit,
    };
  }

  const ranges = parseTimeRanges(operatingHours);
  const start = koreaDate(visitStart);
  const end = koreaDate(visitEnd);
  const sameVisitDate =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const ambiguousHours =
    ranges.length !== 1 ||
    /(요일|평일|주말|공휴일|동절기|하절기|성수기|비수기|시즌|변동|문의|입장\s*마감|매표\s*마감)/u.test(
      operatingHours,
    );
  if (ranges.length && sameVisitDate && !ambiguousHours) {
    const [rangeStart, rangeEnd] = ranges[0];
    const visitStartMinutes =
      start.getHours() * 60 + start.getMinutes();
    const visitEndMinutes = end.getHours() * 60 + end.getMinutes();
    const intervalInside =
      rangeEnd < rangeStart
        ? (visitStartMinutes >= rangeStart ||
            visitStartMinutes <= rangeEnd) &&
          (visitEndMinutes >= rangeStart ||
            visitEndMinutes <= rangeEnd)
        : visitStartMinutes >= rangeStart &&
          visitEndMinutes <= rangeEnd &&
          visitEndMinutes >= visitStartMinutes;
    return {
      status: intervalInside ? "confirmed_open" : "confirmed_closed",
      operatingHours,
      restDate: restDate || undefined,
      contact: contact || undefined,
      checkedAt,
      note: intervalInside
        ? "한국관광공사 운영시간의 단일 명확 구간 안에 대체 일정의 전체 체류시간이 포함됩니다."
        : "대체 일정의 도착부터 체류 종료까지 전체 구간이 한국관광공사 운영시간 안에 들어오지 않습니다.",
      audit,
    };
  }

  if (operatingHours || restDate || eventStart !== null || eventEnd !== null) {
    return {
      status: "official_hours_unstructured",
      operatingHours: operatingHours || undefined,
      restDate: restDate || undefined,
      contact: contact || undefined,
      checkedAt,
      note:
        "한국관광공사 공식 운영 정보는 확인했으나 자동 시간 판정이 어려워 방문 전 최종 확인이 필요합니다.",
      audit,
    };
  }

  return {
    status: "unknown",
    contact: contact || undefined,
    checkedAt,
    note: "한국관광공사 응답에 구조화된 운영시간 정보가 없습니다.",
    audit,
  };
}

export async function getAvailabilityEvidence(params: {
  contentId: string;
  contentTypeId: string;
  startAt?: Date;
  endAt?: Date;
}, options: { signal?: AbortSignal } = {}): Promise<AvailabilityEvidence> {
  const result = await getTourismIntro(
    params.contentId,
    params.contentTypeId,
    { signal: options.signal },
  );
  const item = result.items[0];
  if (!item) {
    return {
      status: "unknown",
      checkedAt: new Date().toISOString(),
      note: "한국관광공사 상세 운영정보 응답이 비어 있습니다.",
      audit: result.audit,
    };
  }
  const startAt = params.startAt ?? new Date();
  return evaluateAvailabilityItem(
    item,
    result.audit,
    startAt,
    params.endAt ?? startAt,
  );
}
