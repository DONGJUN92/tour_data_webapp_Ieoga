"use client";

/* 지금 갑자기 시간이 생긴 여행자를 위한 화면. 일정 복구 탭과 엔진·검증·저장을
   공유하지만 입력과 설명이 다르다. 복구는 "무엇을 바꿀까"이고 이 화면은 "이 시간
   안에 무엇을 다녀올 수 있을까"이므로, 카드도 바뀐 일정 수가 아니라 도착·체류·
   복귀·남는 여유를 보여준다.

   시각은 30분 격자로만 받는다. 여행자는 분 단위로 계획하지 않으며, 분 단위
   입력을 허용하면 검증은 정확해지지만 아무도 세우지 않는 계획을 검증하게 된다. */

import { useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./DiscoverWindowPanel.module.css";
import { ManualLocationPicker, type ManualPlace } from "./ManualLocationPicker";
import { RouteMap, type RouteMapMarker, type RoutePoint } from "./RouteMap";
import {
  optionApplicationSafety,
  windowEndIsoFromMinutes,
} from "./traveler-safety";
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

/* 출발 시각은 여행 중 한 손으로도 고를 수 있게 상대 시각 칩으로 받는다. 같은
   화면의 종료 시각 선택과 마찬가지로 30분 단위를 쓰되, 계산할 때는 두 시각을
   반드시 같은 `now`에 고정한다. */
const DEPARTURE_DELAY_CHOICES = [0, 30, 60, 90, 120] as const;

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

function departureDelayLabel(language: Language, minutes: number): string {
  if (minutes === 0) return tr(language, "지금", "Now");
  if (minutes < 60) {
    return tr(language, `${minutes}분 후`, `In ${minutes} min`);
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return tr(
    language,
    remainder ? `${hours}시간 ${remainder}분 후` : `${hours}시간 후`,
    remainder ? `In ${hours}h ${remainder}m` : `In ${hours}h`,
  );
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
  const [originSelectionOpen, setOriginSelectionOpen] = useState(false);
  const automaticLocationButtonRef = useRef<HTMLButtonElement>(null);
  const [departureDelayMinutes, setDepartureDelayMinutes] = useState(0);
  const [windowMinutes, setWindowMinutes] = useState<number>(120);
  const [windowEndIso, setWindowEndIso] = useState(() =>
    windowEndIsoFromMinutes(120),
  );
  const [plannedStayMinutes, setPlannedStayMinutes] = useState<number>(60);
  const [audience, setAudience] = useState<Audience>("general");
  const [travelMode, setTravelMode] = useState<TravelMode>("walk");
  const [indoorOnly, setIndoorOnly] = useState(false);
  const [nextPlaceKeyword, setNextPlaceKeyword] = useState("");
  const [nextPlace, setNextPlace] = useState<PlaceSearchResult | null>(null);
  const [nextPlaceResults, setNextPlaceResults] = useState<PlaceSearchResult[]>(
    [],
  );
  const [nextPlaceState, setNextPlaceState] = useState<LoadState>("idle");
  const [nextPlaceError, setNextPlaceError] = useState("");
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<RecoveryResponse | null>(null);

  const windowEndLabel = useMemo(
    () => formatWindowEnd(windowEndIso, language),
    [windowEndIso, language],
  );
  /* 표시용 시작 시각도 종료 시각과 같은 기준점에서 역산한다. 사용자가 조건을
     바꿀 때 두 라벨의 기준 시각이 몇 초씩 어긋나는 일을 막는다. 제출 직전에는
     아래 `submit`에서 하나의 최신 now로 둘을 다시 확정한다. */
  const departureAtIso = useMemo(
    () =>
      new Date(
        Date.parse(windowEndIso) -
          (windowMinutes - departureDelayMinutes) * 60_000,
      ).toISOString(),
    [departureDelayMinutes, windowEndIso, windowMinutes],
  );
  const departureAtLabel = useMemo(
    () => formatWindowEnd(departureAtIso, language),
    [departureAtIso, language],
  );
  const originReady =
    geoState === "success" &&
    Number.isFinite(Number(origin.latitude)) &&
    Number.isFinite(Number(origin.longitude)) &&
    origin.latitude.trim() !== "" &&
    origin.longitude.trim() !== "" &&
    origin.label.trim() !== "";

  /* 출발을 미루는 동안은 여행에 쓸 수 있는 시간이 아니다. 예를 들어 지금부터
     2시간 비어 있어도 1시간 뒤에 출발하면 실제 이동·체류·복귀 창은 1시간이다. */
  const effectiveWindowMinutes = Math.max(
    0,
    windowMinutes - departureDelayMinutes,
  );
  const departureOutsideWindow = departureDelayMinutes >= windowMinutes;
  const stayTooLong =
    !departureOutsideWindow && plannedStayMinutes >= effectiveWindowMinutes;

  function beginOriginReselection() {
    setManualOpen(false);
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
    if (departureOutsideWindow) {
      setState("error");
      setError(
        tr(
          language,
          "출발 시각이 자유 시간 종료 시각과 같거나 늦습니다. 더 이른 출발 시각이나 더 긴 남은 시간을 선택해 주세요.",
          "Your departure is at or after the end of your free time. Leave earlier or choose a longer window.",
        ),
      );
      return;
    }
    if (stayTooLong) {
      setState("error");
      setError(
        tr(
          language,
          "선택한 출발 시각 뒤의 실제 남은 시간보다 체류 시간이 깁니다. 이동과 복귀 시간이 들어갈 자리가 없습니다.",
          "Your stay fills the time remaining after departure, leaving no room to travel and return.",
        ),
      );
      return;
    }
    setState("loading");
    setResult(null);
    try {
      /* 출발과 종료를 같은 기준 시각에서 만든다. `Date.now()`를 두 번 읽으면
         30분 뒤 출발과 2시간 뒤 종료 사이가 네트워크·렌더 시간만큼 조용히
         짧아질 수 있다. */
      const requestNowMs = Date.now();
      const requestDepartureAtIso = new Date(
        requestNowMs + departureDelayMinutes * 60_000,
      ).toISOString();
      const requestWindowEndIso = windowEndIsoFromMinutes(
        windowMinutes,
        requestNowMs,
      );
      setWindowEndIso(requestWindowEndIso);
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
          /* 대기시간을 여행 가능 시간으로 세지 않는다. */
          availableMinutes: effectiveWindowMinutes,
          audience,
          indoorOnly,
          travelMode,
          safetyBufferMinutes: 15,
          minimumStayMinutes: Math.min(plannedStayMinutes, 180),
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
                  arriveBy: requestWindowEndIso,
                }
              : undefined,
          },
        }),
      });
      const record = asRecord(payload);
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
      });
      setState("success");
    } catch (submitError) {
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
      <form className={styles.form} onSubmit={submit}>
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
                className={styles.primaryGhost}
                onClick={requestAutomaticLocation}
                disabled={geoState === "loading"}
              >
                {geoState === "loading"
                  ? tr(language, "확인 중…", "Locating…")
                  : tr(language, "현재 위치 자동 입력", "Use my location")}
              </button>
              <button
                type="button"
                onClick={() => setManualOpen((open) => !open)}
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

        <section className={styles.block} aria-labelledby="discover-departure">
          <h3 id="discover-departure">
            {tr(language, "언제 출발할까요?", "When will you leave?")}
          </h3>
          <div
            className={styles.chips}
            role="radiogroup"
            aria-label={tr(language, "출발 시각", "Departure time")}
            aria-describedby="discover-departure-summary"
          >
            {DEPARTURE_DELAY_CHOICES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                role="radio"
                aria-checked={departureDelayMinutes === minutes}
                className={
                  departureDelayMinutes === minutes
                    ? styles.chipActive
                    : styles.chip
                }
                onClick={() => {
                  const selectionNowMs = Date.now();
                  setDepartureDelayMinutes(minutes);
                  setWindowEndIso(
                    windowEndIsoFromMinutes(windowMinutes, selectionNowMs),
                  );
                }}
              >
                {departureDelayLabel(language, minutes)}
              </button>
            ))}
          </div>
          <p className={styles.derived} id="discover-departure-summary">
            {tr(
              language,
              departureDelayMinutes === 0
                ? "현재 시각에 출발하는 것으로 계산합니다."
                : `${departureAtLabel} 출발로 계산합니다. 기다리는 시간은 여행 가능 시간에서 제외합니다.`,
              departureDelayMinutes === 0
                ? "Calculated for departure now."
                : `Calculated for departure at ${departureAtLabel}. Waiting time is excluded from the travel window.`,
            )}
          </p>
        </section>

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
                  setWindowMinutes(minutes);
                  setWindowEndIso(windowEndIsoFromMinutes(minutes));
                }}
              >
                {minutesLabel(language, minutes)}
              </button>
            ))}
          </div>
          <p className={styles.derived}>
            {tr(
              language,
              `${windowEndLabel}까지 비어 있습니다. 출발 뒤 실제 이동·체류·복귀 가능 시간은 ${minutesLabel(language, effectiveWindowMinutes)}입니다.`,
              `You are free until ${windowEndLabel}. ${minutesLabel(language, effectiveWindowMinutes)} remains after departure for travel, the visit and return.`,
            )}
          </p>
          {departureOutsideWindow && (
            <p className={styles.messageError} role="alert">
              {tr(
                language,
                "출발 시각이 자유 시간 종료 시각과 같거나 늦습니다. 더 이른 출발 시각이나 더 긴 남은 시간을 선택해 주세요.",
                "Your departure is at or after the end of your free time. Leave earlier or choose a longer window.",
              )}
            </p>
          )}
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
                "선택한 출발 시각 뒤의 실제 남은 시간보다 체류 시간이 깁니다. 이동과 복귀 시간이 들어갈 자리가 없습니다.",
                "Your stay fills the time remaining after departure, leaving no room to travel and return.",
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
              "알려 주시면 그곳 도착까지 실제 경로로 검증하고, 가는 길에 들를 수 있는 곳만 제안합니다. 알려 주지 않으면 출발지로 되돌아오는 시간까지 계산합니다.",
              "If you tell us, we verify arrival there on a real route and only suggest stops on the way. If not, we calculate the time to return to where you are now.",
            )}
          </p>
          {nextPlace ? (
            <p className={styles.originReady}>
              <strong>{nextPlace.title}</strong>
              <button
                type="button"
                onClick={() => {
                  setNextPlace(null);
                  setNextPlaceResults([]);
                  setNextPlaceKeyword("");
                }}
              >
                {tr(language, "지우기", "Clear")}
              </button>
            </p>
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
            departureOutsideWindow ||
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
            "실제 이동·복귀 경로와 체류 시간 전체의 운영 여부가 확인된 곳만 선택할 수 있습니다. 미확인 후보는 사유와 함께 차단합니다.",
            "Only places with verified outbound and return routes and confirmed opening for the full stay can be selected. Unverified options are blocked with a reason.",
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
              "공식 관광정보와 실제 보행 경로를 확인하고 있습니다. 최대 20초까지 걸릴 수 있어요.",
              "Checking official tourism data and a real walking route. This can take up to 20 seconds.",
            )}
          </p>
        )}
        {state === "success" && result && (
          <DiscoverResults
            key={result.requestId}
            language={language}
            result={result}
            onPlanFromPlace={onPlanFromPlace}
          />
        )}
      </section>
    </div>
  );
}

function DiscoverResults({
  language,
  result,
  onPlanFromPlace,
}: {
  language: Language;
  result: RecoveryResponse;
  onPlanFromPlace?: Props["onPlanFromPlace"];
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
  if (!result.options.length) {
    return (
      <div className={styles.noResult} role="status">
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
        {visibleOptions.map((option, index) => {
          const window = option.scheduleDiff?.openWindow;
          /* 카드 문구의 수단은 서버가 실제로 쓴 경로 제공자를 따라야 한다.
             화면 상태(선택한 수단)로 쓰면 자차 조회가 실패해 보행으로 내려간
             경우에도 "차로 12분"이라고 적힌다. */
          /* 카드 문구의 수단은 서버가 실제로 쓴 경로 제공자를 따라야 한다.
             화면 상태(선택한 수단)로 쓰면 조회가 실패해 다른 수단으로 내려간
             경우에도 잘못된 이름이 적힌다. */
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
          const isBlocked = !safety.canApply;
          const resultGeneratedAtMs = Date.parse(result.generatedAt ?? "");
          const windowStartAtMs = Date.parse(window?.windowStartAt ?? "");
          const leavesLater =
            Number.isFinite(resultGeneratedAtMs) &&
            Number.isFinite(windowStartAtMs) &&
            windowStartAtMs > resultGeneratedAtMs + 60_000;
          return (
            <li
              key={option.id || option.contentId || `${option.title}-${index}`}
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
                /* 엔진이 이미 좌표열을 보내는데 화면에서 쓰지 않아, 여행자는
                   "몇 분"만 보고 그 길이 어디로 가는지 알 수 없었다. */
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
                        `복귀 뒤 ${window.leftoverMinutes}분 여유가 남아, 필수 안전여유 ${window.requiredBufferMinutes}분을 확보했습니다. 복귀는 ${returnProviderLabel(window.returnProvider, language)}로 별도 확인했습니다.`,
                        `${window.leftoverMinutes} min remains after returning, meeting the ${window.requiredBufferMinutes}-min safety reserve. The return leg was separately verified with ${returnProviderLabel(window.returnProvider, language)}.`,
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
                    }${window.returnCalculatedAt ? ` · ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" }).format(new Date(window.returnCalculatedAt))} 확인` : ""}`,
                    `Return evidence · ${returnProviderLabel(window.returnProvider, language)}${
                      typeof window.returnDistanceMeters === "number"
                        ? ` · ${window.returnDistanceMeters.toLocaleString("en-US")} m`
                        : ""
                    }${window.returnCalculatedAt ? ` · checked ${new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit" }).format(new Date(window.returnCalculatedAt))} KST` : ""}`,
                  )}
                </p>
              )}

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
                      <li key={`${option.id}-safety-${reasonIndex}`}>
                        {reason}
                      </li>
                    ))}
                  </ul>
                  <p>
                    {tr(
                      language,
                      "헛걸음과 다음 일정 지연을 막기 위해 이 후보는 일정에 넣을 수 없습니다.",
                      "This option cannot be added because it could cause a wasted trip or delay the next appointment.",
                    )}
                  </p>
                </section>
              )}

              {option.purposePreservation?.statement && (
                <p className={styles.purpose}>
                  {(language === "en" &&
                    option.purposePreservation.statementEn) ||
                    option.purposePreservation.statement}
                </p>
              )}

              <ul className={styles.why}>
                {((language === "en" && option.whyEn) || option.why || []).map(
                  (reason, reasonIndex) => (
                    <li key={reasonIndex}>{reason}</li>
                  ),
                )}
              </ul>

              {/* 찾은 곳을 일정으로 가져간다. 이 화면은 "지금 갈 곳"을 알려
                  주고 끝나서, 마음에 드는 곳을 찾아도 다음 약속과 맞는지
                  따져 보려면 이름을 외워 다른 탭에 다시 입력해야 했다. */}
              {onPlanFromPlace && (
                <button
                  type="button"
                  className={styles.planFromPlace}
                  disabled={isBlocked}
                  onClick={() =>
                    safety.canApply &&
                    onPlanFromPlace({
                      title: option.title,
                      address: option.address ?? "",
                      contentTypeId: option.contentTypeId,
                    })
                  }
                >
                  {isBlocked
                    ? tr(
                        language,
                        "안전 확인 전 추가 불가",
                        "Cannot add until verified",
                      )
                    : tr(
                        language,
                        "이 곳을 일정에 넣기",
                        "Add this to my plan",
                      )}
                </button>
              )}
            </li>
          );
        })}
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
