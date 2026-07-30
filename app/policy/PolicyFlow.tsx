"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../flow/flow.module.css";

/* The policy view used to be a single scrolling report: every region, metric,
   coverage figure and mission stacked on one page. Here it is a sequence —
   pick a region, watch the official indicators load, then read the result —
   so a reader follows one question at a time. */

type Step = "region" | "loading" | "result" | "error";

type Region = { code: string; name: string };

type Metric = {
  key: string;
  label: string;
  officialName?: string;
  value: number | null;
  source: string;
  operation: string;
  baseYm?: string;
};

type Coverage = {
  available: number;
  expected: number;
  percent: number;
  meaning: string;
};

type LedgerEntry = { api?: string; operation?: string; status?: string };

type Insight = {
  regionName: string;
  districtName?: string;
  baseYm?: string;
  coverage: Coverage;
  metrics: Metric[];
  sourceLedger: LedgerEntry[];
  warnings: string[];
  generatedAt?: string;
};

type Mission = {
  id?: string;
  missionId?: string;
  title?: string;
  summary?: string;
  status?: string;
  regionName?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = asRecord(asRecord(payload)?.error);
    throw new Error(
      typeof error?.message === "string"
        ? error.message
        : "지역 데이터를 불러오지 못했습니다.",
    );
  }
  return payload;
}

/* Indicator values are agency index numbers, not percentages, so they are
   shown as-is with the official name rather than being rescaled. */
function formatValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "미확인";
  return value.toFixed(1);
}

function statusLabel(status?: string): string {
  switch (status) {
    case "live":
      return "응답 확인";
    case "empty":
      return "값 없음";
    case "not_required":
      return "미사용";
    case "error":
      return "응답 실패";
    default:
      return status ?? "—";
  }
}

export default function PolicyFlow() {
  const [step, setStep] = useState<Step>("region");
  const [goingBack, setGoingBack] = useState(false);

  const [regions, setRegions] = useState<Region[]>([]);
  const [regionsError, setRegionsError] = useState("");
  const [selected, setSelected] = useState<Region | null>(null);

  const [insight, setInsight] = useState<Insight | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [apiLog, setApiLog] = useState<string[]>([]);
  const [errorText, setErrorText] = useState("");

  const go = useCallback((next: Step, back = false) => {
    setGoingBack(back);
    setStep(next);
  }, []);

  useEffect(() => {
    getJson("/api/v1/regions")
      .then((payload) => {
        const rows = asRecord(payload)?.regions;
        setRegions(Array.isArray(rows) ? (rows as Region[]) : []);
      })
      .catch((error: Error) => setRegionsError(error.message));
  }, []);

  const loadRegion = useCallback(
    async (region: Region) => {
      setSelected(region);
      setErrorText("");
      setApiLog([]);
      go("loading");
      const push = (line: string) =>
        setApiLog((previous) =>
          previous.includes(line) ? previous : [...previous, line],
        );
      push("AreaTarDivService · 관광 다양성 지표");
      push("AreaTarDemDsService · 체류·소비 수요 강도");
      push("AreaTarResDemService · 관광서비스·문화자원 수요");
      push("LocgoHubTarService1 · 중심 관광지 확인");
      try {
        const [insightPayload, missionPayload] = await Promise.all([
          getJson(`/api/v1/insights/regions/${region.code}`),
          getJson(`/api/v1/insights/missions?areaCode=${region.code}`).catch(
            () => null,
          ),
        ]);
        const root = asRecord(insightPayload);
        if (!root) throw new Error("지역 응답을 해석하지 못했습니다.");
        setInsight({
          regionName: String(root.regionName ?? region.name),
          districtName:
            typeof root.districtName === "string" ? root.districtName : undefined,
          baseYm: typeof root.baseYm === "string" ? root.baseYm : undefined,
          coverage: root.coverage as Coverage,
          metrics: Array.isArray(root.metrics) ? (root.metrics as Metric[]) : [],
          sourceLedger: Array.isArray(root.sourceLedger)
            ? (root.sourceLedger as LedgerEntry[])
            : [],
          warnings: Array.isArray(root.warnings)
            ? (root.warnings as string[])
            : [],
          generatedAt:
            typeof root.generatedAt === "string" ? root.generatedAt : undefined,
        });
        const missionRoot = asRecord(missionPayload);
        setMissions(
          Array.isArray(missionRoot?.missions)
            ? (missionRoot.missions as Mission[])
            : [],
        );
        go("result");
      } catch (error) {
        setErrorText((error as Error).message);
        go("error");
      }
    },
    [go],
  );

  const back = useCallback(() => {
    if (step !== "region") go("region", true);
  }, [step, go]);

  const STEPS: Step[] = ["region", "loading", "result"];
  const stepIndex = Math.max(0, STEPS.indexOf(step));

  return (
    <div className={styles.shell}>
      <div className={styles.top}>
        <button
          type="button"
          className={styles.back}
          onClick={back}
          disabled={step === "region" || step === "loading"}
          aria-label="지역 선택으로"
        >
          ←
        </button>
        <div className={styles.progress} aria-hidden="true">
          {STEPS.map((entry, index) => (
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
        {step === "region" && (
          <>
            <span className={styles.eyebrow}>지역 회복력</span>
            <h1 className={styles.title}>
              어느 지역의
              <br />
              빈틈을 보시겠어요?
            </h1>
            <p className={styles.sub}>
              한국관광공사 공식 정책 지표를 지금 조회합니다. 저장된 값이
              아니라 조회 시점의 응답입니다.
            </p>
            <div className={styles.body}>
              {regionsError && <p className={styles.sub}>{regionsError}</p>}
              {!regions.length && !regionsError && (
                <p className={styles.sub}>공식 지역코드를 불러오는 중…</p>
              )}
              {regions.map((region) => (
                <button
                  key={region.code}
                  type="button"
                  className={styles.choice}
                  style={{ minHeight: 60 }}
                  onClick={() => void loadRegion(region)}
                >
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>{region.name}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "loading" && (
          <div className={styles.searching}>
            <div className={styles.spinner} />
            <div>
              <h1 className={styles.title} style={{ fontSize: 22 }}>
                {selected?.name}의
                <br />
                공식 지표를 조회하고 있어요
              </h1>
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

        {step === "result" && insight && (
          <>
            <span className={styles.eyebrow}>
              {insight.baseYm
                ? `${insight.baseYm.slice(0, 4)}년 ${insight.baseYm.slice(4)}월 기준`
                : "최신 가용 기준월"}
            </span>
            <h1 className={styles.title}>{insight.regionName}</h1>
            <p className={styles.sub}>{insight.coverage?.meaning}</p>

            <div className={styles.body}>
              <div className={styles.card}>
                <div className={styles.cardTop}>
                  <div>
                    <h2 className={styles.cardTitle}>근거 커버리지</h2>
                    <p className={styles.cardAddr}>
                      공식 세부지표 {insight.coverage?.expected}개 중{" "}
                      {insight.coverage?.available}개 값 확인
                    </p>
                  </div>
                  <span
                    className={`${styles.badge} ${
                      insight.coverage?.percent >= 100
                        ? styles.badgeRestored
                        : ""
                    }`}
                  >
                    {insight.coverage?.percent}%
                  </span>
                </div>
              </div>

              {insight.metrics.map((metric) => (
                <div key={`${metric.source}-${metric.key}`} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div>
                      <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                        {metric.officialName || metric.label}
                      </h2>
                      <p className={styles.cardAddr}>
                        {metric.source} · {metric.operation}
                      </p>
                    </div>
                    <span className={styles.badge}>
                      {formatValue(metric.value)}
                    </span>
                  </div>
                </div>
              ))}

              <div className={styles.card}>
                <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                  이 화면을 만든 공사 OpenAPI
                </h2>
                <div className={styles.ledger} style={{ marginTop: 12 }}>
                  {insight.sourceLedger.map((entry, index) => (
                    <span
                      key={`${entry.api ?? entry.operation ?? index}`}
                      className={`${styles.ledgerChip} ${
                        entry.status === "live" ? styles.ledgerChipKto : ""
                      }`}
                    >
                      {entry.operation ?? entry.api ?? "—"} ·{" "}
                      {statusLabel(entry.status)}
                    </span>
                  ))}
                </div>
              </div>

              {missions.length > 0 && (
                <div className={styles.card}>
                  <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                    개선 미션 {missions.length}건
                  </h2>
                  <ul className={styles.why}>
                    {missions.slice(0, 6).map((mission, index) => (
                      <li key={mission.missionId ?? mission.id ?? index}>
                        {mission.title ?? mission.summary ?? "미션"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {insight.warnings.map((warning) => (
                <div key={warning} className={styles.noteCard}>
                  {warning}
                </div>
              ))}
            </div>
          </>
        )}

        {step === "error" && (
          <div className={styles.state}>
            <div className={`${styles.stateMark} ${styles.stateBad}`}>!</div>
            <div>
              <h1 className={styles.title} style={{ fontSize: 22 }}>
                지역 데이터를 불러오지 못했어요
              </h1>
              <p className={styles.sub}>{errorText}</p>
            </div>
          </div>
        )}
      </div>

      <div className={styles.foot}>
        {(step === "result" || step === "error") && (
          <button
            type="button"
            className={styles.cta}
            onClick={() => go("region", true)}
          >
            다른 지역 보기
          </button>
        )}
      </div>
    </div>
  );
}
