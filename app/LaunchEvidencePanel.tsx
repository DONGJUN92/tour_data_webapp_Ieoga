"use client";

import { useEffect, useState } from "react";
import styles from "./LaunchEvidencePanel.module.css";
import { formatDate } from "./product-app-model";

type EvidenceStatus =
  | "verified"
  | "needs_field_evidence"
  | "release_blocker";

type EvidenceItem = {
  id: string;
  title: string;
  status: EvidenceStatus;
  evidence: string;
  nextAction?: string;
};

type EvidenceReport = {
  overall: "ready" | "evidence_collection" | "blocked";
  verifiedCount: number;
  totalCount: number;
  items: EvidenceItem[];
  generatedAt: string;
};

const STATUS_META: Record<EvidenceStatus, { ko: string; en: string; symbol: string }> = {
  verified: { ko: "확보", en: "Verified", symbol: "✓" },
  needs_field_evidence: {
    ko: "현장 검증 필요",
    en: "Field evidence required",
    symbol: "·",
  },
  release_blocker: { ko: "출시 차단", en: "Release blocker", symbol: "!" },
};

const EVIDENCE_TITLES_EN: Record<string, string> = {
  deployment_commit_traceability: "Deployment-to-commit traceability",
  partner_embed_origin_policy: "Exact-origin policy for partner iframes",
  journey_completion_contract: "End-to-end journey completion",
  travel_purpose_preservation: "Preservation of travel intent",
  platform_runtime: "Itinerary and regional-evidence storage",
  stable_session_signing: "Stable anonymous-session signing",
  release_secret_separation: "Release-secret quality and separation",
  independent_field_evidence_auditor: "Independent approval of field evidence",
  eight_kto_openapis: "All 8 KTO OpenAPIs in production",
  managed_external_providers: "Production routing, mapping and weather providers",
  tripbreak_100: "K-TRIPBREAK 100 disruption scenarios",
  recovery_speed_and_false_positive: "Recovery latency and zero critical false positives",
  real_user_usability: "Independent usability evidence across 3 locales",
  field_journeys_six_regions: "Observed field journeys across 6 region types",
  comparative_benchmark_20: "20-scenario, 4-method comparison",
  practitioner_review: "Independent tourism, municipal and accessibility review",
  legal_and_operational_approvals: "Legal, data and operational approvals",
  partner_embed_pilot: "External partner iframe pilot",
  participant_consent_ledger: "Participant consent and withdrawal ledger",
};

/* 이 화면의 상태가 언제 확인된 것인지는 상태 자체만큼 중요하다. 예약 점검이
   매시 도는 구조라 표시된 판정이 몇 시간 전 것일 수 있고, 읽는 사람이 그걸
   알 방법이 없으면 지금 이 순간의 사실로 읽는다. 값은 이미 응답에 들어 있어
   추가 호출이 없다. */
type EvidenceRuntime = {
  sourceHealthCheckedAt?: string | null;
  providerProbes?: {
    providers?: Record<string, { checkedAt?: string }>;
  };
};

function oldestProbeCheckedAt(runtime: EvidenceRuntime | null): string | undefined {
  const providers = runtime?.providerProbes?.providers;
  if (!providers) return undefined;
  /* 가장 오래된 항목을 쓴다. 하나라도 오래됐으면 전체 판정이 그만큼 오래된
     것이므로, 가장 최근 시각을 보여 주면 실제보다 최신으로 읽힌다. */
  let oldest: number | undefined;
  let label: string | undefined;
  for (const item of Object.values(providers)) {
    if (!item?.checkedAt) continue;
    const at = Date.parse(item.checkedAt);
    if (!Number.isFinite(at)) continue;
    if (oldest === undefined || at < oldest) {
      oldest = at;
      label = item.checkedAt;
    }
  }
  return label;
}

export function LaunchEvidencePanel({
  language = "ko",
}: {
  language?: "ko" | "en";
}) {
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const [report, setReport] = useState<EvidenceReport | null>(null);
  const [runtime, setRuntime] = useState<EvidenceRuntime | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  async function load() {
    setState("loading");
    try {
      const response = await fetch("/api/v1/release/evidence", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        report?: EvidenceReport;
        runtime?: EvidenceRuntime;
      };
      if (!response.ok || !payload.report) {
        throw new Error("launch evidence unavailable");
      }
      setReport(payload.report);
      setRuntime(payload.runtime ?? null);
      setState("ready");
    } catch {
      setReport(null);
      setRuntime(null);
      setState("error");
    }
  }

  useEffect(() => {
    let live = true;
    fetch("/api/v1/release/evidence", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          report?: EvidenceReport;
          runtime?: EvidenceRuntime;
        };
        if (!response.ok || !payload.report) {
          throw new Error("launch evidence unavailable");
        }
        if (!live) return;
        setReport(payload.report);
        setRuntime(payload.runtime ?? null);
        setState("ready");
      })
      .catch(() => {
        if (!live) return;
        setReport(null);
        setRuntime(null);
        setState("error");
      });
    return () => {
      live = false;
    };
  }, []);

  const sourceCheckedAt = runtime?.sourceHealthCheckedAt ?? undefined;
  const probeCheckedAt = oldestProbeCheckedAt(runtime);

  return (
    <section
      id="launch-evidence"
      className={styles.panel}
      aria-labelledby="launch-evidence-title"
    >
      <div className={styles.heading}>
        <div>
          <p>{tr("서비스 준비 현황", "Release evidence")}</p>
          <h2 id="launch-evidence-title">
            {tr(
              "무엇이 준비됐고 무엇이 남았는지 그대로 적었어요",
              "What is verified—and what still blocks release",
            )}
          </h2>
          <span>
            {tr(
              "구현 완료와 현장 검증을 섞어 표시하지 않습니다. 아직 없는 증거는 그대로 ‘필요’로 남깁니다.",
              "Implementation and independently approved field evidence are reported separately. Missing proof stays visibly incomplete.",
            )}
          </span>
        </div>
        {report && (
          <div className={styles.score} data-overall={report.overall}>
            <strong>
              {report.verifiedCount}/{report.totalCount}
            </strong>
            <small>{tr("확보된 증거", "verified controls")}</small>
          </div>
        )}
      </div>

      {state === "loading" && (
        <div className={styles.state} role="status">
          {tr("준비 현황을 확인하고 있어요.", "Checking release evidence.")}
        </div>
      )}

      {state === "error" && (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          <span>
            {tr(
              "준비 현황을 지금 불러오지 못했어요. 여행 복구 기능은 그대로 사용할 수 있습니다.",
              "Release evidence is unavailable right now. Trip recovery remains available.",
            )}
          </span>
          <button type="button" onClick={() => void load()}>
            {tr("다시 확인", "Try again")}
          </button>
        </div>
      )}

      {report && (
        <>
          <div className={styles.summary} data-overall={report.overall}>
            <strong>
              {report.overall === "ready"
                ? tr("출시 증거가 모두 확보됐어요", "Every release control is verified")
                : report.overall === "blocked"
                  ? tr(
                      "운영 설정 차단 항목부터 해결해야 해요",
                      "A release-blocking control must be resolved first",
                    )
                  : tr(
                      "제품은 동작하지만 현장 증거 수집이 남았어요",
                      "The product runs, but independent field evidence is incomplete",
                    )}
            </strong>
            <span>
              {tr(
                "각 항목의 다음 행동까지 완료해야 ‘확보’로 바뀝니다.",
                "A control changes to verified only after its evidence and approval requirements are complete.",
              )}
            </span>
          </div>

          <ul className={styles.list}>
            {report.items.map((item) => {
              const meta = STATUS_META[item.status];
              return (
                <li key={item.id} data-status={item.status}>
                  <span className={styles.symbol} aria-hidden="true">
                    {meta.symbol}
                  </span>
                  <div>
                    <div className={styles.itemHeading}>
                      <strong>
                        {language === "en"
                          ? EVIDENCE_TITLES_EN[item.id] ?? "Release evidence control"
                          : item.title}
                      </strong>
                      <b>{language === "en" ? meta.en : meta.ko}</b>
                    </div>
                    <p>
                      {language === "en"
                        ? item.status === "verified"
                          ? "The currently published release record verifies this control."
                          : item.status === "release_blocker"
                            ? "This control is not verified, so the deployment remains blocked for release."
                            : "Independent field evidence has not yet been approved for this control."
                        : item.evidence}
                    </p>
                    {language === "en" && (
                      <small lang="ko">
                        Official Korean audit detail · {item.evidence}
                      </small>
                    )}
                    {item.nextAction && (
                      <small lang={language === "en" ? "ko" : undefined}>
                        {language === "en"
                          ? `Official Korean required action · ${item.nextAction}`
                          : `다음 행동 · ${item.nextAction}`}
                      </small>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {(sourceCheckedAt || probeCheckedAt) && (
            <dl className={styles.checkedAt}>
              {sourceCheckedAt && (
                <div>
                   <dt>{tr("관광정보 8종 마지막 점검", "Oldest check across the 8 tourism APIs")}</dt>
                  <dd>
                    <time dateTime={sourceCheckedAt}>
                       {formatDate(sourceCheckedAt, language)}
                    </time>
                  </dd>
                </div>
              )}
              {probeCheckedAt && (
                <div>
                   <dt>{tr("외부 제공자 마지막 점검", "Oldest external-provider check")}</dt>
                  <dd>
                    <time dateTime={probeCheckedAt}>
                       {formatDate(probeCheckedAt, language)}
                    </time>
                  </dd>
                </div>
              )}
              <p>
                 {tr(
                   "매시 예약 점검이 갱신합니다. 위 판정은 이 시각 기준입니다.",
                   "Scheduled checks refresh hourly. The status above is valid only for these timestamps.",
                 )}
              </p>
            </dl>
          )}
        </>
      )}
    </section>
  );
}
