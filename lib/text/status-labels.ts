/**
 * 서버가 돌려주는 상태 코드를 사람이 읽는 문장으로 바꾼다.
 *
 * 이전에는 홈 화면이 `운영 여부: confirmed_open`, 기여 원장이 `bounded`처럼
 * 내부 코드를 그대로 출력했다. 화이트리스트에 없는 값이 `String(value)`로
 * 새어 나가는 구조였기 때문이다. 이 모듈은 미매핑 값을 절대 그대로 내보내지
 * 않고, 대신 안전한 기본 문장을 돌려준다. 새 코드가 생기면 여기에 추가한다.
 */

export type LabelLanguage = "ko" | "en";

type Label = { ko: string; en: string };

const LABELS: Record<string, Label> = {
  // --- 운영 가능 여부 -----------------------------------------------------
  confirmed_open: {
    ko: "운영시간 확인됨",
    en: "Open hours verified",
  },
  official_hours_unstructured: {
    ko: "공식 운영시간 있음 · 방문 전 확인 필요",
    en: "Official hours found · confirm before you go",
  },
  official_check_required: {
    ko: "공식 운영정보 확인 필요",
    en: "Check the official operating information",
  },
  hours_unavailable: {
    ko: "운영시간 정보 없음",
    en: "No operating hours provided",
  },
  closed: { ko: "해당 시간 휴무", en: "Closed at that time" },

  // --- 검증 결과 ---------------------------------------------------------
  verified: { ko: "공식 정보로 확인", en: "Verified by official data" },
  confirmed: { ko: "확인됨", en: "Confirmed" },
  unverified: { ko: "확인 필요", en: "Needs a check" },
  unknown: { ko: "확인 필요", en: "Needs a check" },
  check_required: { ko: "확인 필요", en: "Needs a check" },
  type_based: {
    ko: "콘텐츠 유형으로 판단",
    en: "Inferred from the content type",
  },
  not_required: {
    ko: "이번 요청에 필요 없음",
    en: "Not required for this request",
  },

  // --- 데이터 기여도 -----------------------------------------------------
  used: { ko: "판단에 사용", en: "Used in the decision" },
  applied: { ko: "판단에 사용", en: "Used in the decision" },
  bounded: {
    ko: "일부만 사용 (응답 범위 제한)",
    en: "Partly used (limited response)",
  },
  decisive: { ko: "결정을 바꿈", en: "Changed the decision" },
  observed: { ko: "참고만 함", en: "Observed only" },

  // --- 제공자 상태 -------------------------------------------------------
  ok: { ko: "정상", en: "Normal" },
  ready: { ko: "정상", en: "Normal" },
  healthy: { ko: "정상", en: "Normal" },
  available: { ko: "정상", en: "Normal" },
  success: { ko: "정상", en: "Normal" },
  live: { ko: "정상", en: "Normal" },
  degraded: { ko: "일부 제한", en: "Partly limited" },
  partial: { ko: "일부 제한", en: "Partly limited" },
  warning: { ko: "일부 제한", en: "Partly limited" },
  stale: { ko: "갱신 지연", en: "Refresh delayed" },
  empty: { ko: "데이터 없음", en: "No data" },
  insufficient: { ko: "데이터 부족", en: "Not enough data" },
  no_data: { ko: "데이터 없음", en: "No data" },
  unavailable: { ko: "정보 미확인", en: "Not verified" },
  error: { ko: "오류", en: "Error" },
  failed: { ko: "오류", en: "Error" },
  down: { ko: "응답 없음", en: "No response" },
  available_on_demand: { ko: "조회 전", en: "Not queried yet" },
  not_queried: { ko: "조회 전", en: "Not queried yet" },
  pending_query: { ko: "조회 전", en: "Not queried yet" },

  // --- 난이도·불확실성 ---------------------------------------------------
  low: { ko: "낮음", en: "Low" },
  medium: { ko: "보통", en: "Medium" },
  high: { ko: "높음", en: "High" },

  // --- 미션 단계 ---------------------------------------------------------
  detected: { ko: "공백 발견", en: "Gap found" },
  assigned: { ko: "담당 지정", en: "Owner assigned" },
  in_progress: { ko: "개선 실행", en: "Improvement in progress" },
  revalidating: { ko: "동일 조건 재검증", en: "Re-verifying" },
  closed_mission: { ko: "종료", en: "Closed" },
};

const FALLBACK: Label = { ko: "확인 중", en: "Being checked" };

/**
 * 상태 코드를 한 문장으로 바꾼다.
 * 매핑에 없으면 내부 코드를 노출하지 않고 안전한 기본 문장을 쓴다.
 */
export function statusLabel(
  value: unknown,
  language: LabelLanguage = "ko",
): string {
  if (value === true) return language === "en" ? "Verified" : "확인";
  if (value === false) return language === "en" ? "Not verified" : "미확인";
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!key) return FALLBACK[language];
  const label = LABELS[key];
  if (label) return label[language];
  // 사람이 읽을 수 있는 한국어 문장이 이미 들어온 경우는 그대로 통과시킨다.
  if (/[가-힣]/.test(String(value))) return String(value).trim();
  return FALLBACK[language];
}

/** 상태 코드가 이 모듈에 등록되어 있는지. 테스트에서 누락 코드를 잡는 데 쓴다. */
export function isMappedStatus(value: unknown): boolean {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  return Boolean(key && LABELS[key]);
}

/**
 * 데이터 출처 이름을 화면 언어에 맞춘다.
 *
 * 서버는 출처를 한국어 한 가지로 내려준다. 영어 화면에서 그대로 쓰면
 * "Source: 한국관광공사 국문 관광정보."처럼 문장 중간에 한국어가 박힌다.
 * 기관명은 공식 영문 명칭을 쓰고, 원문 표기도 함께 남긴다.
 */
const SOURCE_LABELS: Record<string, string> = {
  "한국관광공사 국문 관광정보":
    "Korea Tourism Organization · official tourism data",
  "한국관광공사 무장애 여행정보":
    "Korea Tourism Organization · barrier-free travel data",
  "한국관광공사 관광지 집중률 예측":
    "Korea Tourism Organization · visitor concentration forecast",
  "한국관광공사 연관 관광지":
    "Korea Tourism Organization · related destinations",
  "한국관광공사 기초지자체 중심 관광지":
    "Korea Tourism Organization · district hub destinations",
  "카카오 로컬": "Kakao Local",
  "주소 검색": "Address lookup",
  "OpenStreetMap 보행 경로": "OpenStreetMap walking route",
  "TMAP 보행자 경로": "TMAP pedestrian routing",
  "보행 경로 · TMAP 보행자 경로안내 (SK텔레콤)":
    "Walking route · TMAP pedestrian routing (SK Telecom)",
  "기상청 단기예보": "Korea Meteorological Administration · short-term forecast",
  "Open-Meteo 관측": "Open-Meteo observation",
};

export function sourceLabelText(
  label: unknown,
  language: LabelLanguage = "ko",
): string {
  const text = String(label ?? "").trim();
  if (!text) return language === "en" ? "Source not recorded" : "출처 미기록";
  if (language === "ko") return text;
  return SOURCE_LABELS[text] ?? text;
}

/** 상태의 색 톤. good/warn/bad/idle */
export function statusTone(value: unknown): "good" | "warn" | "bad" | "idle" {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    [
      "ok",
      "ready",
      "healthy",
      "available",
      "success",
      "live",
      "verified",
      "confirmed",
      "confirmed_open",
      "used",
      "applied",
      "decisive",
    ].includes(key)
  ) {
    return "good";
  }
  if (
    [
      "degraded",
      "partial",
      "warning",
      "stale",
      "empty",
      "insufficient",
      "no_data",
      "bounded",
      "official_hours_unstructured",
      "official_check_required",
      "unverified",
      "unknown",
      "check_required",
      "hours_unavailable",
    ].includes(key)
  ) {
    return "warn";
  }
  if (["error", "failed", "down", "closed"].includes(key)) return "bad";
  return "idle";
}
