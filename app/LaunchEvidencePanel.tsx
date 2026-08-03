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

const STATUS_META: Record<
  EvidenceStatus,
  { label: string; symbol: string }
> = {
  verified: { label: "확보", symbol: "✓" },
  needs_field_evidence: { label: "현장 검증 필요", symbol: "·" },
  release_blocker: { label: "출시 차단", symbol: "!" },
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

export function LaunchEvidencePanel() {
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
          <p>서비스 준비 현황</p>
          <h2 id="launch-evidence-title">
            무엇이 준비됐고 무엇이 남았는지 그대로 적었어요
          </h2>
          <span>
            구현 완료와 현장 검증을 섞어 표시하지 않습니다. 아직 없는
            증거는 그대로 ‘필요’로 남깁니다.
          </span>
        </div>
        {report && (
          <div className={styles.score} data-overall={report.overall}>
            <strong>
              {report.verifiedCount}/{report.totalCount}
            </strong>
            <small>확보된 증거</small>
          </div>
        )}
      </div>

      {state === "loading" && (
        <div className={styles.state} role="status">
          준비 현황을 확인하고 있어요.
        </div>
      )}

      {state === "error" && (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          <span>
            준비 현황을 지금 불러오지 못했어요. 여행 복구 기능은 그대로
            사용할 수 있습니다.
          </span>
          <button type="button" onClick={() => void load()}>
            다시 확인
          </button>
        </div>
      )}

      {report && (
        <>
          <div className={styles.summary} data-overall={report.overall}>
            <strong>
              {report.overall === "ready"
                ? "출시 증거가 모두 확보됐어요"
                : report.overall === "blocked"
                  ? "운영 설정 차단 항목부터 해결해야 해요"
                  : "제품은 동작하지만 현장 증거 수집이 남았어요"}
            </strong>
            <span>
              각 항목의 다음 행동까지 완료해야 ‘확보’로 바뀝니다.
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
                      <strong>{item.title}</strong>
                      <b>{meta.label}</b>
                    </div>
                    <p>{item.evidence}</p>
                    {item.nextAction && (
                      <small>다음 행동 · {item.nextAction}</small>
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
                  <dt>관광정보 8종 마지막 점검</dt>
                  <dd>
                    <time dateTime={sourceCheckedAt}>
                      {formatDate(sourceCheckedAt)}
                    </time>
                  </dd>
                </div>
              )}
              {probeCheckedAt && (
                <div>
                  <dt>외부 제공자 마지막 점검</dt>
                  <dd>
                    <time dateTime={probeCheckedAt}>
                      {formatDate(probeCheckedAt)}
                    </time>
                  </dd>
                </div>
              )}
              <p>
                매시 예약 점검이 갱신합니다. 위 판정은 이 시각 기준입니다.
              </p>
            </dl>
          )}
        </>
      )}
    </section>
  );
}
