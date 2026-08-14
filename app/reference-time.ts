import type { Language } from "./product-app-model";

export type ReferenceTimeMode = "now" | "scheduled";

/* 예전에는 여섯 시간이 상한이었다. 그 근거는 "실시간 이동·운영 정보를 확인할 수
   있는 범위"였는데, 실제로 판정을 좌우하는 것은 실시간성이 아니라 **도착 시각이
   운영시간 안에 있는가**이고 그 원천(한국관광공사 운영시간·휴무일)은 시각과
   무관하게 유효하다. TMAP 자동차 경로예측도 90일 뒤까지 응답한다(2026-08-14
   실측). 그래서 미래 상한을 두지 않는다.

   대신 시각에 따라 확인할 수 있는 것이 달라지므로, 확인하지 못하는 항목은
   막는 대신 그 사실을 결과에 적는다 — 기상청 단기예보는 약 3일까지이고,
   카카오 대중교통은 미래 시각표를 모른다. */
export const KMA_FORECAST_HORIZON_MINUTES = 3 * 24 * 60;

export type ReferenceTimeResolution =
  | { ok: true; iso: string; timestamp: number }
  | {
      ok: false;
      code: "required" | "invalid" | "past";
      message: string;
    };

function koreaParts(timestamp: number): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );
}

export function koreaDateTimeLocalValue(timestamp = Date.now()): string {
  const parts = koreaParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function scheduledReferenceFromOffset(
  minutes: number,
  nowMs = Date.now(),
): string {
  return koreaDateTimeLocalValue(nowMs + minutes * 60_000);
}

export function resolveReferenceTime(
  mode: ReferenceTimeMode,
  localValue: string,
  language: Language,
  nowMs = Date.now(),
): ReferenceTimeResolution {
  if (mode === "now") {
    return { ok: true, iso: new Date(nowMs).toISOString(), timestamp: nowMs };
  }
  if (!localValue) {
    return {
      ok: false,
      code: "required",
      message:
        language === "en"
          ? "Choose the date and time to use for this search."
          : "조회에 사용할 날짜와 시각을 선택해 주세요.",
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(localValue)) {
    return {
      ok: false,
      code: "invalid",
      message:
        language === "en"
          ? "Enter a valid date and time in Korea Standard Time."
          : "한국 시간 기준으로 올바른 날짜와 시각을 입력해 주세요.",
    };
  }

  const timestamp = Date.parse(`${localValue}:00+09:00`);
  if (
    !Number.isFinite(timestamp) ||
    koreaDateTimeLocalValue(timestamp) !== localValue
  ) {
    return {
      ok: false,
      code: "invalid",
      message:
        language === "en"
          ? "Enter a valid date and time in Korea Standard Time."
          : "한국 시간 기준으로 올바른 날짜와 시각을 입력해 주세요.",
    };
  }
  if (timestamp < nowMs - 60_000) {
    return {
      ok: false,
      code: "past",
      message:
        language === "en"
          ? "That time has passed. Choose the current time or a future time."
          : "선택한 시각이 지났습니다. 현재 시각이나 이후 시각을 선택해 주세요.",
    };
  }
  return { ok: true, iso: new Date(timestamp).toISOString(), timestamp };
}

/* 선택한 시각에 무엇을 확인할 수 없는지. 조회를 막지 않고 화면이 미리 말해
   준다 — 결과를 받은 뒤에야 알게 되면 이미 계획을 세운 뒤다. */
export function referenceTimeCaveat(
  timestamp: number,
  language: Language,
  nowMs = Date.now(),
): string {
  if (timestamp <= nowMs + KMA_FORECAST_HORIZON_MINUTES * 60_000) return "";
  return language === "en"
    ? "Beyond three days the national hourly forecast does not reach, so opening hours and routes are verified but the weather is marked unconfirmed."
    : "3일 이후는 기상청 단기예보가 닿지 않습니다. 운영시간과 이동 경로는 그대로 검증하되 날씨는 미확인으로 표시합니다.";
}

export function formatReferenceTime(
  iso: string,
  language: Language,
): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    return language === "en" ? "Time unavailable" : "시각 확인 필요";
  }
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
