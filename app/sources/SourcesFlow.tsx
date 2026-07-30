"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../flow/flow.module.css";

/* Data transparency, as a sequence rather than one dense reference page:
   which agency services this product runs on, whether they answered just now,
   and what the service keeps about the reader. The middle screen doubles as
   the OpenAPI usage evidence a reviewer needs to see. */

type Step = "catalog" | "status" | "privacy";
const STEPS: Step[] = ["catalog", "status", "privacy"];

/* The eight services this product is built on, each mapped to the decision it
   actually changes. "Which APIs are called" is not the interesting claim —
   "what breaks without this one" is. */
const CATALOG: {
  service: string;
  official: string;
  listNo: number;
  role: string;
  losesIfRemoved: string;
}[] = [
  {
    service: "KorService2",
    official: "국문 관광정보 서비스",
    listNo: 1,
    role: "공식 관광지 후보·좌표·운영정보",
    losesIfRemoved: "대체 후보 자체가 생기지 않습니다",
  },
  {
    service: "KorWithService2",
    official: "무장애 여행 정보",
    listNo: 10,
    role: "휠체어·유모차·고령자 편의정보 검증",
    losesIfRemoved: "접근성 조건을 검증할 수 없습니다",
  },
  {
    service: "TatsCnctrRateService",
    official: "관광지 집중률 방문자 추이 예측",
    listNo: 18,
    role: "향후 상대 집중률 예측 보정",
    losesIfRemoved: "혼잡 회피 순위 보정이 사라집니다",
  },
  {
    service: "LocgoHubTarService1",
    official: "기초지자체 중심 관광지 정보",
    listNo: 19,
    role: "지역 분석의 앵커 관광지",
    losesIfRemoved: "지역 분석 기준점이 사라집니다",
  },
  {
    service: "TarRlteTarService1",
    official: "관광지별 연관 관광지 정보",
    listNo: 20,
    role: "원래 여행 목적을 보존하는 연결",
    losesIfRemoved: "여행 의도 보존 근거가 사라집니다",
  },
  {
    service: "AreaTarDivService",
    official: "지역별 관광 다양성",
    listNo: 25,
    role: "관광객·소비·국제 다양성",
    losesIfRemoved: "지역 다양성 진단이 사라집니다",
  },
  {
    service: "AreaTarDemDsService",
    official: "지역별 관광 수요 강도",
    listNo: 26,
    role: "체류·소비 수요 강도",
    losesIfRemoved: "투자 우선순위 근거가 사라집니다",
  },
  {
    service: "AreaTarResDemService",
    official: "지역별 관광 자원 수요",
    listNo: 27,
    role: "관광서비스·문화자원 수요",
    losesIfRemoved: "자원 부족 판단이 사라집니다",
  },
];

type SourceRow = {
  apiName: string;
  operation: string;
  status: string;
  latencyMs: number;
  resultCount: number;
  checkedAt: string;
};

type Health = {
  overall?: string;
  sources: SourceRow[];
  checkedAt?: string | null;
  sourceHealth?: { mode?: string; stale?: boolean; sourceCount?: number };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function relativeTime(iso?: string | null): string {
  if (!iso) return "확인 기록 없음";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "확인 기록 없음";
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (minutes < 1) return "방금 전 확인";
  if (minutes < 60) return `${minutes}분 전 확인`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전 확인`;
  return `${Math.round(hours / 24)}일 전 확인`;
}

export default function SourcesFlow() {
  const [step, setStep] = useState<Step>("catalog");
  const [goingBack, setGoingBack] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [deleteState, setDeleteState] = useState("");

  const go = useCallback((next: Step, back = false) => {
    setGoingBack(back);
    setStep(next);
  }, []);

  useEffect(() => {
    if (step !== "status" || health) return;
    fetch("/api/v1/health/ready")
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        const root = asRecord(payload);
        if (!root) throw new Error("상태를 확인하지 못했습니다.");
        setHealth({
          overall: typeof root.overall === "string" ? root.overall : undefined,
          sources: Array.isArray(root.sources)
            ? (root.sources as SourceRow[])
            : [],
          checkedAt:
            typeof root.checkedAt === "string" ? root.checkedAt : undefined,
          sourceHealth: asRecord(root.sourceHealth) as Health["sourceHealth"],
        });
      })
      .catch((error: Error) => setHealthError(error.message));
  }, [step, health]);

  const deleteSession = useCallback(async () => {
    setDeleteState("삭제하는 중…");
    try {
      const response = await fetch("/api/v1/privacy/session", {
        method: "DELETE",
      });
      setDeleteState(
        response.ok
          ? "이 브라우저의 익명 세션 데이터를 삭제했습니다."
          : "삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    } catch {
      setDeleteState("삭제하지 못했습니다. 네트워크를 확인해 주세요.");
    }
  }, []);

  const stepIndex = STEPS.indexOf(step);
  const liveCount = (health?.sources ?? []).filter(
    (source) => source.status === "live",
  ).length;

  return (
    <div className={styles.shell}>
      <div className={styles.top}>
        <button
          type="button"
          className={styles.back}
          onClick={() => go(STEPS[Math.max(0, stepIndex - 1)], true)}
          disabled={stepIndex === 0}
          aria-label="이전으로"
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
        {step === "catalog" && (
          <>
            <span className={styles.eyebrow}>데이터 출처</span>
            <h1 className={styles.title}>
              이어가는 공사 데이터
              <br />
              8종 위에서 작동합니다
            </h1>
            <p className={styles.sub}>
              몇 개를 호출했는지가 아니라, 각 데이터가 어떤 판단을 바꾸는지를
              적었습니다.
            </p>
            <div className={styles.body}>
              {CATALOG.map((entry) => (
                <div key={entry.service} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div>
                      <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                        {entry.official}
                      </h2>
                      <p className={styles.cardAddr}>{entry.service}</p>
                    </div>
                    <span className={styles.badge}>공고 {entry.listNo}번</span>
                  </div>
                  <ul className={styles.why}>
                    <li>{entry.role}</li>
                    <li>없으면: {entry.losesIfRemoved}</li>
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}

        {step === "status" && (
          <>
            <span className={styles.eyebrow}>실시간 상태</span>
            <h1 className={styles.title}>
              방금 응답한 서비스는
              <br />
              {liveCount}종입니다
            </h1>
            <p className={styles.sub}>
              {health
                ? `${relativeTime(health.checkedAt)} · 갱신 방식 ${
                    health.sourceHealth?.mode ?? "—"
                  }`
                : "확인하는 중…"}
            </p>
            <div className={styles.body}>
              {healthError && <p className={styles.sub}>{healthError}</p>}
              {(health?.sources ?? []).map((source) => (
                <div key={source.apiName} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div>
                      <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                        {source.apiName}
                      </h2>
                      <p className={styles.cardAddr}>
                        {source.operation} · {source.resultCount}건 응답
                      </p>
                    </div>
                    <span
                      className={`${styles.badge} ${
                        source.status === "live" ? styles.badgeRestored : ""
                      }`}
                    >
                      {source.status === "live"
                        ? `${source.latencyMs}ms`
                        : source.status}
                    </span>
                  </div>
                </div>
              ))}
              <div className={styles.noteCard}>
                이 값은 저장된 요약이 아니라 예약 점검이 실제로 호출한
                결과입니다. 기록이 오래되면 이 화면을 여는 시점에 다시
                호출합니다.
              </div>
            </div>
          </>
        )}

        {step === "privacy" && (
          <>
            <span className={styles.eyebrow}>개인정보</span>
            <h1 className={styles.title}>
              위치는 계산에만 쓰고
              <br />
              보관하지 않습니다
            </h1>
            <p className={styles.sub}>
              무엇을 남기고 무엇을 남기지 않는지 그대로 적었습니다.
            </p>
            <div className={styles.body}>
              <div className={styles.card}>
                <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                  남기지 않는 것
                </h2>
                <ul className={styles.why}>
                  <li>정확한 현재 위치 좌표</li>
                  <li>실제 이동 경로</li>
                  <li>URL·접근 로그에 남는 좌표</li>
                </ul>
              </div>
              <div className={styles.card}>
                <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                  남기는 것
                </h2>
                <ul className={styles.why}>
                  <li>시도·시군구 단위로 일반화한 복구 결과</li>
                  <li>직접 저장한 일정 장소 (최대 30일)</li>
                  <li>익명 세션 식별자</li>
                </ul>
              </div>
              <div className={styles.noteCard}>
                이용자 요청 기반 정책 지표는 같은 시군구의 비식별 집계가 30건
                이상일 때만 공개합니다. 그 미만은 공개 화면에 반영하지
                않습니다.
              </div>
              {deleteState && <p className={styles.sub}>{deleteState}</p>}
            </div>
          </>
        )}
      </div>

      <div className={styles.foot}>
        {step !== "privacy" ? (
          <button
            type="button"
            className={styles.cta}
            onClick={() => go(STEPS[stepIndex + 1])}
          >
            {step === "catalog" ? "지금 응답하는지 확인" : "내 데이터는 어떻게 되나요"}
          </button>
        ) : (
          <button type="button" className={styles.cta} onClick={deleteSession}>
            내 세션 데이터 삭제
          </button>
        )}
      </div>
    </div>
  );
}
