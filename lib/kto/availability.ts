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
  /* 같은 설명의 영어 표기. 영어 화면에서 운영 판정만 한국어로 남지 않게 한다. */
  noteEn?: string;
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

/* `detailIntro2`는 콘텐츠 유형마다 필드 이름이 다르다. 공통 `usetime`/`restdate`만
   읽으면 문화시설·레포츠는 값이 있는데도 "운영시간 항목이 비어 있음"으로 판정되고,
   그 상태로 `confirmationRequired: false` 후보가 되어 휴관일에도 확인 요구 없이
   제시된다. 2026-08-04 실표본으로 확인한 이름을 모두 넣는다.

   함정 하나: 행사(15)의 `usetimefestival`은 이름과 달리 **이용요금**이다(실표본
   값 `"무료"`). 운영시간으로 읽으면 요금 문자열이 운영시간 자리에 들어가므로 목록에
   두지 않고, 행사의 실제 운영시간인 `playtime`을 읽는다. */
const OPERATING_HOURS_FIELDS = [
  "usetime",
  "usetimeculture",
  "usetimeleports",
  "opentime",
  "opentimefood",
  "playtime",
  "checkintime",
] as const;

const REST_DATE_FIELDS = [
  "restdate",
  "restdateculture",
  "restdateleports",
  "restdateshopping",
  "restdatefood",
] as const;

const CONTACT_FIELDS = [
  "infocenter",
  "infocenterculture",
  "infocenterleports",
  "infocentershopping",
  "infocenterfood",
  "infocenterlodging",
] as const;

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
  const operatingHours = text(item, [...OPERATING_HOURS_FIELDS]);
  const restDate = text(item, [...REST_DATE_FIELDS]);
  const contact = text(item, [...CONTACT_FIELDS]);
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
      noteEn:
        eventEnd !== null && today > eventEnd
          ? "The official event end date has already passed."
          : eventStart !== null && today < eventStart
            ? "The official event has not started yet."
            : "The official closing days include your visit date.",
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
      noteEn: intervalInside
        ? "Your whole stay fits inside one clearly stated opening interval in the official data."
        : "Your arrival-to-departure window does not fit inside the official opening hours.",
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
        "한국관광공사 공식 운영시간은 있지만 자동으로 읽을 수 없는 형식입니다. 출발 전에 한 번 확인해 주세요.",
      noteEn:
        "Official opening hours exist but cannot be parsed automatically. Please confirm before you set out.",
      audit,
    };
  }

  return {
    status: "unknown",
    contact: contact || undefined,
    checkedAt,
    note: "한국관광공사 응답에 운영시간 항목이 비어 있습니다. 출발 전에 확인해 주세요.",
    noteEn:
      "The official response has no operating-hours field. Please confirm before you set out.",
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
      noteEn: "The official detail response for this place was empty.",
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
