"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./flow.module.css";

/* Bridge recovery: the traveller answers three questions (what happened,
   where are you, when is the next fixed appointment) and nothing else. The
   two-node itinerary the recovery engine requires is synthesised from those
   answers, so no itinerary-registration form is ever shown. This reuses the
   existing engine unchanged — the entry point is what differs. */

type Step =
  | "incident"
  | "origin"
  | "appointment"
  | "searching"
  | "options"
  | "empty"
  | "error";

const STEP_ORDER: Step[] = [
  "incident",
  "origin",
  "appointment",
  "searching",
  "options",
];

type Incident = "rain" | "delay" | "crowd" | "less_walk";
type Audience = "general" | "stroller" | "wheelchair" | "senior";

type Coordinate = {
  latitude: number;
  longitude: number;
  label: string;
  areaCode?: string;
  sigunguCode?: string;
};

type PlaceHit = {
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  areaCode?: string;
  sigunguCode?: string;
};

/* The engine returns `sources` as plain API names and `dataContributions` as
   the richer ledger (which API touched which fields, and whether that
   actually changed the decision). The ledger is what proves KTO data was
   load-bearing rather than decorative, so it is preferred when present. */
type DataContribution = {
  source?: string;
  fields?: string[];
  decision?: string;
  effect?: string;
  status?: string;
};

type RecoveryOption = {
  id: string;
  title: string;
  address?: string;
  strategyLabel?: string;
  distanceMeters?: number;
  estimatedTravelMinutes?: number;
  why?: string[];
  sources?: string[];
  dataContributions?: DataContribution[];
  purposePreservation?: { statement?: string };
};

/* The eight KTO services this product is built on. Judging distinguishes
   official tourism data from supporting third-party providers, so the ledger
   must not blur the two. */
const KTO_SERVICES = new Set([
  "KorService2",
  "TarRlteTarService1",
  "TatsCnctrRateService",
  "KorWithService2",
  "LocgoHubTarService1",
  "AreaTarDemDsService",
  "AreaTarResDemService",
  "AreaTarDivService",
]);

/* Sources that actually changed this option's decision, split by origin. */
function appliedSources(option: RecoveryOption): {
  kto: string[];
  external: string[];
} {
  const fromLedger = (option.dataContributions ?? [])
    .filter((entry) => entry.status === "applied" && entry.source)
    .map((entry) => entry.source as string);
  const names = [
    ...new Set((fromLedger.length ? fromLedger : (option.sources ?? [])).filter(Boolean)),
  ];
  return {
    kto: names.filter((name) => KTO_SERVICES.has(name)),
    external: names.filter((name) => !KTO_SERVICES.has(name)),
  };
}

const INCIDENTS: {
  value: Incident;
  mark: string;
  title: string;
  sub: string;
}[] = [
  {
    value: "rain",
    mark: "🌧️",
    title: "비가 와요",
    sub: "실내로 바꿀 수 있는 곳을 먼저 찾아요",
  },
  {
    value: "delay",
    mark: "⏱️",
    title: "일정이 밀렸어요",
    sub: "다음 약속에 늦지 않는 곳만 찾아요",
  },
  {
    value: "crowd",
    mark: "👥",
    title: "사람이 너무 많아요",
    sub: "덜 붐빌 것으로 예측된 곳을 찾아요",
  },
  {
    value: "less_walk",
    mark: "🦶",
    title: "걷기가 힘들어요",
    sub: "이동 부담이 적은 곳을 찾아요",
  },
];

const AUDIENCES: { value: Audience; label: string }[] = [
  { value: "general", label: "특별한 조건 없음" },
  { value: "stroller", label: "유모차와 함께" },
  { value: "wheelchair", label: "휠체어 이용" },
  { value: "senior", label: "고령자와 함께" },
];

/* The service is Korea-only, so appointment times are always read as KST
   regardless of the device clock. */
const KST_OFFSET = "+09:00";

function kstNow(): Date {
  const now = new Date();
  return new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }),
  );
}

function kstDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function kstIso(date: string, time: string): string {
  return `${date}T${time}:00${KST_OFFSET}`;
}

function defaultAppointmentTime(): string {
  const later = kstNow();
  later.setMinutes(later.getMinutes() + 150);
  return `${String(later.getHours()).padStart(2, "0")}:${String(
    later.getMinutes(),
  ).padStart(2, "0")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(row: Record<string, unknown> | null, keys: string[]): string {
  if (!row) return "";
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      readText(asRecord(asRecord(payload)?.error), ["message"]) ||
      "요청을 처리하지 못했습니다.";
    throw new Error(message);
  }
  return payload;
}

export default function FlowApp() {
  const [step, setStep] = useState<Step>("incident");
  const [goingBack, setGoingBack] = useState(false);

  const [incident, setIncident] = useState<Incident | null>(null);
  const [audience, setAudience] = useState<Audience>("general");
  const [origin, setOrigin] = useState<Coordinate | null>(null);
  const [originBusy, setOriginBusy] = useState(false);
  const [originNote, setOriginNote] = useState("");

  const [apptDate] = useState(() => kstDateString(kstNow()));
  const [apptTime, setApptTime] = useState(defaultAppointmentTime);
  const [apptQuery, setApptQuery] = useState("");
  const [apptHits, setApptHits] = useState<PlaceHit[]>([]);
  const [apptPlace, setApptPlace] = useState<PlaceHit | null>(null);
  const [apptBusy, setApptBusy] = useState(false);
  const [apptNote, setApptNote] = useState("");

  const [apiLog, setApiLog] = useState<string[]>([]);
  const [options, setOptions] = useState<RecoveryOption[]>([]);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [errorText, setErrorText] = useState("");
  const searchAbort = useRef<AbortController | null>(null);

  const go = useCallback((next: Step, back = false) => {
    setGoingBack(back);
    setStep(next);
  }, []);

  const stepIndex = Math.max(0, STEP_ORDER.indexOf(step));

  /* The remaining window shrinks in real time, so the clock lives in state
     rather than being read during render. It stays null until mount so the
     server and first client render agree. */
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  /* Minutes between now and the appointment — the window the engine may
     spend. Null while the clock is still unknown. */
  const availableMinutes = useMemo(() => {
    if (nowMs == null) return null;
    const target = Date.parse(kstIso(apptDate, apptTime));
    if (!Number.isFinite(target)) return null;
    return Math.floor((target - nowMs) / 60_000);
  }, [apptDate, apptTime, nowMs]);

  const detectOrigin = useCallback(() => {
    if (!navigator.geolocation) {
      setOriginNote("이 브라우저에서는 위치를 확인할 수 없습니다.");
      return;
    }
    setOriginBusy(true);
    setOriginNote("현재 위치를 확인하고 있습니다.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        /* Coordinates are truncated to five decimals and sent in a POST body,
           never a URL, so they stay out of access logs. */
        const latitude = Number(position.coords.latitude.toFixed(5));
        const longitude = Number(position.coords.longitude.toFixed(5));
        postJson("/api/v1/location/resolve", { latitude, longitude })
          .then((payload) => {
            const root = asRecord(payload);
            const resolved =
              asRecord(root?.location) ?? asRecord(root?.data) ?? root;
            setOrigin({
              latitude,
              longitude,
              label: readText(resolved, ["label"]) || "현재 위치",
              areaCode:
                readText(resolved, ["areaCode", "regionCode"]) || undefined,
              sigunguCode:
                readText(resolved, ["sigunguCode", "districtCode"]) ||
                undefined,
            });
            const area = readText(resolved, ["areaName", "regionName"]);
            const district = readText(resolved, ["districtName", "sigunguName"]);
            setOriginNote([area, district].filter(Boolean).join(" ") || "");
            setOriginBusy(false);
            go("appointment");
          })
          .catch((error: Error) => {
            setOriginBusy(false);
            setOriginNote(error.message);
          });
      },
      () => {
        setOriginBusy(false);
        setOriginNote(
          "위치 권한이 거부되었습니다. 아래에서 장소를 직접 검색해 주세요.",
        );
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, [go]);

  const searchAppointmentPlace = useCallback(async () => {
    const keyword = apptQuery.trim();
    if (!keyword) return;
    setApptBusy(true);
    setApptNote("");
    setApptHits([]);
    try {
      const response = await fetch(
        `/api/v1/places/search?keyword=${encodeURIComponent(keyword)}`,
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          readText(asRecord(asRecord(payload)?.error), ["message"]) ||
            "장소를 찾지 못했습니다.",
        );
      }
      const root = asRecord(payload);
      const rows = ["places", "items", "results", "candidates"]
        .map((key) => root?.[key])
        .find(Array.isArray) as unknown[] | undefined;
      const hits: PlaceHit[] = (rows ?? []).flatMap((item) => {
        const row = asRecord(item);
        const title = readText(row, ["title", "name"]);
        const latitude = Number(row?.latitude ?? row?.mapY);
        const longitude = Number(row?.longitude ?? row?.mapX);
        if (!title || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return [];
        }
        return [
          {
            title,
            address: readText(row, ["address", "addr1"]) || undefined,
            latitude,
            longitude,
            areaCode: readText(row, ["regionCode", "areaCode"]) || undefined,
            sigunguCode:
              readText(row, ["districtCode", "sigunguCode"]) || undefined,
          },
        ];
      });
      setApptHits(hits.slice(0, 6));
      if (!hits.length) setApptNote("검색 결과가 없습니다. 다르게 입력해 보세요.");
    } catch (error) {
      setApptNote((error as Error).message);
    } finally {
      setApptBusy(false);
    }
  }, [apptQuery]);

  /* Registers the synthesised two-node itinerary, then runs recovery. The
     traveller sees one "찾는 중" screen while both calls happen. */
  const runRecovery = useCallback(async () => {
    if (!incident || !origin || !apptPlace) return;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setApiLog([]);
    setErrorText("");
    go("searching");

    const push = (line: string) =>
      setApiLog((previous) =>
        previous.includes(line) ? previous : [...previous, line],
      );

    try {
      const nowIso = new Date().toISOString();
      const nodes = [
        {
          id: "now",
          sequence: 0,
          type: "visit" as const,
          title: "지금 있는 곳",
          startAt: nowIso,
          locked: false,
          reservation: false,
          location: origin,
        },
        {
          id: "next",
          sequence: 1,
          type: "reservation" as const,
          title: apptPlace.title,
          startAt: kstIso(apptDate, apptTime),
          locked: true,
          reservation: true,
          location: {
            latitude: apptPlace.latitude,
            longitude: apptPlace.longitude,
            label: apptPlace.title,
            areaCode: apptPlace.areaCode,
            sigunguCode: apptPlace.sigunguCode,
          },
        },
      ];

      push("일정 잠금 조건 등록");
      const registered = await postJson("/api/v1/itineraries", {
        itinerary: {
          title: "브리지 복구",
          timezone: "Asia/Seoul",
          audience,
          nodes,
        },
      });
      const registeredRoot = asRecord(registered);
      const itineraryId = readText(
        asRecord(registeredRoot?.itinerary) ?? registeredRoot,
        ["id"],
      );
      if (!itineraryId) {
        throw new Error("일정을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }

      push("KorService2 · 주변 공식 관광지 조회");
      push("TarRlteTarService1 · 연관 관광지 확인");
      push("KorWithService2 · 무장애 정보 검증");
      push("TatsCnctrRateService · 집중률 예측 반영");

      const recovered = await postJson("/api/v1/recover", {
        origin,
        incident,
        audience,
        indoorOnly: incident === "rain",
        availableMinutes: Math.min(
          240,
          Math.max(
            15,
            Math.floor(
              (Date.parse(kstIso(apptDate, apptTime)) - Date.now()) / 60_000,
            ),
          ),
        ),
        maxDistanceMeters: audience === "general" ? 2500 : 1500,
        radiusMeters: 5000,
        safetyBufferMinutes: 15,
        minimumStayMinutes: 30,
        analyticsConsent: false,
        itinerary: {
          id: itineraryId,
          title: "브리지 복구",
          timezone: "Asia/Seoul",
          audience,
          nodes,
          disruptedNodeId: "now",
          nextFixedNodeId: "next",
        },
      });

      if (controller.signal.aborted) return;

      const root = asRecord(recovered);
      const list = Array.isArray(root?.options)
        ? (root.options as RecoveryOption[])
        : [];
      setRejectedCount(
        typeof root?.rejectedCount === "number" ? root.rejectedCount : 0,
      );
      setOptions(list);
      go(list.length ? "options" : "empty");
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrorText((error as Error).message);
      go("error");
    }
  }, [
    incident,
    origin,
    apptPlace,
    apptDate,
    apptTime,
    audience,
    go,
  ]);

  const back = useCallback(() => {
    if (step === "origin") go("incident", true);
    else if (step === "appointment") go("origin", true);
    else if (step === "options" || step === "empty" || step === "error") {
      go("appointment", true);
    }
  }, [step, go]);

  const canGoBack =
    step !== "incident" && step !== "searching";

  return (
    <div className={styles.shell}>
      <div className={styles.top}>
        <button
          type="button"
          className={styles.back}
          onClick={back}
          disabled={!canGoBack}
          aria-label="이전 단계로"
        >
          ←
        </button>
        <div className={styles.progress} aria-hidden="true">
          {STEP_ORDER.map((entry, index) => (
            <span
              key={entry}
              className={[
                styles.tick,
                index < stepIndex ? styles.tickDone : "",
                index === stepIndex ? styles.tickNow : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          ))}
        </div>
      </div>

      <div
        key={step}
        className={`${styles.screen} ${goingBack ? styles.screenBack : ""}`}
      >
        {step === "incident" && (
          <>
            <span className={styles.eyebrow}>1단계 · 약 10초</span>
            <h1 className={styles.title}>
              지금 무슨 일이
              <br />
              생겼나요?
            </h1>
            <p className={styles.sub}>
              하나만 눌러주세요. 일정을 미리 등록하지 않아도 됩니다.
            </p>
            <div className={styles.body}>
              {INCIDENTS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  className={`${styles.choice} ${
                    incident === entry.value ? styles.choiceOn : ""
                  }`}
                  onClick={() => {
                    setIncident(entry.value);
                    go("origin");
                  }}
                >
                  <span className={styles.choiceMark}>{entry.mark}</span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>{entry.title}</span>
                    <span className={styles.choiceSub}>{entry.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "origin" && (
          <>
            <span className={styles.eyebrow}>2단계</span>
            <h1 className={styles.title}>지금 어디 계세요?</h1>
            <p className={styles.sub}>
              위치는 복구 계산에만 쓰고 저장하지 않습니다. 좌표는 소수점
              다섯 자리로 줄여 전송합니다.
            </p>
            <div className={styles.body}>
              <button
                type="button"
                className={styles.choice}
                onClick={detectOrigin}
                disabled={originBusy}
              >
                <span className={styles.choiceMark}>📍</span>
                <span className={styles.choiceText}>
                  <span className={styles.choiceTitle}>
                    {originBusy ? "확인하는 중…" : "현재 위치로 시작"}
                  </span>
                  <span className={styles.choiceSub}>
                    {originNote || "권한을 허용하면 행정구역까지 자동 입력돼요"}
                  </span>
                </span>
              </button>
              <div className={styles.field}>
                <span className={styles.label}>
                  위치 권한을 쓰기 어렵다면
                </span>
                <p className={styles.sub} style={{ margin: 0 }}>
                  다음 단계에서 약속 장소를 검색하면, 그 주변을 기준으로
                  복구안을 찾습니다.
                </p>
              </div>
            </div>
          </>
        )}

        {step === "appointment" && (
          <>
            <span className={styles.eyebrow}>3단계 · 마지막</span>
            <h1 className={styles.title}>
              몇 시까지
              <br />
              어디로 가야 하나요?
            </h1>
            <p className={styles.sub}>
              이어가는 이 약속을 지킬 수 있는 복구안만 보여줍니다.
            </p>
            <div className={styles.body}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="appt-time">
                  도착해야 하는 시각
                </label>
                <input
                  id="appt-time"
                  className={styles.input}
                  type="time"
                  value={apptTime}
                  onChange={(event) => setApptTime(event.target.value)}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="appt-place">
                  약속 장소
                </label>
                <input
                  id="appt-place"
                  className={styles.input}
                  type="search"
                  placeholder="예: 부산역, 감천문화마을"
                  value={apptQuery}
                  onChange={(event) => setApptQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void searchAppointmentPlace();
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => void searchAppointmentPlace()}
                  disabled={apptBusy || !apptQuery.trim()}
                  style={{ marginTop: 0 }}
                >
                  {apptBusy ? "찾는 중…" : "공식 관광정보에서 검색"}
                </button>
              </div>

              {apptNote && <p className={styles.sub}>{apptNote}</p>}

              {apptHits.map((hit) => (
                <button
                  key={`${hit.title}-${hit.latitude}-${hit.longitude}`}
                  type="button"
                  className={`${styles.choice} ${
                    apptPlace?.title === hit.title &&
                    apptPlace?.latitude === hit.latitude
                      ? styles.choiceOn
                      : ""
                  }`}
                  onClick={() => setApptPlace(hit)}
                >
                  <span className={styles.choiceMark}>📌</span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>{hit.title}</span>
                    {hit.address && (
                      <span className={styles.choiceSub}>{hit.address}</span>
                    )}
                  </span>
                </button>
              ))}

              <div className={styles.field} style={{ marginTop: 10 }}>
                <span className={styles.label}>이동 조건</span>
                {AUDIENCES.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    className={`${styles.choice} ${
                      audience === entry.value ? styles.choiceOn : ""
                    }`}
                    style={{ minHeight: 56 }}
                    onClick={() => setAudience(entry.value)}
                  >
                    <span className={styles.choiceText}>
                      <span className={styles.choiceTitle}>{entry.label}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {step === "searching" && (
          <div className={styles.searching}>
            <div className={styles.spinner} />
            <div>
              <h1 className={styles.title} style={{ fontSize: 22 }}>
                지킬 것을 먼저 잠그고
                <br />
                대안을 검증하고 있어요
              </h1>
              <p className={styles.sub}>
                한국관광공사 공식 데이터로 확인합니다
              </p>
            </div>
            <div className={styles.apiLog}>
              {apiLog.map((line) => (
                <div key={line} className={styles.apiRow}>
                  <span className={styles.apiDot} />
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        {step === "options" && (
          <>
            <span className={`${styles.eyebrow}`}>복구안</span>
            <h1 className={styles.title}>
              {apptTime}까지 도착할 수 있는
              <br />
              {options.length}곳을 찾았어요
            </h1>
            <p className={styles.sub}>
              {rejectedCount > 0
                ? `조건을 지키지 못한 ${rejectedCount}곳은 자동으로 제외했습니다.`
                : "모두 약속 시각과 이동 조건을 통과한 후보입니다."}
            </p>
            <div className={styles.body}>
              {options.map((option) => (
                <div key={option.id} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div>
                      <h2 className={styles.cardTitle}>{option.title}</h2>
                      {option.address && (
                        <p className={styles.cardAddr}>{option.address}</p>
                      )}
                    </div>
                    {option.strategyLabel && (
                      <span className={styles.badge}>
                        {option.strategyLabel}
                      </span>
                    )}
                  </div>

                  <div className={styles.stats}>
                    <div className={styles.stat}>
                      <div className={styles.statVal}>
                        {option.estimatedTravelMinutes != null
                          ? `${option.estimatedTravelMinutes}분`
                          : "—"}
                      </div>
                      <div className={styles.statKey}>이동</div>
                    </div>
                    <div className={styles.stat}>
                      <div className={styles.statVal}>
                        {option.distanceMeters != null
                          ? `${(option.distanceMeters / 1000).toFixed(1)}km`
                          : "—"}
                      </div>
                      <div className={styles.statKey}>거리</div>
                    </div>
                    <div className={styles.stat}>
                      <div className={styles.statVal}>1곳</div>
                      <div className={styles.statKey}>변경</div>
                    </div>
                  </div>

                  {option.purposePreservation?.statement && (
                    <p className={styles.cardAddr} style={{ marginTop: 14 }}>
                      {option.purposePreservation.statement}
                    </p>
                  )}

                  {!!option.why?.length && (
                    <ul className={styles.why}>
                      {option.why.slice(0, 4).map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}

                  {(() => {
                    const { kto, external } = appliedSources(option);
                    if (!kto.length && !external.length) return null;
                    return (
                      <div className={styles.ledger}>
                        {kto.map((name) => (
                          <span
                            key={`${option.id}-${name}`}
                            className={`${styles.ledgerChip} ${styles.ledgerChipKto}`}
                          >
                            공사 {name}
                          </span>
                        ))}
                        {external.map((name) => (
                          <span
                            key={`${option.id}-${name}`}
                            className={styles.ledgerChip}
                          >
                            보조 {name}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          </>
        )}

        {step === "empty" && (
          <div className={styles.state}>
            <div className={`${styles.stateMark} ${styles.stateWarn}`}>🔍</div>
            <div>
              <h1 className={styles.title} style={{ fontSize: 22 }}>
                조건을 지키는 대안이
                <br />
                지금은 없습니다
              </h1>
              <p className={styles.sub}>
                억지로 추천하지 않습니다. 확인하지 못한 후보는 보여드리지
                않습니다.
              </p>
            </div>
            <div className={styles.noteCard}>
              이 결과는 그냥 사라지지 않습니다. `{
                INCIDENTS.find((entry) => entry.value === incident)?.title
              }` 상황에서 대안이 없었다는 사실은 익명으로 집계되어, 해당
              지역의 대체 콘텐츠 공백으로 기록됩니다.
            </div>
          </div>
        )}

        {step === "error" && (
          <div className={styles.state}>
            <div className={`${styles.stateMark} ${styles.stateBad}`}>!</div>
            <div>
              <h1 className={styles.title} style={{ fontSize: 22 }}>
                복구안을 만들지 못했어요
              </h1>
              <p className={styles.sub}>{errorText}</p>
            </div>
          </div>
        )}
      </div>

      <div className={styles.foot}>
        {step === "appointment" && (
          <button
            type="button"
            className={styles.cta}
            disabled={
              !apptPlace ||
              availableMinutes == null ||
              availableMinutes < 15
            }
            onClick={() => void runRecovery()}
          >
            {!apptPlace
              ? "약속 장소를 선택해 주세요"
              : availableMinutes != null && availableMinutes < 15
                ? "약속까지 15분 이상 남아야 해요"
                : "예약을 지키는 복구안 찾기"}
          </button>
        )}

        {step === "origin" && (
          <button
            type="button"
            className={styles.cta}
            onClick={() => go("appointment")}
            disabled={!origin}
          >
            {origin ? "다음" : "현재 위치를 먼저 확인해 주세요"}
          </button>
        )}

        {(step === "empty" || step === "error") && (
          <button
            type="button"
            className={styles.cta}
            onClick={() => go("appointment", true)}
          >
            조건 바꿔서 다시 찾기
          </button>
        )}

        {step === "options" && (
          <button
            type="button"
            className={styles.cta}
            onClick={() => go("incident", true)}
          >
            처음부터 다시
          </button>
        )}
      </div>
    </div>
  );
}
