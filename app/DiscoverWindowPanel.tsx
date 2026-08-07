"use client";

/* 지금 갑자기 시간이 생긴 여행자를 위한 화면. 일정 복구 탭과 엔진·검증·저장을
   공유하지만 입력과 설명이 다르다. 복구는 "무엇을 바꿀까"이고 이 화면은 "이 시간
   안에 무엇을 다녀올 수 있을까"이므로, 카드도 바뀐 일정 수가 아니라 도착·체류·
   복귀·남는 여유를 보여준다.

   시각은 30분 격자로만 받는다. 여행자는 분 단위로 계획하지 않으며, 분 단위
   입력을 허용하면 검증은 정확해지지만 아무도 세우지 않는 계획을 검증하게 된다. */

import { useMemo, useState, type FormEvent } from "react";
import styles from "./DiscoverWindowPanel.module.css";
import { ManualLocationPicker, type ManualPlace } from "./ManualLocationPicker";
import { RouteMap, type RouteMapMarker, type RoutePoint } from "./RouteMap";
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
} from "./product-app-model";

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
  /* 직접 입력한 위치를 받는다. 예전에는 이 자리에서 여행 복구 탭으로 화면을
     바꿔 버려, 버튼을 누른 사용자가 지금 하려던 일과 입력한 조건을 함께
     잃었다. */
  onManualLocation: (place: ManualPlace) => void;
};

function tr(language: Language, ko: string, en: string): string {
  return language === "en" ? en : ko;
}

/* 지금부터 N분 뒤를 30분 격자에 올려 ISO로 만든다. "3시간 뒤"가 17:07이 아니라
   17:00 또는 17:30으로 떨어지게 하는 것이 목적이다. */
function windowEndFromMinutes(minutes: number): {
  iso: string;
  label: string;
} {
  const target = new Date(Date.now() + minutes * 60_000);
  target.setSeconds(0, 0);
  const remainder = target.getMinutes() % 30;
  if (remainder !== 0) {
    target.setMinutes(target.getMinutes() - remainder);
  }
  return {
    iso: target.toISOString(),
    label: new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      minute: "2-digit",
    }).format(target),
  };
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

export default function DiscoverWindowPanel({
  language,
  origin,
  geoState,
  geoMessage,
  geoAttribution,
  analyticsConsent,
  onRequestLocation,
  onManualLocation,
}: Props) {
  /* 직접 입력을 이 화면 안에서 편다. 탭을 바꾸면 지금 하려던 일이 사라진다. */
  const [manualOpen, setManualOpen] = useState(false);
  const [windowMinutes, setWindowMinutes] = useState<number>(120);
  const [plannedStayMinutes, setPlannedStayMinutes] = useState<number>(60);
  const [audience, setAudience] = useState<Audience>("general");
  const [travelMode, setTravelMode] = useState<TravelMode>("walk");
  const [indoorOnly, setIndoorOnly] = useState(false);
  const [nextPlaceKeyword, setNextPlaceKeyword] = useState("");
  const [nextPlace, setNextPlace] = useState<PlaceSearchResult | null>(null);
  const [nextPlaceResults, setNextPlaceResults] = useState<
    PlaceSearchResult[]
  >([]);
  const [nextPlaceState, setNextPlaceState] = useState<LoadState>("idle");
  const [nextPlaceError, setNextPlaceError] = useState("");
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<RecoveryResponse | null>(null);

  const windowEnd = useMemo(
    () => windowEndFromMinutes(windowMinutes),
    [windowMinutes],
  );
  const modeConfig =
    TRAVEL_MODES.find((item) => item.value === travelMode) ?? TRAVEL_MODES[0];
  const originReady =
    Number.isFinite(Number(origin.latitude)) &&
    Number.isFinite(Number(origin.longitude)) &&
    origin.latitude.trim() !== "" &&
    origin.longitude.trim() !== "";

  /* 체류 시간이 창보다 길면 애초에 성립하지 않는다. 서버가 거절하기 전에 화면에서
     먼저 알려 준다. */
  const stayTooLong = plannedStayMinutes >= windowMinutes;

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
      const payload = await fetchJson(
        `/api/v1/places/search?keyword=${encodeURIComponent(keyword)}&purpose=saved_stop&fallback=auto`,
      );
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
    if (stayTooLong) {
      setState("error");
      setError(
        tr(
          language,
          "머무는 시간이 남은 시간과 같거나 더 깁니다. 이동 시간이 들어갈 자리가 없습니다.",
          "Your stay is as long as the whole window, leaving no time to travel.",
        ),
      );
      return;
    }
    setState("loading");
    setResult(null);
    try {
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
          availableMinutes: Math.min(240, windowMinutes),
          /* 자차는 같은 시간에 훨씬 멀리 간다. 도보 기준 반경을 그대로 쓰면
             차로 20분이면 닿는 곳이 후보에 들어오지도 않는다. */
          maxDistanceMeters: modeConfig.distance,
          audience,
          indoorOnly,
          travelMode,
          radiusMeters: modeConfig.radius,
          safetyBufferMinutes: 15,
          minimumStayMinutes: Math.min(plannedStayMinutes, 180),
          analyticsConsent,
          openWindow: {
            availableUntil: windowEnd.iso,
            plannedStayMinutes,
            nextPlace: nextPlace
              ? {
                  latitude: nextPlace.latitude,
                  longitude: nextPlace.longitude,
                  label: nextPlace.title,
                  areaCode: nextPlace.areaCode || undefined,
                  sigunguCode: nextPlace.sigunguCode || undefined,
                  arriveBy: windowEnd.iso,
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
        warnings: Array.isArray(record?.warnings)
          ? (record.warnings as string[])
          : [],
        sourceLedger: Array.isArray(record?.sourceLedger)
          ? (record.sourceLedger as unknown[])
          : [],
        generatedAt: readText(record, ["generatedAt"]) || undefined,
        recoveryMode: readText(record, ["recoveryMode"]) || undefined,
      });
      setState("success");
    } catch (submitError) {
      setState("error");
      setError(
        submitError instanceof Error
          ? submitError.message
          : tr(
              language,
              "추천을 불러오지 못했습니다.",
              "Could not load recommendations.",
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
            "일정을 등록하지 않아도 됩니다. 지금 어디에 있고 언제까지 비어 있는지만 알려 주세요.",
            "No itinerary needed. Just tell us where you are and until when you are free.",
          )}
        </p>

        <section className={styles.block} aria-labelledby="discover-origin">
          <h3 id="discover-origin">
            {tr(language, "지금 어디에 있나요?", "Where are you now?")}
          </h3>
          {originReady ? (
            <p className={styles.originReady}>
              <strong>{origin.label || "현재 위치"}</strong>
              <button type="button" onClick={onRequestLocation}>
                {tr(language, "다시 확인", "Refresh")}
              </button>
            </p>
          ) : (
            <div className={styles.originActions}>
              <button
                type="button"
                className={styles.primaryGhost}
                onClick={onRequestLocation}
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
              onRetryGeolocation={onRequestLocation}
              onPick={(place) => {
                onManualLocation(place);
                setManualOpen(false);
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

        <section className={styles.block} aria-labelledby="discover-window">
          <h3 id="discover-window">
            {tr(language, "언제까지 비어 있나요?", "Free until when?")}
          </h3>
          <div className={styles.chips} role="radiogroup" aria-label={tr(language, "남은 시간", "Remaining time")}>
            {WINDOW_CHOICES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                role="radio"
                aria-checked={windowMinutes === minutes}
                className={
                  windowMinutes === minutes ? styles.chipActive : styles.chip
                }
                onClick={() => setWindowMinutes(minutes)}
              >
                {minutesLabel(language, minutes)}
              </button>
            ))}
          </div>
          <p className={styles.derived}>
            {tr(
              language,
              `${windowEnd.label}까지 계산합니다. 30분 단위로만 잡습니다.`,
              `Calculated until ${windowEnd.label}, on a 30-minute grid.`,
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
          <div className={styles.chips} role="radiogroup" aria-label={tr(language, "머무는 시간", "Stay length")}>
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
                "머무는 시간이 남은 시간과 같거나 더 깁니다. 이동 시간이 들어갈 자리가 없습니다.",
                "Your stay fills the whole window, leaving no time to travel.",
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
                        {place.sourceLabel && <small>{place.sourceLabel}</small>}
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
              onChange={(event) =>
                setAudience(event.target.value as Audience)
              }
            >
              {AUDIENCES.map((item) => (
                <option key={item.value} value={item.value}>
                  {language === "en"
                    ? AUDIENCES_EN[item.value]
                    : item.label}
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
              <strong>
                {tr(language, "실내 후보만 찾기", "Indoor only")}
              </strong>
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
          disabled={state === "loading" || !originReady || stayTooLong}
        >
          {state === "loading"
            ? tr(language, "확인 중…", "Checking…")
            : tr(
                language,
                "지금 다녀올 수 있는 곳 찾기",
                "Find places I can fit in",
              )}
        </button>
        <p className={styles.footnote}>
          {tr(
            language,
            "이동 시간과 운영 여부를 실제로 확인한 곳만 결과에 올립니다. 확인하지 못한 조건은 숨기지 않고 따로 알려 드립니다.",
            "Only places with a verified route and opening status are listed. Anything unverified is shown, not hidden.",
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
          <DiscoverResults language={language} result={result} />
        )}
      </section>
    </div>
  );
}

function DiscoverResults({
  language,
  result,
}: {
  language: Language;
  result: RecoveryResponse;
}) {
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
          <p key={index}>{warning}</p>
        ))}
        <p>
          {tr(
            language,
            "머무는 시간을 줄이거나 남은 시간을 더 길게 잡으면 결과가 달라질 수 있습니다. 존재하지 않는 장소를 만들어 추천하지는 않습니다.",
            "A shorter stay or a longer window may change this. We never invent a place to fill the gap.",
          )}
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className={styles.cards}>
        {result.options.map((option, index) => {
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
          const unverified =
            option.confirmationRequired ||
            (option.evidenceGaps?.length ?? 0) > 0;
          return (
            <li
              key={option.id || option.contentId || `${option.title}-${index}`}
              className={unverified ? styles.cardUnverified : styles.card}
              data-testid="discover-option"
            >
              <div className={styles.cardHead}>
                <div>
                  <p>{option.address || "주소 정보 확인 필요"}</p>
                  <h3>{option.title}</h3>
                </div>
                {typeof option.score === "number" && (
                  <span className={styles.score}>
                    <b>{Math.round(option.score)}</b>
                    <small>{tr(language, "적합도", "Fit")}</small>
                  </span>
                )}
              </div>

              {window && (
                <ol className={styles.timeline}>
                  <li>
                    <span>{tr(language, "지금 출발", "Leave now")}</span>
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
                      {formatIsoTime(option.scheduleDiff?.replacementNode?.startAt)}
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
                    point: { latitude: option.latitude, longitude: option.longitude },
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
                    window.leftoverMinutes >= 15
                      ? styles.fitGood
                      : styles.fitTight
                  }
                >
                  {window.returnBasis === "next_place_route"
                    ? tr(
                        language,
                        `다음 장소 도착까지 ${window.leftoverMinutes}분 여유가 남습니다.`,
                        `${window.leftoverMinutes} min of slack before your next place.`,
                      )
                    : tr(
                        language,
                        `${window.leftoverMinutes}분 여유가 남습니다. 돌아오는 시간은 같은 ${modeVerb.noun} 경로 기준입니다.`,
                        `${window.leftoverMinutes} min of slack. Return time uses the same ${modeVerb.en} route.`,
                      )}
                </p>
              )}

              {unverified && (
                <section className={styles.gaps} role="alert">
                  <strong>
                    {tr(
                      language,
                      "공식 정보로 확인하지 못한 조건",
                      "Conditions official data could not confirm",
                    )}
                  </strong>
                  <ul>
                    {(option.evidenceGaps ?? []).map((gap, gapIndex) => (
                      <li key={`${gap.code ?? "gap"}-${gapIndex}`}>
                        {(language === "en" ? gap.noteEn : "") ||
                          gap.note ||
                          tr(
                            language,
                            "필수 조건 근거 미확인",
                            "Required evidence missing",
                          )}
                      </li>
                    ))}
                  </ul>
                  <p>
                    {tr(
                      language,
                      "출발 전에 운영기관 안내를 직접 확인해 주세요.",
                      "Please confirm with the venue before you set out.",
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
            </li>
          );
        })}
      </ul>

      {/* 예전에는 "조건을 통과하지 못한 후보 N곳은 제시하지 않았습니다"라고
          적었다. 두 가지가 잘못됐다. 첫째, 여행에 정답이 없는데 우리가 통과·
          탈락을 선고하는 말투다. 둘째, 그 N곳이 무엇인지 알려 주지 않으므로
          여행자는 자기가 무엇을 못 봤는지도 모른다.

          엔진이 이제 운영시간으로 후보를 지우지 않고 사유와 함께 보여 주므로
          여기서 남는 것은 정말로 갈 수 없는 경우(경로가 없거나 남은 시간을
          넘김)뿐이다. 그 사실만 담담하게 적는다. */}
      {typeof result.rejectedCount === "number" && result.rejectedCount > 0 && (
        <p className={styles.rejected}>
          {tr(
            language,
            `근처 ${result.rejectedCount}곳은 남은 시간 안에 다녀올 수 없어 목록에서 빠졌습니다.`,
            `${result.rejectedCount} nearby places do not fit in the time you have left.`,
          )}
        </p>
      )}
      {(result.warnings ?? []).map((warning, index) => (
        <p key={index} className={styles.warning}>
          {warning}
        </p>
      ))}
    </>
  );
}
