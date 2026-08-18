"use client";

/* 지금 갑자기 시간이 생긴 여행자를 위한 화면. 일정 복구 탭과 엔진·검증·저장을
   공유하지만 입력과 설명이 다르다. 복구는 "무엇을 바꿀까"이고 이 화면은 "이 시간
   안에 무엇을 다녀올 수 있을까"이므로, 카드도 바뀐 일정 수가 아니라 도착·체류·
   복귀·남는 여유를 보여준다.

   조회 기준은 현재 시각 또는 사용자가 고른 한국 시각이다. 빠른 선택은 여행 중
   한 손으로도 누를 수 있게 하되, 정확한 약속에는 분 단위 직접 입력을 허용한다. */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./DiscoverWindowPanel.module.css";
import { ManualLocationPicker, type ManualPlace } from "./ManualLocationPicker";
import { RouteMap, type RouteMapMarker, type RoutePoint } from "./RouteMap";
import { optionApplicationSafety } from "./traveler-safety";
import { ReferenceTimePicker } from "./ReferenceTimePicker";
import {
  formatReferenceTime,
  koreaDateTimeLocalValue,
  resolveReferenceTime,
  type ReferenceTimeMode,
} from "./reference-time";
import {
  geoTravelMode,
  haversineMeters,
  optimisticTravelMinutes,
} from "@/lib/geo";
import { withParticle } from "@/lib/text/korean";
import { KTO_TOURISM_CATEGORIES } from "@/lib/kto/category";
import {
  AUDIENCES,
  AUDIENCES_EN,
  TRAVEL_MODES,
  asRecord,
  fetchJson,
  formatIsoTime,
  normalizePlaceResults,
  readText,
  type Audience,
  type Language,
  type LoadState,
  type PlaceSearchResult,
  type RecoveryOption,
  type RecoveryResponse,
  type TravelerFact,
  type TravelMode,
  filterOptionsByTourismCategory,
  sortSimpleOptions,
  tourismCategoryCounts,
  type SimpleOptionSort,
} from "./product-app-model";
import {
  sanitizeTravelerText,
  travelerErrorText,
  travelerSourceLabel,
} from "@/lib/text/traveler-facing";

const STAY_CHOICES = [30, 60, 90, 120, 150, 180] as const;

const WINDOW_CHOICES = [60, 90, 120, 150, 180, 240] as const;

export type DiscoverOrigin = {
  latitude: string;
  longitude: string;
  areaCode: string;
  sigunguCode: string;
  label: string;
};

type Props = {
  language: Language;
  origin: DiscoverOrigin;
  geoState: LoadState;
  geoMessage: string;
  geoAttribution: string;
  analyticsConsent: boolean;
  onRequestLocation: () => void;
  /* 이미 고른 위치를 즉시 다시 조회하지 않고, 자동 입력과 직접 입력 중 하나를
     다시 고르는 상태로 되돌린다. */
  onResetLocation: () => void;
  /* 직접 입력한 위치를 받는다. 예전에는 이 자리에서 여행 복구 탭으로 화면을
     바꿔 버려, 버튼을 누른 사용자가 지금 하려던 일과 입력한 조건을 함께
     잃었다. */
  onManualLocation: (place: ManualPlace) => void;
  /* 찾은 곳을 그대로 일정으로 가져간다. 이 화면은 "지금 갈 곳"만 보여 주고
     끝나서, 마음에 드는 곳을 찾아도 다음 약속을 지킬 수 있는지 따져 보려면
     이름을 외워 다른 탭에 다시 입력해야 했다. */
  onPlanFromPlace?: (place: {
    title: string;
    address: string;
    contentTypeId?: string;
  }) => void;
};

function tr(language: Language, ko: string, en: string): string {
  return language === "en" ? en : ko;
}

function formatWindowEnd(iso: string, language: Language): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

const REJECTION_COPY: Record<string, { ko: string; en: string }> = {
  TIME_LIMIT: {
    ko: "남은 시간 안에 안전하게 다녀올 수 없음",
    en: "Not enough time for a safe round trip",
  },
  OPEN_WINDOW_OVERFLOW: {
    ko: "이동·체류·복귀가 남은 시간을 초과함",
    en: "Travel, stay and return exceed the available window",
  },
  ROUTE_UNAVAILABLE: {
    ko: "실제 이동 경로를 확인하지 못함",
    en: "A real route could not be verified",
  },
  OFFICIALLY_CLOSED: {
    ko: "제안된 방문 시간에 공식적으로 휴무·폐점",
    en: "Officially closed during the proposed visit",
  },
  OPERATING_STATUS_UNCONFIRMED: {
    ko: "체류 시간 전체의 운영 여부가 확인되지 않음",
    en: "Opening for the full stay is unconfirmed",
  },
  OPERATING_STATUS_UPSTREAM_UNAVAILABLE: {
    ko: "공식 운영정보 연결 실패",
    en: "Official opening data was unavailable",
  },
  INDOOR_UNVERIFIED: {
    ko: "실내 이용 가능 여부가 확인되지 않음",
    en: "Indoor use could not be confirmed",
  },
  ACCESSIBILITY_UNVERIFIED: {
    ko: "요청한 이동 편의 조건이 확인되지 않음",
    en: "Requested accessibility could not be confirmed",
  },
  NEXT_FIXED_APPOINTMENT_AT_RISK: {
    ko: "다음 고정 일정에 늦을 위험이 있음",
    en: "The next fixed appointment would be at risk",
  },
};

function returnProviderLabel(
  provider: string | undefined,
  language: Language,
): string {
  const labels: Record<string, { ko: string; en: string }> = {
    tmap_pedestrian: { ko: "TMAP 보행 경로", en: "TMAP pedestrian route" },
    tmap_car: { ko: "TMAP 자동차 경로", en: "TMAP driving route" },
    kakao_transit: { ko: "카카오 대중교통 경로", en: "Kakao transit route" },
    kakao_bicycle: { ko: "카카오 자전거 경로", en: "Kakao cycling route" },
    openstreetmap_osrm: {
      ko: "OpenStreetMap OSRM 경로",
      en: "OpenStreetMap OSRM route",
    },
  };
  return provider && labels[provider]
    ? labels[provider][language]
    : language === "en"
      ? "separately verified return route"
      : "별도로 검증한 복귀 경로";
}

function ledgerStatusLabel(status: string, language: Language): string {
  const labels: Record<string, { ko: string; en: string }> = {
    live: { ko: "확인 완료", en: "Verified response" },
    empty: { ko: "응답했지만 일치 결과 없음", en: "No matching record" },
    error: { ko: "연결 실패", en: "Retrieval failed" },
    not_required: { ko: "이번 조건에서 미사용", en: "Not required here" },
    disabled: { ko: "제거실험에서 비활성", en: "Disabled for this ablation" },
  };
  return (
    labels[status]?.[language] ??
    tr(language, "상태를 확인할 수 없음", "Status unavailable")
  );
}

function SourceLedgerDisclosure({
  ledger,
  language,
}: {
  ledger: unknown[] | undefined;
  language: Language;
}) {
  if (!ledger?.length) return null;
  return (
    <details className={styles.sourceLedger}>
      <summary>
        {tr(
          language,
          `이번 요청에서 확인한 공식 데이터 ${ledger.length}건`,
          `${ledger.length} official-data checks in this request`,
        )}
      </summary>
      <p>
        {tr(
          language,
          "추천 결과가 0건이어도 실제로 조회한 원천과 연결 실패를 숨기지 않습니다.",
          "The sources checked—and any retrieval failures—remain visible even when no place qualifies.",
        )}
      </p>
      <ul>
        {ledger.map((entry, index) => {
          const row = asRecord(entry);
          const source =
            readText(row, ["apiName", "source", "name"]) ||
            tr(language, "공식 데이터", "Official data");
          const operation = readText(row, ["operation"]);
          const status = readText(row, ["status"]);
          return (
            <li key={`${source}-${operation}-${index}`}>
              <span>{travelerSourceLabel(source, language)}</span>
              <b>{ledgerStatusLabel(status, language)}</b>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function counterfactualGuidance(
  counterfactual: RecoveryResponse["counterfactual"],
  language: Language,
): string {
  const relaxation = counterfactual?.requiredRelaxation;
  if (!relaxation) {
    return language === "en"
      ? "Try a longer window, a shorter stay or a closer origin."
      : "남은 시간을 늘리거나 체류 시간을 줄이고, 더 가까운 출발지에서 다시 찾아보세요.";
  }
  const amount = relaxation.amount;
  const unit = relaxation.unit ?? "";
  if (language === "ko" && relaxation.description)
    return relaxation.description;
  if (relaxation.constraint === "available_time") {
    return language === "en"
      ? `Allow about ${amount ?? "more"} ${unit || "minutes"} more.`
      : `남은 시간을 약 ${amount ?? "조금"}${unit || "분"} 늘려 보세요.`;
  }
  if (relaxation.constraint === "minimum_stay") {
    return language === "en"
      ? `Shorten the stay by about ${amount ?? "a few"} ${unit || "minutes"}.`
      : `체류 시간을 약 ${amount ?? "조금"}${unit || "분"} 줄여 보세요.`;
  }
  return language === "en"
    ? "Adjust the stated constraint and search again."
    : relaxation.description || "표시된 조건을 조정해 다시 찾아보세요.";
}

function minutesLabel(language: Language, minutes: number): string {
  if (minutes % 60 === 0) {
    return tr(language, `${minutes / 60}시간`, `${minutes / 60}h`);
  }
  return tr(
    language,
    `${Math.floor(minutes / 60)}시간 30분`,
    `${Math.floor(minutes / 60)}h 30m`,
  );
}

/* 안전여유. 요청 본문과 화면의 사전 판정이 **같은 값**을 써야 한다 — 화면이
   15분으로 계산해 "가능"이라고 말했는데 엔진이 다른 값으로 탈락시키면 그 화면은
   거짓말이 된다. 예전에는 제출 시점에만 리터럴로 박혀 있었다. */
const SAFETY_BUFFER_MINUTES = 15;

/* 자동으로 줄일 수 있는 체류의 하한. 이보다 짧게 머무는 것은 "다녀왔다"고 하기
   어려우므로, 여기까지 줄여도 들어가지 않으면 그 후보는 탈락시킨다. */
const STAY_FLOOR_MINUTES = 30;

/* `TRAVEL_MODES`의 라벨은 "걸어서"처럼 부사형이라 "…까지 걸어서 최소 20분"에는
   맞지만 "걸어서으로"처럼 조사가 붙는 자리에는 쓸 수 없다. 엔진의
   `travelModeLabel`과 같은 명사형을 쓴다 — 화면과 결과 문장이 같은 단어를
   써야 여행자가 두 곳을 같은 것으로 읽는다. */
function travelModeNoun(language: Language, mode: TravelMode): string {
  if (language === "en") {
    return mode === "car"
      ? "by car"
      : mode === "transit"
        ? "by transit"
        : mode === "bicycle"
          ? "by bicycle"
          : "on foot";
  }
  return mode === "car"
    ? "자동차"
    : mode === "transit"
      ? "대중교통"
      : mode === "bicycle"
        ? "자전거"
        : "도보";
}

export default function DiscoverWindowPanel({
  language,
  origin,
  geoState,
  geoMessage,
  geoAttribution,
  analyticsConsent,
  onRequestLocation,
  onResetLocation,
  onManualLocation,
  onPlanFromPlace,
}: Props) {
  /* 직접 입력을 이 화면 안에서 편다. 탭을 바꾸면 지금 하려던 일이 사라진다. */
  const [manualOpen, setManualOpen] = useState(false);
  /* 두 버튼 중 사용자가 실제로 누른 쪽. 예전에는 "현재 위치 자동 입력"이 처음부터
     초록색이라, 아무것도 고르지 않은 화면이 이미 고른 것처럼 보였다. 기본값을
     권하는 것과 선택된 상태로 보이는 것은 다르다 — 후자는 화면이 사실이 아닌
     것을 말한다. */
  const [originChoice, setOriginChoice] = useState<
    "none" | "automatic" | "manual"
  >("none");
  const [originSelectionOpen, setOriginSelectionOpen] = useState(false);
  const automaticLocationButtonRef = useRef<HTMLButtonElement>(null);
  const [referenceTimeMode, setReferenceTimeMode] =
    useState<ReferenceTimeMode>("now");
  const [referenceTimeLocal, setReferenceTimeLocal] = useState("");
  const [referenceClockMs, setReferenceClockMs] = useState(0);
  const [submittedReferenceTime, setSubmittedReferenceTime] = useState<{
    mode: ReferenceTimeMode;
    iso: string;
  } | null>(null);
  const [windowMinutes, setWindowMinutes] = useState<number>(120);
  const [plannedStayMinutes, setPlannedStayMinutes] = useState<number>(60);
  const [audience, setAudience] = useState<Audience>("general");
  const [travelMode, setTravelMode] = useState<TravelMode>("walk");
  const [indoorOnly, setIndoorOnly] = useState(false);
  const [nextPlaceKeyword, setNextPlaceKeyword] = useState("");
  const [nextPlace, setNextPlace] = useState<PlaceSearchResult | null>(null);
  /* 다음 장소의 **실제 약속 시각**. 비어 있으면 보내지 않는다.
     예전에는 이 값을 묻지 않고 자유 시간의 끝을 대신 넣어 보냈다. 그러면
     여행자가 말한 적 없는 마감이 생기고, 그 장소가 조금만 멀어도 모든 후보가
     탈락한다. 모르면 모르는 채로 두는 것이 맞다. */
  const [nextPlaceArriveLocal, setNextPlaceArriveLocal] = useState("");
  const [nextPlaceArriveError, setNextPlaceArriveError] = useState("");
  /* 미리 고른 관광 분류. 비어 있으면 전체를 본다.

     결과를 받은 뒤 걸러내는 필터는 이미 아래에 있지만, 그것은 원하지 않는 분류에도
     운영시간·경로 조회를 다 쓴 뒤 화면에서 지우는 것이다. 여기서 고르면 서버가
     조회 **전에** 걸러내므로 같은 예산이 고른 분류에만 쓰인다. 실측에서 명동 주간
     전체 조회는 식당이 2곳이었는데, 식당만 골라 보내면 15곳이 나왔다. */
  const [wantedCategories, setWantedCategories] = useState<string[]>([]);
  const [nextPlaceResults, setNextPlaceResults] = useState<PlaceSearchResult[]>(
    [],
  );
  const [nextPlaceState, setNextPlaceState] = useState<LoadState>("idle");
  const [nextPlaceError, setNextPlaceError] = useState("");
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<RecoveryResponse | null>(null);
  const submitGenerationRef = useRef(0);
  /* 조정안을 한 번 누르면 입력을 바꾸고 **바로 다시 찾는다.** 그 재조회는
     사용자가 버튼을 누른 것과 같은 경로를 타야 하므로 폼을 직접 제출한다. */
  const formRef = useRef<HTMLFormElement>(null);

  const previewReferenceTime = resolveReferenceTime(
    referenceTimeMode,
    referenceTimeLocal,
    language,
    referenceClockMs,
  );
  const previewReferenceTimestamp = previewReferenceTime.ok
    ? previewReferenceTime.timestamp
    : referenceClockMs;
  const windowEndIso = new Date(
    previewReferenceTimestamp + windowMinutes * 60_000,
  ).toISOString();
  const windowEndLabel = useMemo(
    () =>
      referenceClockMs > 0
        ? formatWindowEnd(windowEndIso, language)
        : tr(language, "조회할 때 확정", "set when you search"),
    [language, referenceClockMs, windowEndIso],
  );
  const originReady =
    geoState === "success" &&
    Number.isFinite(Number(origin.latitude)) &&
    Number.isFinite(Number(origin.longitude)) &&
    origin.latitude.trim() !== "" &&
    origin.longitude.trim() !== "" &&
    origin.label.trim() !== "";

  const stayTooLong = plannedStayMinutes >= windowMinutes;

  /* 다음 장소를 고르는 **즉시** 계산하는 실행 가능성. 외부 조회가 0건이다 —
     직선거리를 그 수단의 최고속도로 나누므로 어떤 경로로도 이보다 빠를 수 없다.
     그래서 여기서 "부족"이 나오면 후보를 20km까지 뒤져도 나올 것이 없다.

     예전에는 이 계산을 아무도 하지 않은 채 요청을 보내고, 45번의 외부 조회를
     소진한 뒤 "다녀올 수 있는 곳을 찾지 못했습니다"라고 답했다. 여행자는 자기가
     입력한 조건이 원인이라는 것을 알 방법이 없었다. */
  const nextPlaceReach = useMemo(() => {
    if (!nextPlace || !originReady) return null;
    const originLat = Number(origin.latitude);
    const originLon = Number(origin.longitude);
    if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return null;
    const meters = haversineMeters(
      { latitude: originLat, longitude: originLon },
      { latitude: nextPlace.latitude, longitude: nextPlace.longitude },
    );
    const minTravelMinutes = Math.ceil(
      optimisticTravelMinutes(meters, geoTravelMode(travelMode)),
    );
    /* 약속 시각을 주지 않았으면 마감이 없으므로 불가능도 없다. 거리만 알려 준다. */
    if (!nextPlaceArriveLocal) {
      return { meters, minTravelMinutes, shortfallMinutes: 0 };
    }
    const arriveMs = Date.parse(`${nextPlaceArriveLocal}:00+09:00`);
    if (!Number.isFinite(arriveMs)) {
      return { meters, minTravelMinutes, shortfallMinutes: 0 };
    }
    const budgetMinutes = Math.floor(
      (arriveMs - previewReferenceTimestamp) / 60_000,
    );
    const requiredMinutes =
      minTravelMinutes + plannedStayMinutes + SAFETY_BUFFER_MINUTES;
    return {
      meters,
      minTravelMinutes,
      budgetMinutes,
      requiredMinutes,
      shortfallMinutes: Math.max(0, requiredMinutes - budgetMinutes),
    };
  }, [
    nextPlace,
    originReady,
    origin.latitude,
    origin.longitude,
    travelMode,
    nextPlaceArriveLocal,
    previewReferenceTimestamp,
    plannedStayMinutes,
  ]);

  useEffect(() => {
    const refresh = () => setReferenceClockMs(Date.now());
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  /* 서버가 돌려준 조정안을 입력에 적용하고 바로 다시 찾는다.

     여행자가 직접 어느 칸을 어떻게 고쳐야 하는지 알아내야 한다면 그 안내는
     반쪽이다. 서버는 "머무는 시간을 30분으로", "자전거로 (약 13분)"처럼 값까지
     계산해 보내므로, 화면은 그 값을 해당 입력에 넣고 재조회만 하면 된다. */
  function applyRemedy(remedy: { kind: string; value?: string | number }) {
    const numeric = Number(remedy.value);
    if (remedy.kind === "travel_mode" && typeof remedy.value === "string") {
      setTravelMode(remedy.value as TravelMode);
    } else if (remedy.kind === "stay_minutes" && Number.isFinite(numeric)) {
      /* 화면은 30분 격자만 받는다. 서버도 그 격자로 제안하지만, 안전하게
         허용된 선택값 중 제안값 이하의 가장 큰 값으로 맞춘다. */
      const allowed = [...STAY_CHOICES]
        .filter((value) => value <= numeric)
        .pop();
      setPlannedStayMinutes(allowed ?? STAY_CHOICES[0]);
    } else if (remedy.kind === "window_minutes" && Number.isFinite(numeric)) {
      /* 남은 시간은 제안값 **이상**이어야 하므로 위로 맞춘다. */
      const allowed = WINDOW_CHOICES.find((value) => value >= numeric);
      setWindowMinutes(allowed ?? WINDOW_CHOICES[WINDOW_CHOICES.length - 1]);
    } else if (
      remedy.kind === "appointment_later" &&
      Number.isFinite(numeric) &&
      nextPlaceArriveLocal
    ) {
      const current = Date.parse(`${nextPlaceArriveLocal}:00+09:00`);
      if (!Number.isFinite(current)) return;
      setNextPlaceArriveLocal(
        koreaDateTimeLocalValue(current + numeric * 60_000),
      );
    } else if (remedy.kind === "drop_next_place") {
      /* 장소는 지우지 않는다. 약속 시각만 비워 방향 힌트로 남긴다. */
      setNextPlaceArriveLocal("");
    } else {
      return;
    }
    setNextPlaceArriveError("");
    /* 상태가 커밋된 **뒤에** 제출한다. 같은 틱에서 `requestSubmit()`을 부르면
       아직 반영되지 않은 옛 값으로 요청이 나간다. 효과(useEffect) 안에서
       상태를 되돌리는 방식은 렌더를 한 번 더 유발하므로 쓰지 않는다. */
    window.setTimeout(() => formRef.current?.requestSubmit(), 0);
  }

  function invalidateReferenceResult() {
    submitGenerationRef.current += 1;
    setResult(null);
    setState("idle");
    setError("");
    setSubmittedReferenceTime(null);
  }

  function changeReferenceTimeMode(mode: ReferenceTimeMode) {
    setReferenceClockMs(Date.now());
    setReferenceTimeMode(mode);
    invalidateReferenceResult();
  }

  function changeReferenceTimeLocal(value: string) {
    setReferenceClockMs(Date.now());
    setReferenceTimeLocal(value);
    invalidateReferenceResult();
  }

  function beginOriginReselection() {
    setManualOpen(false);
    setOriginChoice("none");
    setOriginSelectionOpen(true);
    /* 이전 위치로 계산한 추천은 새 위치를 고르는 순간 더 이상 유효하지 않다. */
    setResult(null);
    setState("idle");
    setError("");
    onResetLocation();
    window.requestAnimationFrame(() =>
      automaticLocationButtonRef.current?.focus(),
    );
  }

  function requestAutomaticLocation() {
    setManualOpen(false);
    setOriginChoice("automatic");
    setOriginSelectionOpen(false);
    onRequestLocation();
  }

  async function searchNextPlace() {
    const keyword = nextPlaceKeyword.trim();
    setNextPlaceResults([]);
    setNextPlaceError("");
    if (keyword.length < 2) {
      setNextPlaceState("error");
      setNextPlaceError(
        tr(
          language,
          "장소명을 두 글자 이상 입력해 주세요.",
          "Enter at least two characters.",
        ),
      );
      return;
    }
    setNextPlaceState("loading");
    try {
      const payload = await fetchJson("/api/v1/places/search", {
        method: "POST",
        body: JSON.stringify({
          keyword,
          purpose: "saved_stop",
          fallback: "auto",
        }),
      });
      setNextPlaceResults(normalizePlaceResults(payload).slice(0, 6));
      setNextPlaceState("success");
    } catch (searchError) {
      setNextPlaceState("error");
      setNextPlaceError(
        searchError instanceof Error
          ? searchError.message
          : tr(
              language,
              "공식 관광지 정보를 확인하지 못했습니다.",
              "Could not load official place data.",
            ),
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!originReady) {
      setState("error");
      setError(
        tr(
          language,
          "먼저 현재 위치를 확인하거나 직접 선택해 주세요.",
          "Confirm your current location first.",
        ),
      );
      return;
    }
    const requestReferenceTime = resolveReferenceTime(
      referenceTimeMode,
      referenceTimeLocal,
      language,
      Date.now(),
    );
    if (!requestReferenceTime.ok) {
      setState("error");
      setError(requestReferenceTime.message);
      return;
    }
    if (stayTooLong) {
      setState("error");
      setError(
        tr(
          language,
          "선택한 조회 기준 이후의 남은 시간보다 체류 시간이 깁니다. 이동과 복귀 시간이 들어갈 자리가 없습니다.",
          "Your stay fills the window after the reference time, leaving no room to travel and return.",
        ),
      );
      return;
    }
    /* 약속 시각을 적었다면 형식과 순서를 여기서 확정한다. 서버 스키마도 같은
       것을 검증하지만, 형식 오류로 왕복 한 번을 버릴 이유가 없다. */
    let requestArriveByIso: string | undefined;
    if (nextPlace && nextPlaceArriveLocal) {
      const arriveMs = Date.parse(`${nextPlaceArriveLocal}:00+09:00`);
      if (
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(
          nextPlaceArriveLocal,
        ) ||
        !Number.isFinite(arriveMs)
      ) {
        setState("error");
        setNextPlaceArriveError(
          tr(
            language,
            "약속 시각을 한국 시간 기준으로 올바르게 입력해 주세요.",
            "Enter the appointment time in Korea Standard Time.",
          ),
        );
        return;
      }
      if (arriveMs <= requestReferenceTime.timestamp) {
        setState("error");
        setNextPlaceArriveError(
          tr(
            language,
            "약속 시각이 조회 기준 시각보다 앞섭니다. 이후 시각을 입력해 주세요.",
            "The appointment time is before the reference time.",
          ),
        );
        return;
      }
      setNextPlaceArriveError("");
      requestArriveByIso = new Date(arriveMs).toISOString();
    }
    setState("loading");
    setResult(null);
    const requestGeneration = ++submitGenerationRef.current;
    try {
      const requestDepartureAtIso = requestReferenceTime.iso;
      const requestWindowEndIso = new Date(
        requestReferenceTime.timestamp + windowMinutes * 60_000,
      ).toISOString();
      const payload = await fetchJson("/api/v1/recover", {
        method: "POST",
        body: JSON.stringify({
          origin: {
            latitude: Number(origin.latitude),
            longitude: Number(origin.longitude),
            label: origin.label.trim() || "현재 위치",
            areaCode: origin.areaCode || undefined,
            sigunguCode: origin.sigunguCode || undefined,
          },
          /* 이 화면은 사고가 아니라 빈 시간이 출발점이다. 상황 입력을 강요하지
             않고, 실내 조건을 켠 경우에만 우천 취급으로 넘긴다. */
          incident: indoorOnly ? "rain" : "delay",
          referenceTime:
            referenceTimeMode === "now"
              ? { mode: "current" }
              : { mode: "assumed", at: requestReferenceTime.iso },
          availableMinutes: windowMinutes,
          audience,
          indoorOnly,
          travelMode,
          safetyBufferMinutes: SAFETY_BUFFER_MINUTES,
          /* 원하는 체류(`plannedStayMinutes`)와 **수용 가능한 하한**을 분리한다.

             예전에는 두 값을 같게 보냈다. 그래서 엔진의 자동 완화 로직
             (`stayMinutes - minimumStay`)이 항상 0이 되어 한 번도 작동하지 않았고,
             "체류를 5분만 줄이면 갈 수 있는 곳"이 그대로 탈락했다. 실측 반사실에서
             가장 흔한 문구가 "안전여유가 1분 부족"이었다.

             엔진은 필요할 때만, 그리고 이 하한까지만 줄인다. 줄인 경우 카드가
             실제 체류 시간을 표시하고 요청값과 다르다는 사실도 함께 말한다. */
          minimumStayMinutes: Math.min(
            STAY_FLOOR_MINUTES,
            plannedStayMinutes,
          ),
          /* 고른 분류만 보낸다. 하나도 고르지 않았으면 필드를 넣지 않아 전체를 본다. */
          tourismCategories: wantedCategories.length
            ? wantedCategories
            : undefined,
          analyticsConsent,
          openWindow: {
            departureAt: requestDepartureAtIso,
            availableUntil: requestWindowEndIso,
            plannedStayMinutes,
            nextPlace: nextPlace
              ? {
                  latitude: nextPlace.latitude,
                  longitude: nextPlace.longitude,
                  label: nextPlace.title,
                  areaCode: nextPlace.areaCode || undefined,
                  sigunguCode: nextPlace.sigunguCode || undefined,
                  /* 여행자가 적은 약속 시각만 보낸다. 적지 않았으면 보내지
                     않는다 — 예전에는 이 자리에 자유 시간의 끝을 넣었고,
                     그래서 "그 시각까지 그 장소에 도착해야 한다"는, 여행자가
                     말한 적 없는 마감이 생겼다. 그 마감 하나로 전국의 모든
                     후보가 탈락했다. */
                  arriveBy: requestArriveByIso,
                }
              : undefined,
          },
        }),
      });
      if (requestGeneration !== submitGenerationRef.current) return;
      const record = asRecord(payload);
      const responseReferenceTime = asRecord(record?.referenceTime);
      const authoritativeReferenceAt = readText(responseReferenceTime, ["at"]);
      setSubmittedReferenceTime(
        authoritativeReferenceAt
          ? {
              mode:
                readText(responseReferenceTime, ["mode"]) === "assumed"
                  ? "scheduled"
                  : "now",
              iso: authoritativeReferenceAt,
            }
          : null,
      );
      setResult({
        requestId: readText(record, ["requestId"]) || "",
        status: readText(record, ["status"]) || "unknown",
        persistence: { status: "persisted" },
        options: Array.isArray(record?.options)
          ? (record.options as RecoveryOption[])
          : [],
        rejectedCount:
          typeof record?.rejectedCount === "number"
            ? record.rejectedCount
            : undefined,
        rejectionSummary: Array.isArray(record?.rejectionSummary)
          ? record.rejectionSummary.flatMap((entry) => {
              const row = asRecord(entry);
              const reasonCode = readText(row, ["reasonCode"]);
              const count = Number(row?.count);
              return reasonCode && Number.isFinite(count) && count > 0
                ? [{ reasonCode, count }]
                : [];
            })
          : [],
        warnings: Array.isArray(record?.warnings)
          ? (record.warnings as string[])
          : [],
        sourceLedger: Array.isArray(record?.sourceLedger)
          ? (record.sourceLedger as unknown[])
          : [],
        generatedAt: readText(record, ["generatedAt"]) || undefined,
        recoveryMode: readText(record, ["recoveryMode"]) || undefined,
        counterfactual: asRecord(record?.counterfactual) ?? undefined,
        /* 요청이 불가능했다는 판정과, 조건을 바꾸면 열리는 곳·지금 닫은 곳.
           예전에는 응답에 있어도 파싱하지 않아 화면이 쓸 수 없었다. */
        inputFeasibility:
          (asRecord(record?.inputFeasibility) as
            | RecoveryResponse["inputFeasibility"]
            | undefined) ?? undefined,
        alternatives:
          (asRecord(record?.alternatives) as
            | RecoveryResponse["alternatives"]
            | undefined) ?? undefined,
      });
      setState("success");
    } catch (submitError) {
      if (requestGeneration !== submitGenerationRef.current) return;
      setState("error");
      setError(
        travelerErrorText(
          submitError,
          language,
          "Could not load recommendations. Please try again shortly.",
          "추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
        ),
      );
    }
  }

  return (
    <div className={styles.panel}>
      <form ref={formRef} className={styles.form} onSubmit={submit}>
        <span className={styles.step}>
          {tr(language, "지금 시간이 생겼어요", "You just got free time")}
        </span>
        <h2 className={styles.heading}>
          {tr(
            language,
            "남은 시간에 다녀올 수 있는 곳",
            "Places you can visit and return from",
          )}
        </h2>
        <p className={styles.lead}>
          {tr(
            language,
            "일정을 등록하지 않아도 됩니다. 지금 어디에 있고, 언제 출발해 언제까지 비어 있는지만 알려 주세요.",
            "No itinerary needed. Tell us where you are, when you will leave and until when you are free.",
          )}
        </p>

        <section className={styles.block} aria-labelledby="discover-origin">
          <h3 id="discover-origin">
            {tr(language, "지금 어디에 있나요?", "Where are you now?")}
          </h3>
          {originReady && !originSelectionOpen ? (
            <p className={styles.originReady}>
              <strong>{origin.label || "현재 위치"}</strong>
              <button type="button" onClick={beginOriginReselection}>
                {tr(language, "다시 확인", "Refresh")}
              </button>
            </p>
          ) : (
            <div className={styles.originActions} id="discover-origin-actions">
              <button
                ref={automaticLocationButtonRef}
                type="button"
                className={
                  originChoice === "automatic" ? styles.primaryGhost : undefined
                }
                onClick={requestAutomaticLocation}
                disabled={geoState === "loading"}
              >
                {geoState === "loading"
                  ? tr(language, "확인 중…", "Locating…")
                  : tr(language, "현재 위치 자동 입력", "Use my location")}
              </button>
              <button
                type="button"
                className={
                  originChoice === "manual" ? styles.primaryGhost : undefined
                }
                onClick={() =>
                  setManualOpen((open) => {
                    const next = !open;
                    setOriginChoice(next ? "manual" : "none");
                    return next;
                  })
                }
                aria-expanded={manualOpen}
              >
                {tr(
                  language,
                  manualOpen ? "직접 입력 닫기" : "위치 권한 없이 직접 입력",
                  manualOpen ? "Close manual entry" : "Enter a place instead",
                )}
              </button>
            </div>
          )}
          {manualOpen && (
            <ManualLocationPicker
              language={language}
              geoBusy={geoState === "loading"}
              onRetryGeolocation={requestAutomaticLocation}
              onPick={(place) => {
                onManualLocation(place);
                setManualOpen(false);
                setOriginSelectionOpen(false);
              }}
            />
          )}
          {geoMessage && (
            <p
              className={
                geoState === "error" ? styles.messageError : styles.message
              }
              role={geoState === "error" ? "alert" : "status"}
            >
              {geoMessage}
            </p>
          )}
          {geoAttribution && (
            <small className={styles.attribution}>{geoAttribution}</small>
          )}
        </section>

        <ReferenceTimePicker
          idPrefix="discover"
          language={language}
          mode={referenceTimeMode}
          localValue={referenceTimeLocal}
          onModeChange={changeReferenceTimeMode}
          onLocalValueChange={changeReferenceTimeLocal}
        />

        <section className={styles.block} aria-labelledby="discover-window">
          <h3 id="discover-window">
            {tr(language, "언제까지 비어 있나요?", "Free until when?")}
          </h3>
          <div
            className={styles.chips}
            role="radiogroup"
            aria-label={tr(language, "남은 시간", "Remaining time")}
          >
            {WINDOW_CHOICES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                role="radio"
                aria-checked={windowMinutes === minutes}
                className={
                  windowMinutes === minutes ? styles.chipActive : styles.chip
                }
                onClick={() => {
                  setReferenceClockMs(Date.now());
                  setWindowMinutes(minutes);
                }}
              >
                {minutesLabel(language, minutes)}
              </button>
            ))}
          </div>
          <p className={styles.derived}>
            {tr(
              language,
              `조회 기준 시각부터 ${minutesLabel(language, windowMinutes)} 동안 비어 있으며 ${windowEndLabel}까지 이동·체류·복귀합니다.`,
              `You have ${minutesLabel(language, windowMinutes)} from the reference time, through ${windowEndLabel}, for travel, the visit and return.`,
            )}
          </p>
        </section>

        <section className={styles.block} aria-labelledby="discover-stay">
          <h3 id="discover-stay">
            {tr(
              language,
              "한 곳에 얼마나 머물 생각인가요?",
              "How long will you stay?",
            )}
          </h3>
          <div
            className={styles.chips}
            role="radiogroup"
            aria-label={tr(language, "머무는 시간", "Stay length")}
          >
            {STAY_CHOICES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                role="radio"
                aria-checked={plannedStayMinutes === minutes}
                className={
                  plannedStayMinutes === minutes
                    ? styles.chipActive
                    : styles.chip
                }
                onClick={() => setPlannedStayMinutes(minutes)}
              >
                {minutesLabel(language, minutes)}
              </button>
            ))}
          </div>
          <p className={styles.derived}>
            {tr(
              language,
              "이동 시간은 실제 보행 경로로 계산하므로 따로 입력하지 않습니다.",
              "Travel time comes from a real walking route, so you do not enter it.",
            )}
          </p>
          {stayTooLong && (
            <p className={styles.messageError} role="alert">
              {tr(
              language,
              "선택한 조회 기준 이후의 남은 시간보다 체류 시간이 깁니다. 이동과 복귀 시간이 들어갈 자리가 없습니다.",
              "Your stay fills the window after the reference time, leaving no room to travel and return.",
              )}
            </p>
          )}
        </section>

        <details className={styles.optional}>
          <summary>
            {tr(
              language,
              "다음에 갈 곳이 이미 정해져 있어요 (선택)",
              "I already know where I go next (optional)",
            )}
          </summary>
          <p className={styles.derived}>
            {tr(
              language,
              "장소만 알려 주시면 그 방향에 가까운 곳을 먼저 보여 드립니다. 약속 시각까지 알려 주시면 그 시각에 도착할 수 있는지도 실제 경로로 검증합니다.",
              "Tell us the place and we show stops in that direction first. Add the appointment time and we also verify you can arrive by then, on a real route.",
            )}
          </p>
          {nextPlace ? (
            <>
              <p className={styles.originReady}>
                <strong>{nextPlace.title}</strong>
                <button
                  type="button"
                  onClick={() => {
                    setNextPlace(null);
                    setNextPlaceResults([]);
                    setNextPlaceKeyword("");
                    setNextPlaceArriveLocal("");
                    setNextPlaceArriveError("");
                  }}
                >
                  {tr(language, "지우기", "Clear")}
                </button>
              </p>
              <label className={styles.selectField}>
                <span>
                  {tr(
                    language,
                    "그곳에 도착해야 하는 시각 (선택)",
                    "Time you must arrive there (optional)",
                  )}
                </span>
                <input
                  type="datetime-local"
                  value={nextPlaceArriveLocal}
                  min={koreaDateTimeLocalValue(previewReferenceTimestamp)}
                  onChange={(event) => {
                    setNextPlaceArriveLocal(event.target.value);
                    setNextPlaceArriveError("");
                    invalidateReferenceResult();
                  }}
                />
              </label>
              <p className={styles.derived}>
                {tr(
                  language,
                  "비워 두면 도착 시각을 검증하지 않고, 남은 시간 안에 다녀와서 돌아올 수 있는 곳을 찾습니다.",
                  "Leave it blank and we will not verify arrival — we find places you can visit and return from inside your free time.",
                )}
              </p>
              {nextPlaceArriveError && (
                <p className={styles.messageError} role="alert">
                  {nextPlaceArriveError}
                </p>
              )}
              {nextPlaceReach && (
                <p
                  className={
                    nextPlaceReach.shortfallMinutes > 0
                      ? styles.messageError
                      : styles.derived
                  }
                  role={
                    nextPlaceReach.shortfallMinutes > 0 ? "alert" : undefined
                  }
                >
                  {nextPlaceReach.shortfallMinutes > 0
                    ? tr(
                        language,
                        `${nextPlace.title}까지 직선 ${(nextPlaceReach.meters / 1000).toFixed(1)}km로, ${withParticle(travelModeNoun("ko", travelMode), "으로/로")} 아무리 빨라도 ${nextPlaceReach.minTravelMinutes}분이 걸립니다. 머무는 시간 ${plannedStayMinutes}분과 안전여유 ${SAFETY_BUFFER_MINUTES}분을 더하면 ${nextPlaceReach.requiredMinutes}분이 필요한데 ${nextPlaceReach.budgetMinutes}분밖에 없어 ${nextPlaceReach.shortfallMinutes}분 부족합니다. 이대로는 어떤 곳도 제안할 수 없습니다 — 이동수단을 바꾸거나, 머무는 시간을 줄이거나, 약속 시각을 늦춰 주세요.`,
                        `${nextPlace.title} is ${(nextPlaceReach.meters / 1000).toFixed(1)}km away in a straight line, which takes at least ${nextPlaceReach.minTravelMinutes} minutes. With a ${plannedStayMinutes}-minute stay and a ${SAFETY_BUFFER_MINUTES}-minute buffer you need ${nextPlaceReach.requiredMinutes} minutes but have ${nextPlaceReach.budgetMinutes} — ${nextPlaceReach.shortfallMinutes} short. Nothing can fit: change how you travel, shorten the stay, or move the appointment later.`,
                      )
                    : tr(
                        language,
                        `${nextPlace.title}까지 직선 ${(nextPlaceReach.meters / 1000).toFixed(1)}km · ${travelModeNoun(language, travelMode)} 최소 ${nextPlaceReach.minTravelMinutes}분`,
                        `${nextPlace.title} is ${(nextPlaceReach.meters / 1000).toFixed(1)}km away · at least ${nextPlaceReach.minTravelMinutes} minutes`,
                      )}
                </p>
              )}
            </>
          ) : (
            <>
              <div className={styles.searchRow}>
                <label>
                  <span className={styles.visuallyHidden}>
                    {tr(language, "다음 장소 이름", "Next place name")}
                  </span>
                  <input
                    value={nextPlaceKeyword}
                    onChange={(event) =>
                      setNextPlaceKeyword(event.target.value)
                    }
                    /* 이름을 적고 Enter를 누르는 것은 검색하겠다는 뜻이다.
                       폼 안이라 Enter를 그냥 두면 제출로 새어 나간다. */
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void searchNextPlace();
                    }}
                    maxLength={80}
                    placeholder={tr(
                      language,
                      "예: 예약한 저녁 식당",
                      "e.g. dinner reservation",
                    )}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void searchNextPlace()}
                  disabled={nextPlaceState === "loading"}
                >
                  {nextPlaceState === "loading"
                    ? tr(language, "확인 중…", "Searching…")
                    : tr(language, "장소 찾기", "Find place")}
                </button>
              </div>
              {nextPlaceError && (
                <p className={styles.messageError} role="alert">
                  {nextPlaceError}
                </p>
              )}
              {nextPlaceResults.length > 0 && (
                <ul className={styles.results}>
                  {nextPlaceResults.map((place) => (
                    <li
                      key={
                        place.providerId ||
                        place.contentId ||
                        `${place.title}-${place.latitude}`
                      }
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (place.retention === "ephemeral") {
                            setNextPlaceState("error");
                            setNextPlaceError(
                              tr(
                                language,
                                "이 결과는 현재 위치 확인에만 쓸 수 있습니다. 다른 결과를 선택해 주세요.",
                                "This result can only confirm your current location. Pick another.",
                              ),
                            );
                            return;
                          }
                          setNextPlace(place);
                          setNextPlaceResults([]);
                        }}
                      >
                        <strong>{place.title}</strong>
                        <small>{place.address || "주소 정보 없음"}</small>
                        {place.sourceLabel && (
                          <small>{place.sourceLabel}</small>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </details>

        <section className={styles.block} aria-labelledby="discover-mode">
          <h3 id="discover-mode">
            {tr(language, "어떻게 이동하나요?", "How will you travel?")}
          </h3>
          <div
            className={styles.chips}
            role="radiogroup"
            aria-label={tr(language, "이동수단", "Travel mode")}
          >
            {TRAVEL_MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={travelMode === item.value}
                className={
                  travelMode === item.value ? styles.chipActive : styles.chip
                }
                onClick={() => setTravelMode(item.value)}
              >
                {language === "en" ? item.en : item.ko}
              </button>
            ))}
          </div>
          <p className={styles.derived}>
            {travelMode === "car"
              ? tr(
                  language,
                  "TMAP 자동차 경로로 계산합니다. 주차 시간은 포함하지 않으니 여유를 조금 더 두세요.",
                  "Calculated with TMAP car routing. Parking time is not included.",
                )
              : travelMode === "transit"
                ? tr(
                    language,
                    "카카오맵 대중교통 길찾기로 계산합니다. 배차 간격에 따라 실제 소요시간이 달라질 수 있습니다.",
                    "Calculated with KakaoMap transit routing. Actual time varies with service frequency.",
                  )
                : travelMode === "bicycle"
                  ? tr(
                      language,
                      "카카오맵 자전거 길찾기로 계산합니다. 자전거 대여·주차 시간은 포함하지 않습니다.",
                      "Calculated with KakaoMap cycling routing. Rental and parking time are not included.",
                    )
                  : tr(
                      language,
                      "TMAP 보행자 경로로 계산합니다.",
                      "Calculated with TMAP pedestrian routing.",
                    )}
          </p>
        </section>

        <section className={styles.block} aria-labelledby="discover-conditions">
          <h3 id="discover-conditions">
            {tr(language, "이동·실내 조건", "Mobility and indoor")}
          </h3>
          <label className={styles.selectField}>
            <span>{tr(language, "이동·접근성 조건", "Accessibility")}</span>
            <select
              value={audience}
              onChange={(event) => setAudience(event.target.value as Audience)}
            >
              {AUDIENCES.map((item) => (
                <option key={item.value} value={item.value}>
                  {language === "en" ? AUDIENCES_EN[item.value] : item.label}
                </option>
              ))}
            </select>
          </label>
          {/* 보고 싶은 분류를 미리 고르는 자리.

              결과를 받은 뒤 걸러내는 필터는 아래에 그대로 있다. 이쪽은 조회 **전**
              이라 성격이 다르다 — 고른 분류에만 조회를 쓰므로 그 분류에서 더 많은
              곳을 확인한다. 그래서 안내 문구도 "걸러 본다"가 아니라 "더 많이
              찾는다"로 적는다. */}
          <div className={styles.selectField}>
            <span>
              {tr(
                language,
                "보고 싶은 종류 (선택)",
                "What you want to see (optional)",
              )}
            </span>
            <div
              className={styles.chips}
              role="group"
              aria-label={tr(
                language,
                "보고 싶은 관광 종류",
                "Tourism categories you want",
              )}
            >
              <button
                type="button"
                className={
                  wantedCategories.length === 0
                    ? styles.chipActive
                    : styles.chip
                }
                aria-pressed={wantedCategories.length === 0}
                onClick={() => {
                  setWantedCategories([]);
                  invalidateReferenceResult();
                }}
              >
                {tr(language, "전체", "All")}
              </button>
              {KTO_TOURISM_CATEGORIES.map((item) => {
                const on = wantedCategories.includes(item.code);
                return (
                  <button
                    key={item.code}
                    type="button"
                    className={on ? styles.chipActive : styles.chip}
                    aria-pressed={on}
                    onClick={() => {
                      setWantedCategories((current) =>
                        current.includes(item.code)
                          ? current.filter((code) => code !== item.code)
                          : [...current, item.code],
                      );
                      invalidateReferenceResult();
                    }}
                  >
                    {language === "en" ? item.labelEn : item.labelKo}
                  </button>
                );
              })}
            </div>
            <p className={styles.derived}>
              {wantedCategories.length === 0
                ? tr(
                    language,
                    "고르지 않으면 모든 종류를 함께 찾습니다.",
                    "Leave it empty to search every category together.",
                  )
                : tr(
                    language,
                    "고른 종류에만 조회를 써서 그 종류에서 더 많은 곳을 확인합니다.",
                    "We spend the lookups only on these, so you get more places within them.",
                  )}
            </p>
          </div>
          <label className={styles.checkField}>
            <input
              type="checkbox"
              checked={indoorOnly}
              onChange={(event) => setIndoorOnly(event.target.checked)}
            />
            <span>
              <strong>{tr(language, "실내 후보만 찾기", "Indoor only")}</strong>
              <small>
                {tr(
                  language,
                  "실내 여부가 확인되지 않은 후보는 제외합니다.",
                  "Excludes places whose indoor fit is unverified.",
                )}
              </small>
            </span>
          </label>
        </section>

        <button
          type="submit"
          className={styles.submit}
          disabled={
            state === "loading" ||
            !originReady ||
            originSelectionOpen ||
            stayTooLong
          }
        >
          {state === "loading"
            ? tr(language, "확인 중…", "Checking…")
            : tr(
                language,
                "선택한 시간에 다녀올 수 있는 곳 찾기",
                "Find places that fit this time",
              )}
        </button>
        <p className={styles.footnote}>
          {tr(
            language,
            "실제 이동·복귀 경로가 확인된 곳만 제안합니다. 문을 닫는다고 확인된 곳은 제외하고, 운영시간을 대조하지 못한 곳은 그 사실을 밝힌 뒤 확인을 받고 넣습니다.",
            "We only suggest places with verified outbound and return routes. Places confirmed closed are excluded; where opening hours could not be matched, we say so and ask you to confirm before adding.",
          )}
        </p>
      </form>

      <section className={styles.results2} aria-live="polite">
        <span className={styles.step}>
          {tr(language, "다녀올 수 있는 곳", "What fits")}
        </span>
        {state === "error" && (
          <p className={styles.messageError} role="alert">
            {error}
          </p>
        )}
        {state === "idle" && (
          <p className={styles.empty}>
            {tr(
              language,
              "조건을 고르면 여기에 결과가 나타납니다.",
              "Pick your conditions and results appear here.",
            )}
          </p>
        )}
        {state === "loading" && (
          <p className={styles.empty} role="status">
            {tr(
              language,
              "공식 관광정보와 실제 이동 경로를 확인하고 있습니다. 최대 25초까지 걸릴 수 있어요.",
              "Checking official tourism data and real routes. This can take up to 25 seconds.",
            )}
          </p>
        )}
        {state === "success" && result && (
          <DiscoverResults
            key={result.requestId}
            language={language}
            result={result}
            referenceTime={submittedReferenceTime}
            onPlanFromPlace={onPlanFromPlace}
            onApplyRemedy={applyRemedy}
          />
        )}
      </section>
    </div>
  );
}

/* 조건을 바꾸면 갈 수 있는 곳과, 지금은 문을 닫은 곳.

   이 두 목록은 **추천이 아니다.** 엔진이 후보로 평가하고 탈락시킨 실제 장소이며,
   각 항목에 탈락 사유가 그대로 붙는다. 그래서 "확인하지 않은 것을 확인한 척한다"는
   금지선을 넘지 않는다 — 오히려 반대쪽이다. 실측에서 1순위 탈락안이 "안전여유가
   1분 부족, 체류 60→30분이면 통과"였는데, 그것을 알면서 "찾지 못했습니다"라고만
   말하는 것이 덜 정직하다.

   시각적으로도 검증된 카드와 섞이지 않게 별도 섹션에 둔다. */
function AlternativeTiers({
  language,
  alternatives,
  onApplyRemedy,
}: {
  language: Language;
  alternatives?: RecoveryResponse["alternatives"];
  onApplyRemedy?: (remedy: { kind: string; value?: string | number }) => void;
}) {
  const nearMisses = alternatives?.nearMisses ?? [];
  const closedNow = alternatives?.closedNow ?? [];
  if (!nearMisses.length && !closedNow.length) return null;

  /* 탈락안의 완화 조건을 화면 입력으로 옮긴다. 서버는 "머무는 시간 60분 → 30분"
     처럼 목표값을 주므로 그대로 넘긴다. */
  const remedyFor = (relaxation: {
    constraint: string;
    requiredLimit: number;
  }) =>
    relaxation.constraint === "minimum_stay"
      ? { kind: "stay_minutes", value: relaxation.requiredLimit }
      : relaxation.constraint === "available_time"
        ? { kind: "window_minutes", value: relaxation.requiredLimit }
        : undefined;

  return (
    <>
      {nearMisses.length > 0 && (
        <section className={styles.rejectionPanel}>
          <strong>
            {tr(
              language,
              "조건을 바꾸면 갈 수 있는 곳",
              "Places that open up if you change one thing",
            )}
          </strong>
          <p className={styles.footnote}>
            {tr(
              language,
              "아래는 추천이 아닙니다. 실제로 확인했지만 시간이 모자라 제외한 곳이며, 얼마나 모자랐는지 그대로 적었습니다.",
              "These are not recommendations. We checked them and left them out because the time did not fit — the exact shortfall is shown.",
            )}
          </p>
          <ul>
            {nearMisses.map((entry) => {
              const remedy = entry.requiredRelaxation
                ? remedyFor(entry.requiredRelaxation)
                : undefined;
              return (
                <li key={entry.contentId}>
                  <span>
                    <strong>{entry.title}</strong>
                    {typeof entry.distanceMeters === "number" && (
                      <small>
                        {tr(
                          language,
                          ` · ${Math.round(entry.distanceMeters)}m`,
                          ` · ${Math.round(entry.distanceMeters)}m`,
                        )}
                      </small>
                    )}
                    <small>
                      {sanitizeTravelerText(entry.reason, language)}
                    </small>
                    {entry.verificationDepth === "pre_filter" && (
                      <small className={styles.detailNote}>
                        {tr(
                          language,
                          "실제 경로는 조회하지 않고 직선거리로만 판단한 곳입니다.",
                          "Judged from straight-line distance only; no real route was requested.",
                        )}
                      </small>
                    )}
                  </span>
                  {remedy && (
                    <button
                      type="button"
                      className={styles.primaryGhost}
                      onClick={() => onApplyRemedy?.(remedy)}
                    >
                      {language === "en"
                        ? "Apply and search again"
                        : `${entry.requiredRelaxation?.description} 적용`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {closedNow.length > 0 && (
        <section className={styles.rejectionPanel}>
          <strong>
            {tr(
              language,
              "지금은 문을 닫은 곳",
              "Closed at this time",
            )}
          </strong>
          <p className={styles.footnote}>
            {tr(
              language,
              "가까이 있지만 조회 기준 시각에는 공식 운영정보상 운영하지 않습니다. 다른 시각으로 조회하면 결과가 달라질 수 있습니다.",
              "Nearby, but official data says they are not open at the time you searched. Another time may change this.",
            )}
          </p>
          <ul>
            {closedNow.map((entry) => (
              <li key={entry.contentId}>
                <span>
                  <strong>{entry.title}</strong>
                  {typeof entry.distanceMeters === "number" && (
                    <small>{` · ${Math.round(entry.distanceMeters)}m`}</small>
                  )}
                  <small>{sanitizeTravelerText(entry.reason, language)}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function DiscoverResults({
  language,
  result,
  referenceTime,
  onPlanFromPlace,
  onApplyRemedy,
}: {
  language: Language;
  result: RecoveryResponse;
  referenceTime: { mode: ReferenceTimeMode; iso: string } | null;
  onPlanFromPlace?: Props["onPlanFromPlace"];
  onApplyRemedy?: (remedy: {
    kind: string;
    value?: string | number;
  }) => void;
}) {
  /* 여행 복구 화면에는 있던 정렬이 이쪽에는 없었다. 같은 대안 목록인데 한쪽
     에서만 "가까운 순"으로 볼 수 있으면 여행자는 화면마다 규칙을 새로
     배워야 한다. */
  const [sort, setSort] = useState<SimpleOptionSort>("recommended");
  const [category, setCategory] = useState("all");
  const categoryCounts = tourismCategoryCounts(result.options);
  const visibleOptions = sortSimpleOptions(
    filterOptionsByTourismCategory(result.options, category),
    sort,
  );
  const referenceTimeNotice = referenceTime ? (
    <p className={styles.referenceTimeResult} data-testid="discover-reference-time">
      <strong>{tr(language, "조회 기준", "Search reference")}</strong>{" "}
      {referenceTime.mode === "now"
        ? tr(
            language,
            `요청을 받은 현재 시각 · ${formatReferenceTime(referenceTime.iso, language)}`,
            `Current time when the request was received · ${formatReferenceTime(referenceTime.iso, language)}`,
          )
        : tr(
            language,
            `가정 시각 · ${formatReferenceTime(referenceTime.iso, language)}`,
            `Assumed time · ${formatReferenceTime(referenceTime.iso, language)}`,
          )}
    </p>
  ) : null;
  if (!result.options.length) {
    const feasibility = result.inputFeasibility;
    return (
      <div className={styles.noResult} role="status">
        {referenceTimeNotice}
        {/* 요청 자체가 불가능했던 경우에는 헤드라인이 달라야 한다. "찾지
            못했습니다"는 우리가 찾아봤다는 뜻이고, 이 경우엔 찾을 것이
            없었다는 사실과 무엇을 바꾸면 되는지가 답이다. */}
        {feasibility ? (
          <>
            <strong>
              {tr(
                language,
                "지금 조건으로는 어떤 곳도 들어갈 수 없습니다.",
                "No place can fit these conditions.",
              )}
            </strong>
            {(result.warnings ?? [])
              .filter((warning) => /부족합니다|남지 않습니다/.test(warning))
              .map((warning, index) => (
                <p key={index}>{sanitizeTravelerText(warning, language)}</p>
              ))}
            {(feasibility.remedies?.length ?? 0) > 0 && (
              <section
                className={styles.counterfactual}
                aria-labelledby="discover-remedies"
              >
                <strong id="discover-remedies">
                  {tr(
                    language,
                    "이 중 하나만 바꾸면 바로 찾아 드립니다",
                    "Change any one of these and we search again",
                  )}
                </strong>
                <div className={styles.originActions}>
                  {feasibility.remedies?.map((remedy) => (
                    <button
                      key={`${remedy.kind}-${String(remedy.value ?? "")}`}
                      type="button"
                      className={styles.primaryGhost}
                      onClick={() => onApplyRemedy?.(remedy)}
                    >
                      {language === "en" ? remedy.labelEn : remedy.label}
                    </button>
                  ))}
                </div>
                <p className={styles.footnote}>
                  {tr(
                    language,
                    "직선거리와 각 이동수단의 최고 속도로만 계산한 판정이라, 어떤 경로로도 이보다 빠를 수 없습니다. 그래서 공식 관광정보는 조회하지 않았습니다.",
                    "This verdict uses straight-line distance at each mode's top speed, so no real route can beat it. We did not query official tourism data.",
                  )}
                </p>
              </section>
            )}
          </>
        ) : (
        <>
        <strong>
          {tr(
            language,
            "이 시간 안에 다녀올 수 있는 곳을 찾지 못했습니다.",
            "Nothing fits inside this window.",
          )}
        </strong>
        {(result.warnings ?? []).map((warning, index) => (
          <p key={index}>{sanitizeTravelerText(warning, language)}</p>
        ))}
        {(result.rejectionSummary?.length ?? 0) > 0 && (
          <section
            className={styles.rejectionPanel}
            aria-labelledby="discover-empty-reasons"
          >
            <strong id="discover-empty-reasons">
              {tr(
                language,
                "제외된 실제 이유",
                "Why nearby places were excluded",
              )}
            </strong>
            <ul>
              {result.rejectionSummary?.map((entry) => (
                <li key={entry.reasonCode}>
                  <span>
                    {REJECTION_COPY[entry.reasonCode]?.[language] ??
                      tr(
                        language,
                        "필수 안전 조건을 충족하지 못함",
                        "A required safety condition was not met",
                      )}
                  </span>
                  <b>
                    {tr(
                      language,
                      `${entry.count}곳`,
                      `${entry.count} place${entry.count === 1 ? "" : "s"}`,
                    )}
                  </b>
                </li>
              ))}
            </ul>
          </section>
        )}
        {result.counterfactual && (
          <section className={styles.counterfactual}>
            <strong>
              {tr(
                language,
                "결과를 만들 수 있는 최소 변경",
                "Smallest change that may produce a result",
              )}
            </strong>
            <p>{counterfactualGuidance(result.counterfactual, language)}</p>
          </section>
        )}
        </>
        )}
        {/* 엔진이 이미 계산해 두고 버리던 두 부류. 추천이 아니라 **탈락한
            후보를 탈락한 상태로** 보여 주는 자리다. */}
        <AlternativeTiers
          language={language}
          alternatives={result.alternatives}
          onApplyRemedy={onApplyRemedy}
        />
        <p>
          {tr(
            language,
            "머무는 시간을 줄이거나 남은 시간을 더 길게 잡으면 결과가 달라질 수 있습니다. 존재하지 않는 장소를 만들어 추천하지는 않습니다.",
            "A shorter stay or a longer window may change this. We never invent a place to fill the gap.",
          )}
        </p>
        <SourceLedgerDisclosure
          ledger={result.sourceLedger}
          language={language}
        />
      </div>
    );
  }

  return (
    <>
      {referenceTimeNotice}
      {result.options.length > 1 && (
        <>
          <div
            className={styles.sortRow}
            role="group"
            aria-label={tr(language, "정렬", "Sort")}
          >
            {(
              [
                ["recommended", "추천순", "Recommended"],
                ["nearest_first", "가까운 순", "Nearest"],
                ["quiet_first", "한적한 순", "Quietest"],
                ["busy_first", "붐비는 순", "Busiest"],
              ] as const
            ).map(([value, ko, en]) => (
              <button
                key={value}
                type="button"
                className={sort === value ? styles.sortActive : styles.sortChip}
                aria-pressed={sort === value}
                onClick={() => setSort(value)}
              >
                {tr(language, ko, en)}
              </button>
            ))}
          </div>
          {sort === "recommended" && (
            <p className={styles.sortNote}>
              {tr(
                language,
                "추천순은 안전 조건을 통과한 뒤 최소 변경·편안함·지역 발견을 대표하는 안을 먼저 보여줍니다. 표시 점수는 기초 적합도라 단순 점수순과 다를 수 있습니다.",
                "Recommended order shows representative options for minimal change, comfort and local discovery after safety checks. The displayed score is Base fit, so this is not a simple score ranking.",
              )}
            </p>
          )}
        </>
      )}
      <div
        className={styles.sortRow}
        role="radiogroup"
        aria-label={tr(
          language,
          "공식 관광 분류로 필터",
          "Filter by official tourism category",
        )}
      >
        <button
          type="button"
          role="radio"
          className={category === "all" ? styles.sortActive : styles.sortChip}
          aria-checked={category === "all"}
          onClick={() => setCategory("all")}
        >
          {tr(language, "전체", "All")} {result.options.length}
        </button>
        {categoryCounts.map((entry) => (
          <button
            key={entry.code}
            type="button"
            role="radio"
            className={
              category === entry.code ? styles.sortActive : styles.sortChip
            }
            aria-checked={category === entry.code}
            onClick={() => setCategory(entry.code)}
          >
            {language === "en" ? entry.labelEn : entry.labelKo} {entry.count}
          </button>
        ))}
      </div>
      <ul className={styles.cards}>
        {visibleOptions.map((option, index) => (
          <DiscoverOptionCard
            key={option.id || option.contentId || `${option.title}-${index}`}
            option={option}
            language={language}
            generatedAt={result.generatedAt}
            onPlanFromPlace={onPlanFromPlace}
          />
        ))}
      </ul>

      {/* 예전에는 "조건을 통과하지 못한 후보 N곳은 제시하지 않았습니다"라고
          적었다. 두 가지가 잘못됐다. 첫째, 여행에 정답이 없는데 우리가 통과·
          탈락을 선고하는 말투다. 둘째, 그 N곳이 무엇인지 알려 주지 않으므로
          여행자는 자기가 무엇을 못 봤는지도 모른다.

          엔진은 confirmed_open으로 확인되지 않은 후보(휴무·운영 미확인·상위
          운영정보 장애)를 안전하게 목록에서 제외한다. 이 화면은 제외 건수를
          뭉개지 않고 사유별로 보여 주며, 사용자가 조건을 바꿔 다시 찾을 수 있는
          경우에는 counterfactual 안내도 함께 보존한다. */}
      {(result.rejectionSummary?.length ?? 0) > 0 ? (
        <section
          className={styles.rejectionPanel}
          aria-labelledby="discover-rejection-reasons"
        >
          <strong id="discover-rejection-reasons">
            {tr(
              language,
              "목록에서 제외된 이유",
              "Why other nearby places were excluded",
            )}
          </strong>
          <ul>
            {result.rejectionSummary?.map((entry) => (
              <li key={entry.reasonCode}>
                <span>
                  {REJECTION_COPY[entry.reasonCode]?.[language] ??
                    tr(
                      language,
                      "필수 안전 조건을 충족하지 못함",
                      "A required safety condition was not met",
                    )}
                </span>
                <b>
                  {tr(
                    language,
                    `${entry.count}곳`,
                    `${entry.count} place${entry.count === 1 ? "" : "s"}`,
                  )}
                </b>
              </li>
            ))}
          </ul>
        </section>
      ) : typeof result.rejectedCount === "number" &&
        result.rejectedCount > 0 ? (
        <p className={styles.rejected}>
          {tr(
            language,
            `근처 ${result.rejectedCount}곳은 안전 조건을 충족하지 못해 목록에서 빠졌습니다.`,
            `${result.rejectedCount} nearby places did not meet the required safety conditions.`,
          )}
        </p>
      ) : null}
      {result.counterfactual && (
        <section className={styles.counterfactual}>
          <strong>
            {tr(
              language,
              "조건을 최소한으로 바꾸려면",
              "Smallest useful condition change",
            )}
          </strong>
          <p>{counterfactualGuidance(result.counterfactual, language)}</p>
        </section>
      )}
      {/* 결과가 있어도 보여 준다. "17곳 찾았고, 조건을 바꾸면 여섯 곳이 더
          열린다"는 것은 결과가 0곳일 때만 쓸모 있는 정보가 아니다. */}
      <AlternativeTiers
        language={language}
        alternatives={result.alternatives}
        onApplyRemedy={onApplyRemedy}
      />
      {(result.warnings ?? []).map((warning, index) => (
        <p key={index} className={styles.warning}>
          {sanitizeTravelerText(warning, language)}
        </p>
      ))}
      <SourceLedgerDisclosure
        ledger={result.sourceLedger}
        language={language}
      />
    </>
  );
}

/* 카드 하나. 예전에는 이 내용이 전부 펼쳐진 채 세로로 이어져, 후보 세 곳만 있어도
   화면을 한참 굴려야 다음 후보가 나왔다. 늘어난 것은 정보가 아니라 **우리가 무엇을
   확인했는지에 대한 서술**이었다 — "…확인했습니다", "…판단하지 않았습니다".

   그래서 두 층으로 나눈다. 요약은 고를 때 실제로 쓰는 값만 — 어디인지, 언제 나가
   언제 돌아오는지, 그 길이 어디로 가는지, 그리고 운영시간·대표메뉴처럼 갈지 말지를
   가르는 사실 몇 개. 나머지 근거는 상세보기 안에 둔다.

   안전 경고만은 접지 않는다. 문을 닫는 곳이거나 검증되지 않은 후보라는 사실을
   한 번 더 눌러야 보이게 하면, 접힌 채로 일정에 넣는 사람이 생긴다. */
function DiscoverOptionCard({
  option,
  language,
  generatedAt,
  onPlanFromPlace,
}: {
  option: RecoveryOption;
  language: Language;
  generatedAt?: string;
  onPlanFromPlace?: Props["onPlanFromPlace"];
}) {
  const [expanded, setExpanded] = useState(false);
  /* 운영시간을 대조하지 못한 곳을 일정에 넣기 직전에 한 번 묻는다. 카드에는
     이미 그 사실이 적혀 있지만, 읽고 넘어간 사람과 읽지 않은 사람을 화면이
     구별할 수는 없다. 넣는 순간은 되돌리기 어려운 행동이므로 그때 한 번 더
     보여 준다. */
  const [confirmingHours, setConfirmingHours] = useState(false);
  const window = option.scheduleDiff?.openWindow;
  /* 카드 문구의 수단은 서버가 실제로 쓴 경로 제공자를 따라야 한다. 화면 상태
     (선택한 수단)로 쓰면 조회가 실패해 다른 수단으로 내려간 경우에도 잘못된
     이름이 적힌다. */
  const routeProvider = readText(
    asRecord(asRecord(option.continuityProof)?.routeEvidence),
    ["provider"],
  );
  const modeVerb =
    routeProvider === "tmap_car"
      ? { ko: "차로", noun: "자동차", en: "drive" }
      : routeProvider === "kakao_transit"
        ? { ko: "대중교통으로", noun: "대중교통", en: "transit" }
        : routeProvider === "kakao_bicycle"
          ? { ko: "자전거로", noun: "자전거", en: "cycle" }
          : { ko: "걸어서", noun: "보행", en: "walk" };
  const safety = optionApplicationSafety(option, language);
  /* 운영시간만 확인되지 않은 곳은 막지 않는다. 목록에서 지우면 여행자는 그런
     곳이 있었다는 사실조차 모르고, 카드만 흐리게 두면 왜 못 고르는지 모른 채
     남는다. 다른 곳과 똑같이 보여 주고, 넣을 때 확인을 받는다. */
  const needsHoursConfirmation = safety.hoursUnconfirmedOnly;
  const isBlocked = !safety.canApply && !needsHoursConfirmation;
  const addPlace = () =>
    onPlanFromPlace?.({
      title: option.title,
      address: option.address ?? "",
      contentTypeId: option.contentTypeId,
    });
  const resultGeneratedAtMs = Date.parse(generatedAt ?? "");
  const windowStartAtMs = Date.parse(window?.windowStartAt ?? "");
  const leavesLater =
    Number.isFinite(resultGeneratedAtMs) &&
    Number.isFinite(windowStartAtMs) &&
    windowStartAtMs > resultGeneratedAtMs + 60_000;

  const facts = option.travelerFacts ?? [];
  /* 요약에 넣는 값은 네 개까지. 그 이상은 요약이 아니라 목록이 된다. 나머지는
     상세보기가 전부 보여 주므로 잘려서 사라지는 값은 없다. */
  const summaryFacts = facts.filter((fact) => fact.prominent).slice(0, 4);
  const detailFacts = facts.filter((fact) => !summaryFacts.includes(fact));
  const reasons = (language === "en" && option.whyEn) || option.why || [];
  const detailId = `discover-detail-${option.id || option.contentId}`;

  const factValue = (fact: TravelerFact) =>
    (language === "en" && fact.valueEn) || fact.value;
  const factLabel = (fact: TravelerFact) =>
    language === "en" ? fact.labelEn : fact.label;
  const hoursFact = facts.find((fact) => fact.code === "hours");
  const contactFact = facts.find((fact) => fact.code === "contact");

  return (
    <li
      className={isBlocked ? styles.cardUnverified : styles.card}
      data-testid="discover-option"
    >
      <div className={styles.cardHead}>
        <div>
          {option.tourismCategory && (
            <span className={styles.categoryBadge}>
              {language === "en"
                ? option.tourismCategory.labelEn
                : option.tourismCategory.labelKo}
            </span>
          )}
          <p>{option.address || "주소 정보 확인 필요"}</p>
          <h3>{option.title}</h3>
        </div>
        {typeof option.score === "number" && (
          <span className={styles.score}>
            <b>{Math.round(option.score)}</b>
            <small>{tr(language, "기초 적합도", "Base fit")}</small>
          </span>
        )}
      </div>

      {window && (
        <ol className={styles.timeline}>
          <li>
            <span>
              {window.windowStartAt && leavesLater
                ? tr(
                    language,
                    `${formatIsoTime(window.windowStartAt, language)} 출발`,
                    `Leave at ${formatIsoTime(window.windowStartAt, language)}`,
                  )
                : tr(language, "지금 출발", "Leave now")}
            </span>
            <strong>
              {tr(
                language,
                `${modeVerb.ko} ${window.travelToMinutes}분`,
                `${window.travelToMinutes} min ${modeVerb.en}`,
              )}
            </strong>
          </li>
          <li>
            <span>
              {formatIsoTime(
                option.scheduleDiff?.replacementNode?.startAt,
                language,
              )}
              {tr(language, " 도착", " arrive")}
            </span>
            <strong>
              {tr(
                language,
                `${window.appliedStayMinutes}분 머물기`,
                `stay ${window.appliedStayMinutes} min`,
              )}
              {/* 엔진이 창에 맞추려고 체류를 줄인 경우. 줄인 값만 보여 주면
                  여행자는 자기가 고른 시간이 그대로 반영된 줄 안다. 요청값과
                  다르다는 사실을 같은 자리에서 말한다. */}
              {typeof window.plannedStayMinutes === "number" &&
                window.appliedStayMinutes < window.plannedStayMinutes && (
                  <small className={styles.detailNote}>
                    {tr(
                      language,
                      `요청 ${window.plannedStayMinutes}분에서 ${window.plannedStayMinutes - window.appliedStayMinutes}분 줄여 남은 시간에 맞췄습니다`,
                      `shortened by ${window.plannedStayMinutes - window.appliedStayMinutes} min from the ${window.plannedStayMinutes} you asked for, to fit your window`,
                    )}
                  </small>
                )}
            </strong>
          </li>
          <li>
            <span>
              {window.returnBasis === "next_place_route"
                ? tr(language, "다음 장소로", "On to next place")
                : tr(language, "돌아오기", "Return")}
            </span>
            <strong>
              {tr(
                language,
                `${window.returnMinutes}분`,
                `${window.returnMinutes} min`,
              )}
            </strong>
          </li>
        </ol>
      )}

      {(() => {
        /* 엔진이 이미 좌표열을 보내는데 화면에서 쓰지 않아, 여행자는 "몇 분"만
           보고 그 길이 어디로 가는지 알 수 없었다. */
        const geometry = (option.routeGeometry ?? []) as RoutePoint[];
        if (geometry.length < 2) return null;
        const markers: RouteMapMarker[] = [
          {
            point: geometry[0],
            label: tr(language, "현재 위치", "You are here"),
            kind: "origin",
          },
          {
            point: {
              latitude: option.latitude,
              longitude: option.longitude,
            },
            label: option.title,
            kind: "replacement",
          },
        ];
        /* 다음 장소를 알려 준 경우에는 경로의 끝이 그 장소다. */
        if (window?.returnBasis === "next_place_route") {
          markers.push({
            point: geometry[geometry.length - 1],
            label: tr(language, "다음 장소", "Next place"),
            kind: "destination",
          });
        }
        return (
          <RouteMap
            geometry={geometry}
            markers={markers}
            mode={
              routeProvider === "tmap_car"
                ? "car"
                : routeProvider === "kakao_transit"
                  ? "transit"
                  : routeProvider === "kakao_bicycle"
                    ? "bicycle"
                    : "walk"
            }
            attribution={readText(
              asRecord(asRecord(option.continuityProof)?.routeEvidence),
              ["attribution"],
            )}
            language={language}
            summary={tr(
              language,
              `현재 위치에서 ${option.title}까지 ${modeVerb.noun} 경로 개요. ${window ? `이동 ${window.travelToMinutes}분, 체류 ${window.appliedStayMinutes}분, 복귀 ${window.returnMinutes}분.` : ""}`,
              `Route outline from your location to ${option.title}.`,
            )}
          />
        );
      })()}

      {summaryFacts.length > 0 && (
        <dl className={styles.factGrid}>
          {summaryFacts.map((fact) => (
            <div key={fact.code} className={styles.fact}>
              <dt>{factLabel(fact)}</dt>
              <dd>{factValue(fact)}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* 운영시간만 확인되지 않은 곳은 카드에 한 줄로 밝힌다. 넣을 때 묻기는
          하지만, 고르기 전에 알고 있어야 그 물음이 갑작스럽지 않다. */}
      {needsHoursConfirmation && (
        <p className={styles.hoursUnverified}>
          {tr(
            language,
            "운영시간을 공식 정보로 확인하지 못했습니다. 방문 전 확인이 필요합니다.",
            "Opening hours are not confirmed by official data — please check before visiting.",
          )}
        </p>
      )}

      {/* 접지 않는다. 이 후보를 일정에 넣으면 헛걸음하거나 다음 일정에 늦을 수
          있다는 경고이며, 한 번 더 눌러야 보이면 경고가 아니다. */}
      {isBlocked && (
        <section className={styles.gaps} role="alert">
          <strong>
            {tr(
              language,
              safety.availabilityStatus === "confirmed_closed"
                ? "이 시간에는 문을 열지 않아 선택할 수 없습니다"
                : "공식 확인 전에는 선택할 수 없습니다",
              safety.availabilityStatus === "confirmed_closed"
                ? "Closed during this visit — unavailable"
                : "Unavailable until required evidence is verified",
            )}
          </strong>
          <ul>
            {safety.reasons.map((reason, reasonIndex) => (
              <li key={`${option.id}-safety-${reasonIndex}`}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.detailToggle}
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded
            ? tr(language, "상세정보 접기", "Hide details")
            : tr(language, "상세보기", "See details")}
        </button>
        {/* 찾은 곳을 일정으로 가져간다. 이 화면은 "지금 갈 곳"을 알려 주고
            끝나서, 마음에 드는 곳을 찾아도 다음 약속과 맞는지 따져 보려면
            이름을 외워 다른 탭에 다시 입력해야 했다. */}
        {onPlanFromPlace && (
          <button
            type="button"
            className={styles.planFromPlace}
            disabled={isBlocked}
            onClick={() => {
              if (isBlocked) return;
              if (needsHoursConfirmation) {
                setConfirmingHours(true);
                return;
              }
              addPlace();
            }}
          >
            {isBlocked
              ? tr(language, "안전 확인 전 추가 불가", "Cannot add until verified")
              : tr(language, "이 곳을 일정에 넣기", "Add this to my plan")}
          </button>
        )}
      </div>

      {confirmingHours && (
        <section
          className={styles.hoursConfirm}
          role="group"
          aria-label={tr(
            language,
            "운영시간 확인 안내",
            "Opening hours not confirmed",
          )}
        >
          <strong>
            {tr(
              language,
              "운영시간을 확인하지 못했습니다",
              "We could not confirm the opening hours",
            )}
          </strong>
          <p>
            {tr(
              language,
              "한국관광공사 공식 정보에 이 곳의 운영시간이 없거나, 도착 시각과 대조할 수 없는 형식으로 적혀 있습니다. 도착했을 때 문이 닫혀 있을 수 있습니다.",
              "The official tourism data either has no opening hours for this place, or states them in a form we cannot match against your arrival time. It may be closed when you get there.",
            )}
          </p>
          {/* 우리가 들고 있는 원문은 그대로 보여 준다. 기계가 못 읽는 것과
              사람이 못 읽는 것은 다르다. */}
          {hoursFact && (
            <p className={styles.hoursConfirmSource}>
              <b>{tr(language, "공식 표기", "Official text")}</b>{" "}
              {factValue(hoursFact)}
            </p>
          )}
          {contactFact && (
            <p className={styles.hoursConfirmSource}>
              <b>{tr(language, "문의", "Phone")}</b> {factValue(contactFact)}
            </p>
          )}
          <p>
            {tr(
              language,
              "출발 전에 전화나 검색으로 운영 여부를 확인해 주세요.",
              "Please check by phone or search before you set out.",
            )}
          </p>
          <div className={styles.hoursConfirmActions}>
            <button
              type="button"
              className={styles.hoursConfirmProceed}
              onClick={() => {
                setConfirmingHours(false);
                addPlace();
              }}
            >
              {tr(
                language,
                "확인했습니다, 일정에 넣기",
                "I understand — add it",
              )}
            </button>
            <button type="button" onClick={() => setConfirmingHours(false)}>
              {tr(language, "취소", "Cancel")}
            </button>
          </div>
        </section>
      )}

      {expanded && (
        <div className={styles.detail} id={detailId}>
          {detailFacts.length > 0 && (
            <dl className={styles.factGrid}>
              {detailFacts.map((fact) => (
                <div key={fact.code} className={styles.fact}>
                  <dt>{factLabel(fact)}</dt>
                  <dd>{factValue(fact)}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* 붐빔 수치를 인원수로 읽지 말라는 단서는 `why`가 들고 온다. 여기서
              한 번 더 적으면 같은 상세 안에 두 번 나온다. */}
          {option.purposePreservation?.statement && (
            <p className={styles.purpose}>
              {(language === "en" && option.purposePreservation.statementEn) ||
                option.purposePreservation.statement}
            </p>
          )}

          {reasons.length > 0 && (
            <ul className={styles.why}>
              {reasons.map((reason, reasonIndex) => (
                <li key={reasonIndex}>{reason}</li>
              ))}
            </ul>
          )}

          {window && (
            <p
              className={
                window.leftoverMinutes >= window.requiredBufferMinutes
                  ? styles.fitGood
                  : styles.fitTight
              }
            >
              {window.returnBasis === "next_place_route"
                ? tr(
                    language,
                    `다음 장소 도착까지 ${window.leftoverMinutes}분 여유가 남아, 필수 안전여유 ${window.requiredBufferMinutes}분을 확보했습니다.`,
                    `${window.leftoverMinutes} min of slack remains before your next place, meeting the ${window.requiredBufferMinutes}-min safety reserve.`,
                  )
                : tr(
                    language,
                    `복귀 뒤 ${window.leftoverMinutes}분 여유가 남아, 필수 안전여유 ${window.requiredBufferMinutes}분을 확보했습니다.`,
                    `${window.leftoverMinutes} min remains after returning, meeting the ${window.requiredBufferMinutes}-min safety reserve.`,
                  )}
            </p>
          )}

          {window?.returnBasis === "origin_return_route" && (
            <p className={styles.returnEvidence}>
              {tr(
                language,
                `복귀 근거 · ${returnProviderLabel(window.returnProvider, language)}${
                  typeof window.returnDistanceMeters === "number"
                    ? ` · ${window.returnDistanceMeters.toLocaleString("ko-KR")}m`
                    : ""
                }`,
                `Return evidence · ${returnProviderLabel(window.returnProvider, language)}${
                  typeof window.returnDistanceMeters === "number"
                    ? ` · ${window.returnDistanceMeters.toLocaleString("en-US")} m`
                    : ""
                }`,
              )}
            </p>
          )}

          {isBlocked && (
            <p className={styles.detailNote}>
              {tr(
                language,
                "헛걸음과 다음 일정 지연을 막기 위해 이 후보는 일정에 넣을 수 없습니다.",
                "This option cannot be added because it could cause a wasted trip or delay the next appointment.",
              )}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
