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

/* 운영시간을 사람이 읽는 한 줄로.
 *
 * 예전 문구들은 우리 판정 과정을 설명했다 — "단일 명확 구간 안에 전체 체류시간이
 * 포함됩니다". 여행자가 알고 싶은 것은 **몇 시에 여는가**이고, 그 값은 우리가
 * 이미 들고 있다. 판정 결과는 짧은 앞말로 붙이고 본문은 원문을 그대로 쓴다.
 *
 * `상시 개방`처럼 시간이 아닌 표기는 그대로만 적는다 — "운영시간 상시 개방"은
 * 군더더기다. 운영 요일·휴무가 적혀 있으면 함께 적는다. 그것이 여행자가 오늘
 * 갈 수 있는지 판단하는 재료다. */
const ALWAYS_OPEN = /(상시\s*개방|연중\s*무휴|24\s*시간|항시\s*개방)/u;

/* 계절·요일별로 시간이 다른 곳이 흔하다. 공사 원문은 `[하절기(3~10월)]
 * 09:30~17:30 [동절기(11~2월)] 10:00~17:00`처럼 구간 표시를 대괄호로 준다.
 * 이것을 한 줄에 이어 붙이면 어느 시간이 어느 기간의 것인지 세어 가며 읽어야
 * 한다. 대괄호 앞에서 줄을 나눠 **한 줄에 한 조건**만 오게 한다. */
function splitByCondition(value: string): string {
  return value
    .replace(/\s*(\[[^\]]+\])\s*/gu, "\n$1 ")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").replace(/^[·,/\s]+|[·,/\s]+$/gu, ""))
    .filter(Boolean)
    .join("\n");
}

function hoursLine(operatingHours: string, restDate: string): string {
  const hours = splitByCondition(operatingHours.replace(/\s+/gu, " ").trim());
  const rest = restDate.replace(/\s+/gu, " ").trim();
  const head = !hours
    ? ""
    : ALWAYS_OPEN.test(hours) && hours.length <= 12
      ? hours
      : `운영시간 ${hours.includes("\n") ? `\n${hours}` : hours}`;
  const tail = rest ? `휴무 ${rest}` : "";
  return [head, tail].filter(Boolean).join("\n");
}

function hoursLineEn(operatingHours: string, restDate: string): string {
  const hours = operatingHours.replace(/\s+/gu, " ").trim();
  const rest = restDate.replace(/\s+/gu, " ").trim();
  return [
    hours ? `Hours ${splitByCondition(hours)}` : "",
    rest ? `Closed ${rest}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
      note: hoursLine(operatingHours, restDate),
      noteEn: hoursLineEn(operatingHours, restDate),
      audit,
    };
  }

  /* 표기가 모호해도 "어느 해석으로도 열려 있지 않다"는 판정은 안전하다.
     추출한 모든 구간 밖에 방문 시각이 있으면, 평일·주말·계절 중 무엇을 적용해도
     닫혀 있다. 이 판정이 없던 동안 역선택이 일어났다 — `[평일] 10:00~19:00
     (입장 마감 18:00)`처럼 **정보를 더 자세히 적은 곳**이 "읽을 수 없는 형식"으로
     분류되어 검사를 건너뛰고, `09:00~18:00`처럼 단순하게 적은 곳만 걸러졌다.
     가상 페르소나 조사에서 07:2x~07:3x에 호출했을 때 10:00·11:00·14:00 개관인
     곳이 7명에게 1순위로 제시됐다. 헛걸음 비용은 유아차·휠체어·고령자에게 가장
     크다.

     반대 방향(열려 있다)은 여전히 단정하지 않는다. 어느 요일 규칙이 적용되는지
     모르는 상태에서 "열려 있다"고 말하는 것은 근거를 넘어서는 주장이다. */
  if (ranges.length && sameVisitDate) {
    const visitStartMinutes = start.getHours() * 60 + start.getMinutes();
    const visitEndMinutes = end.getHours() * 60 + end.getMinutes();
    /* 단일 명확 구간과 같은 기준을 쓴다 — 도착부터 체류 종료까지 전체가 들어와야
       "들어온다"고 본다. 절반만 겹치는 것을 통과시키면 개관 40분 전에 도착해
       문 앞에서 기다리는 일정을 추천하게 된다. */
    const fitsWholly = ([rangeStart, rangeEnd]: readonly [number, number]) =>
      rangeEnd < rangeStart
        ? (visitStartMinutes >= rangeStart || visitStartMinutes <= rangeEnd) &&
          (visitEndMinutes >= rangeStart || visitEndMinutes <= rangeEnd)
        : visitStartMinutes >= rangeStart &&
          visitEndMinutes <= rangeEnd &&
          visitEndMinutes >= visitStartMinutes;
    const overlaps = ([rangeStart, rangeEnd]: readonly [number, number]) =>
      rangeEnd < rangeStart
        ? visitStartMinutes >= rangeStart ||
          visitStartMinutes <= rangeEnd ||
          visitEndMinutes >= rangeStart ||
          visitEndMinutes <= rangeEnd
        : visitEndMinutes >= rangeStart && visitStartMinutes <= rangeEnd;
    if (!ranges.some(fitsWholly)) {
      const partial = ranges.some(overlaps);
      return {
        status: "confirmed_closed",
        operatingHours,
        restDate: restDate || undefined,
        contact: contact || undefined,
        checkedAt,
        note: [
          partial
            ? "체류 시간의 일부만 겹칩니다."
            : "이 시간에는 닫혀 있습니다.",
          hoursLine(operatingHours, restDate),
        ]
          .filter(Boolean)
          .join(" "),
        noteEn: partial
          ? `Only part of your stay overlaps the official opening hours (${operatingHours}); no stated interval covers it end to end.`
          : `Your visit falls outside every interval stated in the official hours (${operatingHours}). It is closed under any reading.`,
        audit,
      };
    }
  }

  if (operatingHours || restDate || eventStart !== null || eventEnd !== null) {
    return {
      status: "official_hours_unstructured",
      operatingHours: operatingHours || undefined,
      restDate: restDate || undefined,
      contact: contact || undefined,
      checkedAt,
      /* **원문을 그대로 보여 준다.**
         예전 문구는 "운영시간은 있지만 자동으로 읽을 수 없는 형식입니다.
         출발 전에 한 번 확인해 주세요"였다. 우리가 그 시간을 **손에 들고
         있으면서** 여행자에게 알아서 확인하라고 미룬 것이다. 기계가 못 읽는
         것과 사람이 못 읽는 것은 다르다 — `[평일] 10:00~19:00 (입장 마감
         18:00)`은 사람은 1초면 읽는다.

         우리가 판정하지 못했다는 사실은 그대로 밝히되, 판단 재료는 넘긴다.
         휴무일과 연락처가 있으면 함께 준다 — 전화 한 통이 "확인해 주세요"보다
         실행 가능한 안내다. */
      /* 원문을 앞세운다. 우리가 자동 대조를 못 했다는 사실은 뒤에 짧게 붙인다 —
         여행자가 먼저 봐야 할 것은 몇 시에 여는가이지 우리 사정이 아니다. */
      note: hoursLine(operatingHours, restDate),
      noteEn: hoursLineEn(operatingHours, restDate),
      audit,
    };
  }

  return {
    status: "unknown",
    contact: contact || undefined,
    checkedAt,
    /* 여기는 정말로 값이 없는 경우다. 그때도 연락처가 있으면 함께 준다. */
    note: contact
      ? `한국관광공사 응답에 운영시간 항목이 비어 있습니다. ${contact}로 확인할 수 있습니다.`
      : "한국관광공사 응답에 운영시간 항목이 비어 있습니다.",
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
