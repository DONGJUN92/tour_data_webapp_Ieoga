"use client";

/* 파트너 사이트 안에서 도는 축소판 복구 위젯.
 *
 * 설계 제약이 본 화면과 다르다.
 * - 폭이 320~420px이다. 한 화면에 한 결정만 놓는다.
 * - 파트너의 브랜드가 주인이다. 이어가 색을 전면에 쓰지 않고 출처만 남긴다.
 * - 위치 권한을 요구하기 어렵다. 파트너가 좌표를 쿼리로 넘겨 줄 수 있게 한다.
 * - 그래도 검증 기준은 낮추지 않는다. 같은 API를 호출하고, 확인하지 못한 조건은
 *   축소판에서도 그대로 표시한다. 위젯이라서 관대해지면 그게 곧 신뢰 손실이다. */

import { useCallback, useMemo, useState } from "react";
import {
  verifiedTravelerOrigin,
  windowEndIsoFromMinutes,
} from "@/app/traveler-safety";
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

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "done";
      options: Option[];
      rejectedCount: number;
      warnings: string[];
      requestId: string;
    };

const WINDOWS = [60, 90, 120, 180] as const;
/* 60분 창에도 왕복 이동이 들어갈 자리를 남긴다. 스키마가 30분 단위 체류를
   요구하므로 20분 같은 임의 축소 대신 검증 가능한 최솟값 30분을 쓴다. */
const EMBED_STAY_MINUTES = 30;
const MODES = [
  { value: "walk", label: "걸어서" },
  { value: "transit", label: "대중교통" },
  { value: "car", label: "자차·택시" },
] as const;

export function EmbedRecoverWidget({
  hostName,
  partnerOrigin,
}: {
  hostName: string;
  /* 파트너가 쿼리로 넘긴 좌표. 숙박·교통 사이트는 방문자가 어느 지점을 보고
     있는지 이미 알기 때문에, 위젯이 위치 권한을 다시 묻는 것보다 그 값을 받는
     편이 마찰이 적다. 서버에서 검증해 내려온 값만 여기 들어온다.
     브라우저 위치는 여전히 URL에 넣지 않고 POST 본문으로만 보낸다. */
  partnerOrigin: EmbedOrigin | null;
}) {
  const [origin, setOrigin] = useState<EmbedOrigin | null>(partnerOrigin);
  const [originNote, setOriginNote] = useState(
    partnerOrigin ? "파트너 사이트가 알려 준 위치를 사용합니다." : "",
  );
  const [originState, setOriginState] = useState<
    "idle" | "loading" | "success" | "error"
  >(partnerOrigin ? "success" : "idle");
  const [minutes, setMinutes] = useState<number>(120);
  const [availableUntil, setAvailableUntil] = useState(() =>
    windowEndIsoFromMinutes(120),
  );
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("walk");
  const [state, setState] = useState<State>({ kind: "idle" });
  const host = hostName;

  const detect = useCallback(() => {
    if (!navigator.geolocation) {
      setOriginState("error");
      setOriginNote("이 브라우저에서는 위치를 확인할 수 없습니다.");
      return;
    }
    setOrigin(null);
    setOriginState("loading");
    setOriginNote("현재 위치를 확인하고 있습니다.");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        /* 본 화면과 같은 규칙: 소수점 다섯 자리로 줄여 POST 본문으로만 보낸다. */
        const latitude = Number(position.coords.latitude.toFixed(5));
        const longitude = Number(position.coords.longitude.toFixed(5));
        try {
          const response = await fetch("/api/v1/location/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ latitude, longitude }),
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
            error?: { message?: string };
          };
          if (!response.ok) {
            throw new Error(
              payload.error?.message ||
                "행정구역을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
            );
          }
          const verified = verifiedTravelerOrigin(payload, {
            latitude,
            longitude,
          });
          if (!verified) {
            throw new Error(
              "공식 행정구역을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
            );
          }
          setOrigin(verified);
          setOriginState("success");
          setOriginNote("현재 위치를 확인했습니다.");
        } catch (error) {
          setOrigin(null);
          setOriginState("error");
          setOriginNote(
            error instanceof Error
              ? error.message
              : "행정구역을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          );
        }
      },
      () => {
        setOrigin(null);
        setOriginState("error");
        setOriginNote("위치 권한이 없어 확인하지 못했습니다.");
      },
    );
  }, []);

  const radius = useMemo(
    () => (mode === "walk" ? 8_000 : mode === "transit" ? 20_000 : 20_000),
    [mode],
  );
  const availableUntilLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(availableUntil)),
    [availableUntil],
  );

  async function run() {
    if (!origin) {
      setState({
        kind: "error",
        message: "먼저 위치를 확인해 주세요.",
      });
      return;
    }
    setState({ kind: "loading" });
    try {
      const bootstrap = await fetch("/api/v1/embed/session", {
        method: "POST",
        credentials: "omit",
        headers: { "X-IEOGA-Embed-Bootstrap": "1" },
      });
      if (!bootstrap.ok) {
        throw new Error("EMBED_SESSION_UNAVAILABLE");
      }
      const bootstrapPayload = (await bootstrap.json()) as {
        embedSessionToken?: string;
      };
      const embedSessionToken = bootstrapPayload.embedSessionToken;
      if (
        typeof embedSessionToken !== "string" ||
        !/^ev1\.[A-Za-z0-9._-]{80,200}$/.test(embedSessionToken)
      ) {
        throw new Error("EMBED_SESSION_UNAVAILABLE");
      }
      const requestAvailableUntil = windowEndIsoFromMinutes(
        minutes,
        Date.now(),
      );
      setAvailableUntil(requestAvailableUntil);
      const response = await fetch("/api/v1/recover", {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-IEOGA-Embed-Session": embedSessionToken,
        },
        body: JSON.stringify({
          origin,
          incident: "delay",
          availableMinutes: Math.min(240, minutes),
          maxDistanceMeters: mode === "walk" ? 5_000 : 20_000,
          audience: "general",
          indoorOnly: false,
          travelMode: mode,
          radiusMeters: radius,
          safetyBufferMinutes: 15,
          minimumStayMinutes: EMBED_STAY_MINUTES,
          analyticsConsent: false,
          openWindow: {
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
        error?: { message?: string };
      };
      if (!response.ok) {
        setState({
          kind: "error",
          message:
            payload.error?.message ?? `요청에 실패했습니다. (${response.status})`,
        });
        return;
      }
      setState({
        kind: "done",
        options: payload.options ?? [],
        rejectedCount: payload.rejectedCount ?? 0,
        warnings: payload.warnings ?? [],
        requestId: payload.requestId ?? "",
      });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error &&
          error.message === "EMBED_SESSION_UNAVAILABLE"
            ? "보호된 위젯 세션을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요."
            : "연결 문제로 결과를 받지 못했습니다.",
      });
    }
  }

  return (
    <section className={styles.widget} aria-label="이어가 복구 위젯">
      <header className={styles.head}>
        <p className={styles.kicker}>
          {host ? `${host} × 이어가` : "이어가 복구"}
        </p>
        <h1 className={styles.title}>지금 갈 수 있는 곳</h1>
        <p className={styles.lead}>
          남은 시간 안에 다녀올 수 있는 공식 관광지만 확인해 보여 드립니다.
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
              다시 확인
            </button>
          </p>
        ) : (
          <button
            type="button"
            className={styles.primary}
            onClick={detect}
            disabled={originState === "loading"}
          >
            {originState === "loading" ? "위치 확인 중…" : "현재 위치 확인"}
          </button>
        )}
        {originNote && (
          <small
            className={styles.note}
            role={originState === "error" ? "alert" : "status"}
            aria-live={originState === "error" ? "assertive" : "polite"}
          >
            {originNote}
          </small>
        )}
      </div>

      <fieldset className={styles.field}>
        <legend>언제까지 비어 있나요</legend>
        <div className={styles.chips} role="radiogroup" aria-label="남은 시간">
          {WINDOWS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={minutes === value}
              className={minutes === value ? styles.chipOn : styles.chip}
              onClick={() => {
                setMinutes(value);
                setAvailableUntil(windowEndIsoFromMinutes(value));
              }}
            >
              {value % 60 === 0 ? `${value / 60}시간` : `${value}분`}
            </button>
          ))}
        </div>
        <small className={styles.note}>
          {availableUntilLabel}까지 · 한 곳에서 {EMBED_STAY_MINUTES}분 체류 ·
          왕복 이동시간 별도 검증
        </small>
      </fieldset>

      <fieldset className={styles.field}>
        <legend>어떻게 이동하나요</legend>
        <div className={styles.chips} role="radiogroup" aria-label="이동수단">
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={mode === item.value}
              className={mode === item.value ? styles.chipOn : styles.chip}
              onClick={() => setMode(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        className={styles.submit}
        onClick={() => void run()}
        disabled={state.kind === "loading" || !origin}
      >
        {state.kind === "loading" ? "확인 중…" : "다녀올 수 있는 곳 찾기"}
      </button>

      <div className={styles.results} aria-live="polite">
        {state.kind === "error" && (
          <p className={styles.error} role="alert">
            {state.message}
          </p>
        )}
        {state.kind === "done" && state.options.length === 0 && (
          <div className={styles.empty}>
            <strong>이 시간 안에 다녀올 수 있는 곳을 찾지 못했습니다.</strong>
            <p>
              없는 곳을 만들어 추천하지 않습니다. 시간을 더 길게 잡으면 결과가
              달라질 수 있습니다.
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
                    이동 {window.travelToMinutes}분 · 머무르기{" "}
                    {window.appliedStayMinutes}분 · 복귀 {window.returnMinutes}분
                    <br />
                    <b>
                      여유 {window.leftoverMinutes}분 · 안전여유 기준 {window.requiredBufferMinutes}분
                    </b>
                  </p>
                )}
                {unverified && (
                  /* 축소판에서도 확인하지 못한 조건을 숨기지 않는다. 위젯이라서
                     관대해지면 그게 곧 신뢰 손실이다. */
                  <p className={styles.gap}>
                    {(option.evidenceGaps ?? [])
                      .map((gap) => gap.note)
                      .filter(Boolean)
                      .join(" · ") || "공식 정보로 확인하지 못한 조건이 있습니다."}
                    <br />
                    출발 전 운영기관 안내를 확인해 주세요.
                  </p>
                )}
                <small className={styles.src}>
                  {option.continuityProof?.routeEvidence?.attribution ??
                    "경로 출처 확인 중"}
                </small>
              </article>
            );
          })}
        {state.kind === "done" && state.rejectedCount > 0 && (
          <p className={styles.note}>
            조건을 통과하지 못한 후보 {state.rejectedCount}곳은 제시하지 않았습니다.
          </p>
        )}
      </div>

      <footer className={styles.foot}>
        <span>
          한국관광공사 OpenAPI 기반 · 이어가
          {state.kind === "done" && state.requestId
            ? ` · 요청 ${state.requestId.slice(0, 8)}`
            : ""}
        </span>
        <a href="/" target="_blank" rel="noreferrer">
          전체 기능 보기
        </a>
      </footer>
    </section>
  );
}
