"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useEffect, useState } from "react";

type Language = "ko" | "en";
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function tr(language: Language, ko: string, en: string): string {
  return language === "en" ? en : ko;
}

function formatDateTime(value: unknown, language: Language): string {
  const raw = text(value);
  if (!raw) return tr(language, "기록 없음", "Not recorded");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function providerLabel(value: unknown, language: Language): string {
  const labels: Record<string, { ko: string; en: string }> = {
    tmap_pedestrian: { ko: "TMAP 보행 경로", en: "TMAP pedestrian routing" },
    tmap_car: { ko: "TMAP 자동차 경로", en: "TMAP driving routing" },
    kakao_transit: { ko: "카카오 대중교통 경로", en: "Kakao transit routing" },
    kakao_bicycle: { ko: "카카오 자전거 경로", en: "Kakao bicycle routing" },
    openstreetmap_osrm: {
      ko: "OpenStreetMap OSRM 경로",
      en: "OpenStreetMap OSRM routing",
    },
    ieoga_conservative_estimate: {
      ko: "이어가 보수적 직선거리 추정",
      en: "IEOGA conservative geodesic estimate",
    },
  };
  const raw = text(value);
  return labels[raw]?.[language] ?? tr(language, "제공자 미기록", "Provider not recorded");
}

function decisionLabel(value: unknown, language: Language): string {
  const labels: Record<string, { ko: string; en: string }> = {
    verified: { ko: "검증된 추천 판정", en: "Verified recommendation decision" },
    degraded: {
      ko: "보조 데이터 제한이 있는 추천 판정",
      en: "Recommendation with supporting-data limits",
    },
  };
  return (
    labels[text(value)]?.[language] ??
    tr(language, "추천 판정 상태 미확인", "Recommendation decision unverified")
  );
}

function executionStatusLabel(value: unknown, language: Language): string {
  const labels: Record<string, { ko: string; en: string }> = {
    active: { ko: "진행 중", en: "Active" },
    contract_met: { ko: "다음 약속 준수", en: "Protected appointment met" },
    contract_missed: { ko: "다음 약속 미준수", en: "Protected appointment missed" },
    completed: { ko: "전체 동선 완료", en: "Whole journey completed" },
    abandoned: { ko: "남은 동선 중단", en: "Remaining journey ended" },
    superseded: { ko: "다른 복구안으로 교체", en: "Superseded by another recovery" },
  };
  return (
    labels[text(value)]?.[language] ??
    tr(language, "실행 상태 미기록", "Execution status not recorded")
  );
}

function outcomeCopy(
  outcome: RecordValue,
  language: Language,
): { title: string; detail: string; tone: string } {
  const event = text(outcome.event);
  const evidenceKind = text(outcome.evidenceKind);
  const verificationLevel = text(outcome.verificationLevel);
  if (event === "selected") {
    return {
      title: tr(language, "대안 선택", "Option selected"),
      detail: tr(
        language,
        "목록에서 골랐다는 기록입니다. 적용 또는 도착을 뜻하지 않습니다.",
        "This records a list selection. It does not mean applied or arrived.",
      ),
      tone: "neutral",
    };
  }
  if (event === "applied") {
    return {
      title: tr(language, "복구 실행 활성화", "Recovery execution activated"),
      detail: tr(
        language,
        "서버가 복구 실행을 만든 시스템 기록입니다. 도착 증거는 아닙니다.",
        "A system record that the server created a recovery execution. It is not arrival evidence.",
      ),
      tone: "active",
    };
  }
  if (event === "arrived") {
    const onTime = outcome.arrivedOnTime;
    const result =
      onTime === true
        ? tr(language, "약속 시각 이내로 보고됨", "Reported within the promised time")
        : onTime === false
          ? tr(language, "약속 시각 이후로 보고됨", "Reported after the promised time")
          : tr(language, "정시 여부 미확인", "On-time result not recorded");
    return {
      title: tr(language, "여행자 도착 보고", "Traveller-reported arrival"),
      detail: `${result} · ${
        evidenceKind === "traveler_self_report" ||
        verificationLevel === "self_reported_unverified"
          ? tr(
              language,
              "자가 보고이며 제3자 검증 없음",
              "Self-reported; not independently verified",
            )
          : tr(language, "증거 출처 미확인", "Evidence source unverified")
      }`,
      tone: onTime === true ? "met" : onTime === false ? "missed" : "neutral",
    };
  }
  if (event === "abandoned") {
    return {
      title: tr(language, "복구 실행 종료", "Recovery execution ended"),
      detail: tr(
        language,
        "여행자가 복구 실행을 종료한 기록입니다.",
        "The traveller ended the recovery execution.",
      ),
      tone: "neutral",
    };
  }
  return {
    title: tr(language, "기타 실행 기록", "Other execution record"),
    detail: tr(
      language,
      "이 기록만으로 적용·도착·성공을 주장하지 않습니다.",
      "This record alone does not establish application, arrival or success.",
    ),
    tone: "neutral",
  };
}

export function ShareView({ token }: { token: string }) {
  const [language, setLanguage] = useState<Language>("ko");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; proof: RecordValue }
  >({ status: "loading" });

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/share/${encodeURIComponent(token)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          proof?: RecordValue;
          error?: { message?: string };
        };
        if (!response.ok || !payload.proof) {
          throw new Error(
            payload.error?.message ?? "복구 증명서를 불러오지 못했습니다.",
          );
        }
        if (active) setState({ status: "ready", proof: payload.proof });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "복구 증명서를 불러오지 못했습니다.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  const languageToggle = (
    <div className="share-language" role="group" aria-label="Language · 언어">
      <button
        type="button"
        aria-pressed={language === "ko"}
        onClick={() => setLanguage("ko")}
      >
        KO
      </button>
      <button
        type="button"
        aria-pressed={language === "en"}
        onClick={() => setLanguage("en")}
      >
        EN
      </button>
    </div>
  );

  if (state.status === "loading") {
    return (
      <>
        {languageToggle}
        <p className="share-status" role="status">
          {tr(language, "복구 증명서를 확인하고 있습니다.", "Checking the recovery proof.")}
        </p>
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        {languageToggle}
        <div className="share-status error" role="alert">
          <h1>{tr(language, "공유 링크를 확인해 주세요", "Check this share link")}</h1>
          <p>
            {language === "en" && /[가-힣]/u.test(state.message)
              ? "The proof is unavailable or this link has expired."
              : state.message}
          </p>
          <a href="/">{tr(language, "이어가로 돌아가기", "Back to IEOGA")}</a>
        </div>
      </>
    );
  }

  const proof = state.proof;
  const option = record(proof.option);
  const scheduleDiff = record(proof.scheduleDiff);
  const nextFixed = record(scheduleDiff.nextFixedAppointment);
  const openWindow = record(scheduleDiff.openWindow);
  const continuity = record(proof.continuityProof);
  const route = record(continuity.routeEvidence);
  const availability = record(continuity.availabilityEvidence);
  const outcomes = records(proof.outcomes);
  const execution = record(proof.execution);
  const sources = Array.isArray(option.sources)
    ? option.sources.map(text).filter(Boolean)
    : [];
  const nextFixedPreserved =
    nextFixed.status === "preserved" &&
    scheduleDiff.nextFixedAppointmentPreserved === true;
  const availabilityConfirmed = availability.status === "confirmed_open";
  const routeVerified = route.status === "routed";
  const mode = text(proof.recoveryMode);
  const historicalProof =
    text(proof.proofKind) === "historical_execution" &&
    text(proof.actionability) === "historical_not_actionable";
  const actionableAtShare =
    text(proof.proofKind) === "actionable_recovery" &&
    text(proof.actionability) === "current_at_share";

  return (
    <>
      {languageToggle}
      <article className="share-proof">
        <p className="eyebrow">IEOGA AUDITABLE RECOVERY PROOF</p>
        <h1>{text(option.title) || tr(language, "복구 대안", "Recovery option")}</h1>
        <p className="share-lead">
          {tr(
            language,
            "추천 시점의 판정 근거와 이후 실행 기록을 분리한 감사용 증명입니다. 추천·선택만으로 적용이나 도착을 주장하지 않습니다.",
            "An auditable proof that separates recommendation-time evidence from later execution records. Recommendation or selection alone never means applied or arrived.",
          )}
        </p>
        <div
          className={`share-actionability ${
            historicalProof
              ? "is-historical"
              : actionableAtShare
                ? "is-current-at-share"
                : "is-unknown"
          }`}
          role="status"
          data-testid="share-actionability"
        >
          <strong>
            {historicalProof
              ? tr(
                  language,
                  "과거 실행 이력 · 현재 이동 결정에 사용 불가",
                  "Historical execution record · not for a current travel decision",
                )
              : actionableAtShare
                ? tr(
                    language,
                    "공유 시점에만 재검증된 실행 가능 판정",
                    "Actionable decision revalidated at sharing time only",
                  )
                : tr(
                    language,
                    "증명의 사용 범위 미확인 · 이동 결정에 사용하지 마세요",
                    "Proof scope unverified · do not use for a travel decision",
                  )}
          </strong>
          <p>
            {historicalProof
              ? tr(
                  language,
                  "보호된 당시 판정과 이후 서버 실행 기록을 봉인해 보여 줍니다. 현재 영업·경로·예약 상태를 뜻하지 않습니다.",
                  "This seals the protected decision and later server execution record. It does not describe current opening, route or booking conditions.",
                )
              : actionableAtShare
                ? tr(
                    language,
                    "표시된 생성·확인·만료 시각을 확인하세요. 출발 전 시간이 지났다면 새 복구안을 받아야 합니다.",
                    "Check the displayed generation, verification and expiry times. Request a new recovery if time has passed before departure.",
                  )
                : tr(
                    language,
                    "서버가 판정 종류와 실행 가능 범위를 증명하지 못했습니다.",
                    "The server did not establish the proof kind and actionability scope.",
                  )}
          </p>
        </div>

        <section className="share-proof-section" aria-labelledby="share-decision">
          <div className="share-section-heading">
            <div>
              <p>{tr(language, "추천 시점", "At recommendation time")}</p>
              <h2 id="share-decision">
                {tr(language, "1. 판정 계약", "1. Decision contract")}
              </h2>
            </div>
            <span className="share-proof-badge">{decisionLabel(proof.decisionStatus, language)}</span>
          </div>
          <div className="share-proof-facts">
            <dl>
              <dt>{tr(language, "판정 생성", "Decision generated")}</dt>
              <dd>{formatDateTime(proof.generatedAt, language)}</dd>
            </dl>
            <dl>
              <dt>{tr(language, "규칙 버전", "Rule version")}</dt>
              <dd>{text(proof.ruleVersion) || tr(language, "미기록", "Not recorded")}</dd>
            </dl>
            <dl>
              <dt>{tr(language, "공유 만료", "Share expires")}</dt>
              <dd>{formatDateTime(proof.shareExpiresAt, language)}</dd>
            </dl>
            <dl>
              <dt>{tr(language, "복구 방식", "Recovery mode")}</dt>
              <dd>
                {mode === "open_window"
                  ? tr(language, "빈 시간 왕복 추천", "Open-window round trip")
                  : mode === "registered_itinerary"
                    ? tr(language, "등록 일정 한 곳 교체", "One-stop itinerary replacement")
                    : tr(language, "방식 미기록", "Mode not recorded")}
              </dd>
            </dl>
          </div>
        </section>

        <section className="share-proof-section" aria-labelledby="share-continuity">
          <div className="share-section-heading">
            <div>
              <p>{tr(language, "시간·동선 계약", "Time and route contract")}</p>
              <h2 id="share-continuity">
                {tr(language, "2. 지켜야 할 경계", "2. Protected boundary")}
              </h2>
            </div>
          </div>
          {mode === "open_window" ? (
            <div className="share-proof-facts">
              <dl>
                <dt>{tr(language, "자유 시간", "Free-time window")}</dt>
                <dd>
                  {formatDateTime(openWindow.windowStartAt, language)} →{" "}
                  {formatDateTime(openWindow.windowEndAt, language)}
                </dd>
              </dl>
              <dl>
                <dt>{tr(language, "왕복 계산", "Round-trip calculation")}</dt>
                <dd>
                  {number(openWindow.travelToMinutes) ?? "-"} + {number(openWindow.appliedStayMinutes) ?? "-"} + {number(openWindow.returnMinutes) ?? "-"} min
                </dd>
              </dl>
              <dl>
                <dt>{tr(language, "복귀 경로", "Return route")}</dt>
                <dd>{providerLabel(openWindow.returnProvider, language)}</dd>
              </dl>
              <dl>
                <dt>{tr(language, "복귀 경로 계산", "Return route calculated")}</dt>
                <dd>{formatDateTime(openWindow.returnCalculatedAt, language)}</dd>
              </dl>
              <dl>
                <dt>{tr(language, "복귀 거리", "Return distance")}</dt>
                <dd>{number(openWindow.returnDistanceMeters)?.toLocaleString() ?? "-"} m</dd>
              </dl>
              <dl>
                <dt>{tr(language, "남은 여유", "Remaining slack")}</dt>
                <dd>{number(openWindow.leftoverMinutes) ?? "-"} min</dd>
              </dl>
              <dl>
                <dt>{tr(language, "필수 안전여유", "Required safety reserve")}</dt>
                <dd>{number(openWindow.requiredBufferMinutes) ?? "-"} min</dd>
              </dl>
            </div>
          ) : (
            <div className="share-contract-card">
              <span className={nextFixedPreserved ? "is-verified" : "is-unverified"}>
                {nextFixedPreserved
                  ? tr(language, "다음 고정 일정 보존", "Next fixed appointment preserved")
                  : tr(language, "보존 근거 미확인", "Preservation evidence unverified")}
              </span>
              <h3>{text(nextFixed.title) || tr(language, "다음 고정 일정", "Next fixed appointment")}</h3>
              <dl>
                <div>
                  <dt>{tr(language, "약속 시각", "Promised time")}</dt>
                  <dd>{formatDateTime(nextFixed.scheduledAt, language)}</dd>
                </div>
                <div>
                  <dt>{tr(language, "예상 도착", "Estimated arrival")}</dt>
                  <dd>{formatDateTime(nextFixed.estimatedArrivalAt, language)}</dd>
                </div>
                <div>
                  <dt>{tr(language, "도착 여유", "Arrival buffer")}</dt>
                  <dd>{number(nextFixed.arrivalBufferMinutes) ?? "-"} min</dd>
                </div>
                <div>
                  <dt>{tr(language, "요구 안전 여유", "Required safety buffer")}</dt>
                  <dd>{number(nextFixed.requiredBufferMinutes) ?? "-"} min</dd>
                </div>
              </dl>
            </div>
          )}
        </section>

        <section className="share-proof-section" aria-labelledby="share-evidence">
          <div className="share-section-heading">
            <div>
              <p>{tr(language, "출처와 시각", "Provenance and time")}</p>
              <h2 id="share-evidence">
                {tr(language, "3. 운영·경로 근거", "3. Opening and route evidence")}
              </h2>
            </div>
          </div>
          <div className="share-proof-facts">
            <dl>
              <dt>{tr(language, "체류 구간", "Proposed stay")}</dt>
              <dd>
                {formatDateTime(record(scheduleDiff.replacementNode).startAt, language)} →{" "}
                {formatDateTime(record(scheduleDiff.replacementNode).endAt, language)}
              </dd>
            </dl>
            <dl>
              <dt>{tr(language, "운영 확인", "Opening verification")}</dt>
              <dd>
                {availabilityConfirmed
                  ? tr(language, "전체 체류 구간 공식 운영 확인", "Officially open for the full stay")
                  : tr(language, "공식 운영 근거 미확인", "Official opening evidence unverified")}
              </dd>
            </dl>
            <dl>
              <dt>{tr(language, "운영 근거 확인", "Opening checked")}</dt>
              <dd>{formatDateTime(availability.checkedAt, language)}</dd>
            </dl>
            <dl>
              <dt>{tr(language, "가는·연속 경로", "Outbound/continuity route")}</dt>
              <dd>
                {routeVerified
                  ? providerLabel(route.provider, language)
                  : tr(language, "실경로 미확인", "Real route unverified")}
              </dd>
            </dl>
            <dl>
              <dt>{tr(language, "경로 계산", "Route calculated")}</dt>
              <dd>{formatDateTime(route.calculatedAt, language)}</dd>
            </dl>
            <dl>
              <dt>{tr(language, "공식 데이터 출처", "Official data sources")}</dt>
              <dd>{sources.length ? sources.join(" · ") : tr(language, "미기록", "Not recorded")}</dd>
            </dl>
          </div>
        </section>

        <section className="share-proof-section" aria-labelledby="share-execution">
          <div className="share-section-heading">
            <div>
              <p>{tr(language, "추천 이후", "After recommendation")}</p>
              <h2 id="share-execution">
                {tr(language, "4. 실행·도착 기록", "4. Execution and arrival records")}
              </h2>
            </div>
          </div>
          {historicalProof && Object.keys(execution).length > 0 ? (
            <div className="share-proof-facts share-execution-facts">
              <dl>
                <dt>{tr(language, "서버 실행 상태", "Server execution status")}</dt>
                <dd>{executionStatusLabel(execution.status, language)}</dd>
              </dl>
              <dl>
                <dt>{tr(language, "실행 시작", "Execution activated")}</dt>
                <dd>{formatDateTime(execution.activatedAt, language)}</dd>
              </dl>
              {execution.contractMetAt ? (
                <dl>
                  <dt>{tr(language, "약속 준수 기록", "Appointment met record")}</dt>
                  <dd>{formatDateTime(execution.contractMetAt, language)}</dd>
                </dl>
              ) : null}
              {execution.contractMissedAt ? (
                <dl>
                  <dt>{tr(language, "약속 미준수 기록", "Appointment missed record")}</dt>
                  <dd>{formatDateTime(execution.contractMissedAt, language)}</dd>
                </dl>
              ) : null}
              {execution.completedAt ? (
                <dl>
                  <dt>{tr(language, "전체 동선 완료", "Whole journey completed")}</dt>
                  <dd>{formatDateTime(execution.completedAt, language)}</dd>
                </dl>
              ) : null}
              <dl>
                <dt>{tr(language, "마지막 서버 갱신", "Last server update")}</dt>
                <dd>{formatDateTime(execution.lastUpdatedAt, language)}</dd>
              </dl>
            </div>
          ) : null}
          {outcomes.length ? (
            <ol className="share-outcomes">
              {outcomes.map((outcome, index) => {
                const copy = outcomeCopy(outcome, language);
                return (
                  <li key={`${text(outcome.event)}-${text(outcome.occurredAt)}-${index}`} className={`is-${copy.tone}`}>
                    <div>
                      <strong>{copy.title}</strong>
                      <time>{formatDateTime(outcome.occurredAt, language)}</time>
                    </div>
                    <p>{copy.detail}</p>
                    {outcome.actualArrivalAt ? (
                      <small>
                        {tr(language, "보고 도착 시각", "Reported arrival time")} ·{" "}
                        {formatDateTime(outcome.actualArrivalAt, language)}
                      </small>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="share-empty-evidence" role="status">
              {tr(
                language,
                "공유 당시 적용·도착 실행 기록이 없습니다. 이 증명은 추천 판정만 보여 줍니다.",
                "No application or arrival record existed when shared. This proof shows the recommendation decision only.",
              )}
            </p>
          )}
        </section>

        <p className="share-notice">
          {(language === "ko" ? text(proof.notice) : "") ||
            tr(
              language,
              "이 증명은 판정 당시 근거 기록이며 예약·운영·물리적 안전을 보증하지 않습니다.",
              "This is a record of evidence at decision time, not a guarantee of booking, opening or physical safety.",
            )}
        </p>
        <a className="primary-link" href="/">
          {tr(language, "내 여행 복구하기", "Recover my trip")}
        </a>
      </article>
    </>
  );
}
