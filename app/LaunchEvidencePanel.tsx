"use client";

import { useEffect, useState } from "react";
import styles from "./LaunchEvidencePanel.module.css";

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

export function LaunchEvidencePanel() {
  const [report, setReport] = useState<EvidenceReport | null>(null);
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
      };
      if (!response.ok || !payload.report) {
        throw new Error("launch evidence unavailable");
      }
      setReport(payload.report);
      setState("ready");
    } catch {
      setReport(null);
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
        };
        if (!response.ok || !payload.report) {
          throw new Error("launch evidence unavailable");
        }
        if (!live) return;
        setReport(payload.report);
        setState("ready");
      })
      .catch(() => {
        if (!live) return;
        setReport(null);
        setState("error");
      });
    return () => {
      live = false;
    };
  }, []);

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
        </>
      )}
    </section>
  );
}
