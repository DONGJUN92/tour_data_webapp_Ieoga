"use client";

/* Partner-site recovery widget. It uses the same recovery endpoint and
   fail-closed evidence rules as the full product, while keeping the controls
   usable inside a 320–420px frame. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReferenceTimePicker } from "@/app/ReferenceTimePicker";
import {
  formatReferenceTime,
  resolveReferenceTime,
  scheduledReferenceFromOffset,
  type ReferenceTimeMode,
} from "@/app/reference-time";
import type { Language } from "@/app/product-app-model";
import { verifiedTravelerOrigin } from "@/app/traveler-safety";
import { sanitizeTravelerText } from "@/lib/text/traveler-facing";
import styles from "./embed.module.css";

type Option = {
  title: string;
  address?: string;
  estimatedTravelMinutes?: number;
  distanceMeters?: number;
  confirmationRequired?: boolean;
  evidenceGaps?: Array<{ note?: string }>;
  why?: string[];
  continuityProof?: {
    routeEvidence?: { provider?: string; attribution?: string };
  };
  scheduleDiff?: {
    openWindow?: {
      travelToMinutes: number;
      appliedStayMinutes: number;
      returnMinutes: number;
      requiredBufferMinutes: number;
      leftoverMinutes: number;
    };
  };
};

export type EmbedOrigin = {
  latitude: number;
  longitude: number;
  label: string;
  areaCode?: string;
  sigunguCode?: string;
};

type LocalizedMessage = { ko: string; en: string };
type CanonicalReferenceTime = {
  mode: "current" | "assumed";
  at: string;
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: LocalizedMessage }
  | {
      kind: "done";
      options: Option[];
      rejectedCount: number;
      warnings: string[];
      requestId: string;
      referenceTime: CanonicalReferenceTime | null;
    };

type OriginNote =
  | "none"
  | "partner"
  | "checking"
  | "verified"
  | "unsupported"
  | "permission"
  | "unresolved";

const WINDOWS = [60, 90, 120, 180] as const;
const EMBED_STAY_MINUTES = 30;
const MODES = [
  { value: "walk", ko: "걸어서", en: "Walk" },
  { value: "transit", ko: "대중교통", en: "Public transit" },
  { value: "car", ko: "자차·택시", en: "Car · taxi" },
] as const;

function localized(ko: string, en: string): LocalizedMessage {
  return { ko, en };
}

function canonicalReferenceTime(value: unknown): CanonicalReferenceTime | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  const at = record.at;
  return (mode === "current" || mode === "assumed") &&
    typeof at === "string" &&
    Number.isFinite(Date.parse(at))
    ? { mode, at }
    : null;
}

export function EmbedRecoverWidget({
  hostName,
  partnerOrigin,
}: {
  hostName: string;
  /* Coordinates supplied by the host are server-validated in page.tsx. User
     geolocation is rounded and sent only in a POST body. */
  partnerOrigin: EmbedOrigin | null;
}) {
  const [language, setLanguage] = useState<Language>("ko");
  const [origin, setOrigin] = useState<EmbedOrigin | null>(partnerOrigin);
  const [originNote, setOriginNote] = useState<OriginNote>(
    partnerOrigin ? "partner" : "none",
  );
  const [originState, setOriginState] = useState<
    "idle" | "loading" | "success" | "error"
  >(partnerOrigin ? "success" : "idle");
  const [minutes, setMinutes] = useState<number>(120);
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("walk");
  const [referenceTimeMode, setReferenceTimeMode] =
    useState<ReferenceTimeMode>("now");
  const [referenceTimeLocal, setReferenceTimeLocal] = useState(() =>
    scheduledReferenceFromOffset(30),
  );
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const locationAbortRef = useRef<AbortController | null>(null);
  const locationGenerationRef = useRef(0);
  const host = hostName;
  const tr = useCallback(
    (ko: string, en: string) => (language === "ko" ? ko : en),
    [language],
  );

  useEffect(() => {
    const initialize = window.setTimeout(() => setNowMs(Date.now()), 0);
    const clock = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      window.clearTimeout(initialize);
      window.clearInterval(clock);
      requestGenerationRef.current += 1;
      requestAbortRef.current?.abort();
      locationGenerationRef.current += 1;
      locationAbortRef.current?.abort();
    };
  }, []);

  const invalidateResults = useCallback(() => {
    requestGenerationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setState({ kind: "idle" });
  }, []);

  const detect = useCallback(() => {
    invalidateResults();
    locationGenerationRef.current += 1;
    locationAbortRef.current?.abort();
    const generation = locationGenerationRef.current;
    if (!navigator.geolocation) {
      setOrigin(null);
      setOriginState("error");
      setOriginNote("unsupported");
      return;
    }
    setOrigin(null);
    setOriginState("loading");
    setOriginNote("checking");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const latitude = Number(position.coords.latitude.toFixed(5));
        const longitude = Number(position.coords.longitude.toFixed(5));
        const controller = new AbortController();
        locationAbortRef.current = controller;
        try {
          const response = await fetch("/api/v1/location/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ latitude, longitude }),
            signal: controller.signal,
          });
          const payload = (await response.json()) as {
            label?: string;
            areaCode?: string;
            sigunguCode?: string;
            location?: {
              areaCode?: string;
              sigunguCode?: string;
              label?: string;
            };
            data?: {
              areaCode?: string;
              sigunguCode?: string;
              label?: string;
            };
          };
          if (!response.ok) throw new Error("LOCATION_UNRESOLVED");
          const verified = verifiedTravelerOrigin(payload, {
            latitude,
            longitude,
          });
          if (!verified) throw new Error("LOCATION_UNRESOLVED");
          if (
            controller.signal.aborted ||
            generation !== locationGenerationRef.current
          ) {
            return;
          }
          setOrigin(verified);
          setOriginState("success");
          setOriginNote("verified");
        } catch {
          if (
            controller.signal.aborted ||
            generation !== locationGenerationRef.current
          ) {
            return;
          }
          setOrigin(null);
          setOriginState("error");
          setOriginNote("unresolved");
        }
      },
      () => {
        if (generation !== locationGenerationRef.current) return;
        setOrigin(null);
        setOriginState("error");
        setOriginNote("permission");
      },
    );
  }, [invalidateResults]);

  const previewReference = useMemo(
    () =>
      nowMs == null
        ? null
        : resolveReferenceTime(
            referenceTimeMode,
            referenceTimeLocal,
            language,
            nowMs,
          ),
    [language, nowMs, referenceTimeLocal, referenceTimeMode],
  );
  const previewWindowEnd =
    previewReference?.ok
      ? new Date(previewReference.timestamp + minutes * 60_000).toISOString()
      : "";
  const availableUntilLabel = previewWindowEnd
    ? formatReferenceTime(previewWindowEnd, language)
    : tr("기준 시각을 확인해 주세요", "Check the reference time");

  const originNoteText =
    originNote === "partner"
      ? tr(
          "파트너 사이트가 알려 준 위치를 사용합니다.",
          "Using the location supplied by the partner site.",
        )
      : originNote === "checking"
        ? tr("현재 위치를 확인하고 있습니다.", "Checking your current location.")
        : originNote === "verified"
          ? tr("현재 위치를 확인했습니다.", "Current location verified.")
          : originNote === "unsupported"
            ? tr(
                "이 브라우저에서는 위치를 확인할 수 없습니다.",
                "This browser cannot provide your location.",
              )
            : originNote === "permission"
              ? tr(
                  "위치 권한이 없어 확인하지 못했습니다.",
                  "Location permission was not granted.",
                )
              : originNote === "unresolved"
                ? tr(
                    "공식 행정구역을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
                    "The official administrative area could not be verified. Try again shortly.",
                  )
                : "";

  function changeReferenceTimeMode(next: ReferenceTimeMode) {
    if (next === referenceTimeMode) return;
    invalidateResults();
    setReferenceTimeMode(next);
  }

  function changeReferenceTimeLocal(value: string) {
    if (value === referenceTimeLocal) return;
    invalidateResults();
    setReferenceTimeLocal(value);
  }

  async function run() {
    if (!origin) {
      setState({
        kind: "error",
        message: localized(
          "먼저 위치를 확인해 주세요.",
          "Verify your location first.",
        ),
      });
      return;
    }

    const requestNowMs = Date.now();
    const requestReference = resolveReferenceTime(
      referenceTimeMode,
      referenceTimeLocal,
      language,
      requestNowMs,
    );
    if (!requestReference.ok) {
      const ko = resolveReferenceTime(
        referenceTimeMode,
        referenceTimeLocal,
        "ko",
        requestNowMs,
      );
      const en = resolveReferenceTime(
        referenceTimeMode,
        referenceTimeLocal,
        "en",
        requestNowMs,
      );
      setState({
        kind: "error",
        message: localized(
          ko.ok ? "조회 기준 시각을 확인해 주세요." : ko.message,
          en.ok ? "Check the reference time." : en.message,
        ),
      });
      return;
    }

    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestGeneration = ++requestGenerationRef.current;
    const requestAvailableUntil = new Date(
      requestReference.timestamp + minutes * 60_000,
    ).toISOString();
    setState({ kind: "loading" });
    try {
      const bootstrap = await fetch("/api/v1/embed/session", {
        method: "POST",
        credentials: "omit",
        headers: { "X-IEOGA-Embed-Bootstrap": "1" },
        signal: controller.signal,
      });
      if (!bootstrap.ok) throw new Error("EMBED_SESSION_UNAVAILABLE");
      const bootstrapPayload = (await bootstrap.json()) as {
        embedSessionToken?: string;
      };
      if (
        controller.signal.aborted ||
        requestGeneration !== requestGenerationRef.current
      ) {
        return;
      }
      const embedSessionToken = bootstrapPayload.embedSessionToken;
      if (
        typeof embedSessionToken !== "string" ||
        !/^ev1\.[A-Za-z0-9._-]{80,200}$/.test(embedSessionToken)
      ) {
        throw new Error("EMBED_SESSION_UNAVAILABLE");
      }

      const response = await fetch("/api/v1/recover", {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-IEOGA-Embed-Session": embedSessionToken,
        },
        signal: controller.signal,
        body: JSON.stringify({
          origin,
          incident: "delay",
          referenceTime:
            referenceTimeMode === "now"
              ? { mode: "current" }
              : { mode: "assumed", at: requestReference.iso },
          availableMinutes: minutes,
          audience: "general",
          indoorOnly: false,
          travelMode: mode,
          safetyBufferMinutes: 15,
          minimumStayMinutes: EMBED_STAY_MINUTES,
          analyticsConsent: false,
          openWindow: {
            departureAt: requestReference.iso,
            availableUntil: requestAvailableUntil,
            plannedStayMinutes: EMBED_STAY_MINUTES,
          },
        }),
      });
      const payload = (await response.json()) as {
        options?: Option[];
        rejectedCount?: number;
        warnings?: string[];
        requestId?: string;
        referenceTime?: unknown;
        error?: { message?: string };
      };
      if (
        controller.signal.aborted ||
        requestGeneration !== requestGenerationRef.current
      ) {
        return;
      }
      if (!response.ok) {
        const rawMessage =
          payload.error?.message ?? `요청에 실패했습니다. (${response.status})`;
        setState({
          kind: "error",
          message: localized(
            sanitizeTravelerText(rawMessage, "ko"),
            sanitizeTravelerText(rawMessage, "en") ||
              `The request failed. (${response.status})`,
          ),
        });
        return;
      }
      setState({
        kind: "done",
        options: payload.options ?? [],
        rejectedCount: payload.rejectedCount ?? 0,
        warnings: payload.warnings ?? [],
        requestId: payload.requestId ?? "",
        referenceTime: canonicalReferenceTime(payload.referenceTime),
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestGeneration !== requestGenerationRef.current
      ) {
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof Error &&
          error.message === "EMBED_SESSION_UNAVAILABLE"
            ? localized(
                "보호된 위젯 세션을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
                "The protected widget session could not start. Try again shortly.",
              )
            : localized(
                "연결 문제로 결과를 받지 못했습니다.",
                "A connection problem prevented the results from loading.",
              ),
      });
    }
  }

  return (
    <section
      className={styles.widget}
      aria-label={tr("이어가 복구 위젯", "IEOGA recovery widget")}
    >
      <header className={styles.head}>
        <div className={styles.headTop}>
          <p className={styles.kicker}>
            {host ? `${host} × IEOGA` : tr("이어가 복구", "IEOGA recovery")}
          </p>
          <div
            className={styles.language}
            role="group"
            aria-label={tr("언어 선택", "Language")}
          >
            {(["ko", "en"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={language === entry}
                className={language === entry ? styles.languageOn : ""}
                onClick={() => setLanguage(entry)}
              >
                {entry === "ko" ? "한국어" : "EN"}
              </button>
            ))}
          </div>
        </div>
        <h1 className={styles.title}>
          {tr("갈 수 있는 곳", "Places you can visit")}
        </h1>
        <p className={styles.lead}>
          {tr(
            "선택한 출발 시각부터 남은 시간 안에 다녀올 수 있는 공식 관광지만 확인합니다.",
            "Check verified tourism places that fit the time available from your chosen departure.",
          )}
        </p>
      </header>

      <div className={styles.row}>
        {origin ? (
          <p className={styles.originReady}>
            <strong>{origin.label}</strong>
            <button
              type="button"
              onClick={detect}
              disabled={originState === "loading"}
            >
              {tr("다시 확인", "Check again")}
            </button>
          </p>
        ) : (
          <button
            type="button"
            className={styles.primary}
            onClick={detect}
            disabled={originState === "loading"}
          >
            {originState === "loading"
              ? tr("위치 확인 중…", "Checking location…")
              : tr("현재 위치 확인", "Use current location")}
          </button>
        )}
        {originNoteText && (
          <small
            className={styles.note}
            role={originState === "error" ? "alert" : "status"}
            aria-live={originState === "error" ? "assertive" : "polite"}
          >
            {originNoteText}
          </small>
        )}
      </div>

      <div className={styles.referenceCompact}>
        <ReferenceTimePicker
          idPrefix="embed"
          language={language}
          mode={referenceTimeMode}
          localValue={referenceTimeLocal}
          onModeChange={changeReferenceTimeMode}
          onLocalValueChange={changeReferenceTimeLocal}
        />
      </div>

      <fieldset className={styles.field}>
        <legend>{tr("얼마나 시간이 비었나요", "How much time is free?")}</legend>
        <div
          className={styles.chips}
          role="radiogroup"
          aria-label={tr("남은 시간", "Available duration")}
        >
          {WINDOWS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={minutes === value}
              className={minutes === value ? styles.chipOn : styles.chip}
              onClick={() => {
                if (minutes === value) return;
                invalidateResults();
                setMinutes(value);
              }}
            >
              {value % 60 === 0
                ? tr(`${value / 60}시간`, `${value / 60} hr`)
                : tr(`${value}분`, `${value} min`)}
            </button>
          ))}
        </div>
        <small className={styles.note}>
          {tr(
            `${availableUntilLabel}까지 · 한 곳에서 ${EMBED_STAY_MINUTES}분 체류 · 왕복 이동시간 별도 검증`,
            `Until ${availableUntilLabel} KST · ${EMBED_STAY_MINUTES}-min stay · round-trip travel verified separately`,
          )}
        </small>
      </fieldset>

      <fieldset className={styles.field}>
        <legend>{tr("어떻게 이동하나요", "How will you travel?")}</legend>
        <div
          className={styles.chips}
          role="radiogroup"
          aria-label={tr("이동수단", "Travel mode")}
        >
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={mode === item.value}
              className={mode === item.value ? styles.chipOn : styles.chip}
              onClick={() => {
                if (mode === item.value) return;
                invalidateResults();
                setMode(item.value);
              }}
            >
              {language === "ko" ? item.ko : item.en}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        className={styles.submit}
        onClick={() => void run()}
        disabled={state.kind === "loading" || !origin || !previewReference?.ok}
      >
        {state.kind === "loading"
          ? tr("확인 중…", "Checking…")
          : tr("다녀올 수 있는 곳 찾기", "Find places that fit")}
      </button>

      <div
        className={styles.results}
        aria-live="polite"
        aria-busy={state.kind === "loading"}
      >
        {state.kind === "loading" && (
          <p className={styles.note} role="status">
            {tr(
              "운영시간·날씨·왕복 이동을 확인하고 있습니다.",
              "Checking opening hours, weather and round-trip travel.",
            )}
          </p>
        )}
        {state.kind === "error" && (
          <p className={styles.error} role="alert">
            {state.message[language]}
          </p>
        )}
        {state.kind === "done" && state.referenceTime && (
          <p className={styles.referenceBasis} role="status">
            {tr(
              `${state.referenceTime.mode === "assumed" ? "가정 출발" : "현재 시각"} · ${formatReferenceTime(state.referenceTime.at, language)} 기준 · 서버 확인`,
              `${state.referenceTime.mode === "assumed" ? "Assumed departure" : "Current time"} · ${formatReferenceTime(state.referenceTime.at, language)} KST · server verified`,
            )}
          </p>
        )}
        {state.kind === "done" && state.options.length === 0 && (
          <div className={styles.empty}>
            <strong>
              {tr(
                "이 시간 안에 다녀올 수 있는 곳을 찾지 못했습니다.",
                "No verified place fits this time window.",
              )}
            </strong>
            <p>
              {tr(
                "없는 곳을 만들어 추천하지 않습니다. 시간을 더 길게 잡으면 결과가 달라질 수 있습니다.",
                "IEOGA does not invent recommendations. A longer free window may produce different results.",
              )}
            </p>
          </div>
        )}
        {state.kind === "done" &&
          state.options.slice(0, 3).map((option, index) => {
            const window = option.scheduleDiff?.openWindow;
            const unverified =
              option.confirmationRequired ||
              (option.evidenceGaps?.length ?? 0) > 0;
            return (
              <article
                key={`${option.title}-${index}`}
                className={unverified ? styles.cardWarn : styles.card}
              >
                <h2>{option.title}</h2>
                {option.address && <p className={styles.addr}>{option.address}</p>}
                {window && (
                  <p className={styles.times}>
                    {tr("이동", "Outbound")} {window.travelToMinutes}
                    {tr("분", " min")} · {tr("머무르기", "Stay")} {" "}
                    {window.appliedStayMinutes}{tr("분", " min")} · {" "}
                    {tr("복귀", "Return")} {window.returnMinutes}
                    {tr("분", " min")}
                    <br />
                    <b>
                      {tr("여유", "Spare")} {window.leftoverMinutes}
                      {tr("분", " min")} · {tr("안전여유 기준", "Safety buffer")} {" "}
                      {window.requiredBufferMinutes}{tr("분", " min")}
                    </b>
                  </p>
                )}
                {unverified && (
                  <p className={styles.gap}>
                    {(option.evidenceGaps ?? [])
                      .map((gap) => gap.note)
                      .filter(Boolean)
                      .join(" · ") ||
                      tr(
                        "공식 정보로 확인하지 못한 조건이 있습니다.",
                        "Some conditions could not be verified from official data.",
                      )}
                    <br />
                    {tr(
                      "출발 전 운영기관 안내를 확인해 주세요.",
                      "Check the operator's latest guidance before departure.",
                    )}
                  </p>
                )}
                <small className={styles.src}>
                  {option.continuityProof?.routeEvidence?.attribution ??
                    tr("경로 출처 확인 중", "Route source pending")}
                </small>
              </article>
            );
          })}
        {state.kind === "done" && state.rejectedCount > 0 && (
          <p className={styles.note}>
            {tr(
              `조건을 통과하지 못한 후보 ${state.rejectedCount}곳은 제시하지 않았습니다.`,
              `${state.rejectedCount} candidate${state.rejectedCount === 1 ? "" : "s"} that failed the conditions are not shown.`,
            )}
          </p>
        )}
        {state.kind === "done" && state.warnings.length > 0 && (
          <ul className={styles.warnings}>
            {state.warnings.map((warning) => (
              <li key={warning}>{sanitizeTravelerText(warning, language)}</li>
            ))}
          </ul>
        )}
      </div>

      <footer className={styles.foot}>
        <span>
          {tr("한국관광공사 OpenAPI 기반 · 이어가", "KTO OpenAPI · IEOGA")}
          {state.kind === "done" && state.requestId
            ? ` · ${tr("요청", "Request")} ${state.requestId.slice(0, 8)}`
            : ""}
        </span>
        <a href="/" target="_blank" rel="noreferrer">
          {tr("전체 기능 보기", "Open full app")}
        </a>
      </footer>
    </section>
  );
}
