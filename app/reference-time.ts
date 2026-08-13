import type { Language } from "./product-app-model";

export type ReferenceTimeMode = "now" | "scheduled";

/* 복구 엔진이 검증할 수 있는 교통·날씨 예측 범위와 서버 계약을 맞춘다. 너무 먼
   미래를 입력받아 놓고 현재 데이터로 추정한 것처럼 보여 주지 않는다. */
export const MAX_REFERENCE_TIME_FUTURE_MINUTES = 6 * 60;

export type ReferenceTimeResolution =
  | { ok: true; iso: string; timestamp: number }
  | {
      ok: false;
      code: "required" | "invalid" | "past" | "too_far";
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
  if (timestamp > nowMs + MAX_REFERENCE_TIME_FUTURE_MINUTES * 60_000) {
    return {
      ok: false,
      code: "too_far",
      message:
        language === "en"
          ? "Choose a time within the next 6 hours so live travel and opening data can be verified."
          : "실시간 이동·운영 정보를 확인할 수 있도록 6시간 이내의 시각을 선택해 주세요.",
    };
  }
  return { ok: true, iso: new Date(timestamp).toISOString(), timestamp };
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
