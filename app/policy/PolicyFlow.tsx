"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  aliasHint,
  regionMatchesQuery,
  regionNameNote,
} from "@/lib/text/region-alias";
import styles from "../flow/flow.module.css";
import policyStyles from "./policy.module.css";

/* The policy view used to be a single scrolling report: every region, metric,
   coverage figure and mission stacked on one page. Here it is a sequence —
   pick a region, watch the official indicators load, then read the result —
   so a reader follows one question at a time. */

type Step = "region" | "district" | "loading" | "result" | "error";

type Region = { code: string; name: string };
type District = { code: string; name: string };

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
  /* 시군구를 골랐지만 시도 자료로 내려온 경우의 안내. 숫자를 시군구 값처럼
     읽게 두지 않기 위해 화면에 그대로 띄운다. */
  scopeNotice?: string;
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

function metricGuide(metric: Metric): {
  category: string;
  explanation: string;
} {
  const key = `${metric.key} ${metric.label} ${metric.officialName ?? ""} ${
    metric.source
  }`.toLowerCase();
  if (key.includes("div") || key.includes("다양")) {
    return {
      category: "관광 구성의 다양성",
      explanation:
        "관광객·소비·국제성 등 여러 구성 요소를 종합한 공식 지수입니다. 단일 값만으로 우열을 판단하지 않고 같은 기준월의 다른 지역과 함께 비교해야 합니다.",
    };
  }
  if (key.includes("dem") || key.includes("수요")) {
    return {
      category: "관광 수요 신호",
      explanation:
        "체류·소비 또는 관광자원 수요를 나타내는 공식 지수입니다. 값의 크기는 백분율이 아니며 기준월과 지표 정의를 함께 확인해야 합니다.",
    };
  }
  if (key.includes("hub") || key.includes("중심")) {
    return {
      category: "관광 거점 근거",
      explanation:
        "지역 내 중심 관광지 응답을 바탕으로 한 근거입니다. 값이 없으면 관광지가 없다는 뜻이 아니라 현재 공식 응답에서 확인하지 못했다는 뜻입니다.",
    };
  }
  return {
    category: "공식 관광 지표",
    explanation:
      "한국관광공사 원 지표를 그대로 표시합니다. 이 화면은 임의 점수로 재가공하지 않으며, 값의 의미는 기준월·출처·커버리지와 함께 읽어야 합니다.",
  };
}

function formatCheckedAt(value?: string): string {
  if (!value) return "조회 시각 미확인";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  /* 화면 안에서 날짜 표기를 하나로 맞춘다. `2026. 8. 3.`과
     `2026년 6월 기준`이 같은 카드에 섞여 있었다. */
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function missionStatusLabel(status?: string): string {
  switch (status) {
    case "open":
      return "공백 발견";
    case "in_progress":
      return "개선 진행";
    case "ready_for_recheck":
      return "재검증 대기";
    case "resolved":
      return "개선 확인";
    default:
      return "상태 확인 필요";
  }
}

export default function PolicyFlow() {
  const [step, setStep] = useState<Step>("region");
  const [goingBack, setGoingBack] = useState(false);

  const [regions, setRegions] = useState<Region[]>([]);
  const [regionsError, setRegionsError] = useState("");
  const [regionQuery, setRegionQuery] = useState("");
  const [selected, setSelected] = useState<Region | null>(null);
  /* 시군구를 고르지 않으면 기초지자체 중심 관광지를 조회할 수 없다. 예전에는
     그 사실만 안내하고 고를 방법이 없어 막다른 길이었다. */
  const [districts, setDistricts] = useState<District[]>([]);
  const [districtsError, setDistrictsError] = useState("");
  const [selectedDistrict, setSelectedDistrict] = useState<District | null>(
    null,
  );

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

  const openRegion = useCallback(
    async (region: Region) => {
      setSelected(region);
      setSelectedDistrict(null);
      setDistricts([]);
      setDistrictsError("");
      go("district");
      try {
        const payload = await getJson(
          `/api/v1/regions/${region.code}/districts`,
        );
        const rows = asRecord(payload)?.districts;
        setDistricts(Array.isArray(rows) ? (rows as District[]) : []);
      } catch (error) {
        setDistrictsError((error as Error).message);
      }
    },
    [go],
  );

  const loadRegion = useCallback(
    async (region: Region, district?: District | null) => {
      setSelected(region);
      setSelectedDistrict(district ?? null);
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
          getJson(
            `/api/v1/insights/regions/${region.code}${
              district ? `?sigunguCode=${district.code}` : ""
            }`,
          ),
          getJson(
            `/api/v1/insights/missions?areaCode=${region.code}${
              district ? `&sigunguCode=${district.code}` : ""
            }`,
          ).catch(() => null),
        ]);
        const root = asRecord(insightPayload);
        if (!root) throw new Error("지역 응답을 해석하지 못했습니다.");
        setInsight({
          regionName: String(root.regionName ?? region.name),
          /* 이미 저장된 지역 자료에는 시군구 이름이 `_`로 들어 있는 것이
             있어 제목이 `대전광역시 _`로 찍혔다. 실제 이름만 통과시킨다. */
          districtName:
            typeof root.districtName === "string" &&
            /[가-힣A-Za-z0-9]/.test(root.districtName)
              ? root.districtName
              : undefined,
          scopeNotice:
            typeof root.scopeNotice === "string" ? root.scopeNotice : undefined,
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
    if (step === "district") {
      go("region", true);
      return;
    }
    if (step !== "region") go(selected ? "district" : "region", true);
  }, [step, go, selected]);

  const visibleRegions = regions.filter((region) =>
    regionMatchesQuery(region.name, regionQuery),
  );
  const activeAliasHint = regionQuery.trim()
    ? visibleRegions
        .map((region) => aliasHint(region.name, regionQuery))
        .find(Boolean)
    : undefined;

  const STEPS: Step[] = ["region", "district", "loading", "result"];
  const stepIndex = Math.max(0, STEPS.indexOf(step));

  return (
    <div className={`${styles.shell} ${policyStyles.policyShell}`}>
      <div className={styles.top}>
        {step === "region" ? (
          <Link className={styles.back} href="/" aria-label="이어가 홈으로">
            ←
          </Link>
        ) : (
          <button
            type="button"
            className={styles.back}
            onClick={back}
            disabled={step === "loading"}
            aria-label="지역 선택으로"
          >
            ←
          </button>
        )}
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
              어느 지역을
              <br />
              살펴볼까요?
            </h1>
            <p className={styles.sub}>
              한국관광공사 공식 정책 지표를 검증해 저장한 최신 지역 자료를
              읽습니다. 기준월과 생성 시각을 함께 보여 드립니다.
            </p>
            <div className={styles.body}>
              <label className={styles.field}>
                <span className={styles.label}>지역 검색</span>
                <input
                  className={styles.input}
                  type="search"
                  value={regionQuery}
                  onChange={(event) => setRegionQuery(event.target.value)}
                  placeholder="예: 대전, 광주, 강원"
                  autoComplete="off"
                />
              </label>
              {/* 행정 통합으로 이름이 바뀐 지역은 사용자가 옛 이름으로 찾는다.
                  옛 이름으로도 걸리게 하고, 왜 이 이름이 나오는지 알려 준다. */}
              {activeAliasHint && (
                <p className={styles.fieldNote}>{activeAliasHint}</p>
              )}
              {regionsError && <p className={styles.sub}>{regionsError}</p>}
              {!regions.length && !regionsError && (
                <p className={styles.sub}>공식 지역코드를 불러오는 중…</p>
              )}
              {regions.length > 0 && !visibleRegions.length && (
                <p className={styles.sub}>
                  검색어와 맞는 시도가 없습니다. 시·도 이름으로 다시 입력해
                  주세요.
                </p>
              )}
              {visibleRegions.map((region) => {
                const note = regionNameNote(region.name);
                return (
                  <button
                    key={region.code}
                    type="button"
                    className={styles.choice}
                    style={{ minHeight: 60 }}
                    onClick={() => void openRegion(region)}
                  >
                    <span className={styles.choiceText}>
                      <span className={styles.choiceTitle}>{region.name}</span>
                      {note && (
                        <span className={styles.choiceSub}>{note}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === "district" && selected && (
          <>
            <span className={styles.eyebrow}>{selected.name}</span>
            <h1 className={styles.title}>
              시군구까지
              <br />
              좁혀 볼까요?
            </h1>
            <p className={styles.sub}>
              시군구를 고르면 그 지역의 중심 관광지와 기초지자체 지표까지 함께
              확인할 수 있습니다. 시도 전체로 먼저 봐도 됩니다.
            </p>
            <div className={styles.body}>
              <button
                type="button"
                className={styles.choice}
                style={{ minHeight: 60 }}
                onClick={() => void loadRegion(selected, null)}
              >
                <span className={styles.choiceText}>
                  <span className={styles.choiceTitle}>
                    {selected.name} 전체로 보기
                  </span>
                  <span className={styles.choiceSub}>
                    시도 단위 공식 지표만 사용합니다.
                  </span>
                </span>
              </button>
              {districtsError && (
                <p className={styles.sub}>{districtsError}</p>
              )}
              {!districts.length && !districtsError && (
                <p className={styles.sub}>공식 시군구 목록을 불러오는 중…</p>
              )}
              {districts.map((district) => (
                <button
                  key={district.code}
                  type="button"
                  className={styles.choice}
                  style={{ minHeight: 56 }}
                  onClick={() => void loadRegion(selected, district)}
                >
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>{district.name}</span>
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
                검증된 지역 자료를 불러오고 있어요
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
                ? `${insight.baseYm.slice(0, 4)}년 ${Number(insight.baseYm.slice(4))}월 기준`
                : "최신 가용 기준월"}
            </span>
            <h1 className={styles.title}>
              {insight.districtName
                ? `${insight.regionName} ${insight.districtName}`
                : selectedDistrict && !insight.scopeNotice
                  ? `${insight.regionName} ${selectedDistrict.name}`
                  : insight.regionName}
            </h1>
            {insight.scopeNotice && (
              <p className={styles.fieldError} role="status">
                {insight.scopeNotice}
              </p>
            )}
            <p className={styles.sub}>{insight.coverage?.meaning}</p>

            <div className={styles.body}>
              <div className={`${styles.card} ${policyStyles.coverageCard}`}>
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
                <div className={policyStyles.coverageTrack} aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(100, insight.coverage?.percent ?? 0),
                      )}%`,
                    }}
                  />
                </div>
                <p className={policyStyles.readingGuide}>
                  커버리지는 공식 세부지표가 응답한 비율입니다. 100%는
                  “지역이 우수하다”가 아니라 이 화면의 판단 근거가 모두
                  도착했다는 뜻입니다.
                </p>
                <div className={policyStyles.summaryFacts}>
                  <dl>
                    <dt>기준월</dt>
                    <dd>
                      {insight.baseYm
                        ? `${insight.baseYm.slice(0, 4)}년 ${Number(insight.baseYm.slice(4))}월`
                        : "최신 가용 기준월"}
                    </dd>
                  </dl>
                  <dl>
                    <dt>자료 생성 시각</dt>
                    <dd>{formatCheckedAt(insight.generatedAt)}</dd>
                  </dl>
                  <dl>
                    <dt>판독 원칙</dt>
                    <dd>원값 그대로 표시 (순위 환산 없음)</dd>
                  </dl>
                </div>
              </div>

              {/* 같은 설명이 지표 카드마다 반복되면 화면 대부분이 같은
                  문장으로 채워진다. 묶음이 바뀔 때만 한 번 보여 준다. */}
              {insight.metrics.map((metric, metricIndex) => {
                const guide = metricGuide(metric);
                const previous =
                  metricIndex > 0
                    ? metricGuide(insight.metrics[metricIndex - 1])
                    : undefined;
                const repeatsExplanation =
                  previous?.explanation === guide.explanation;
                return (
                  <div
                    key={`${metric.source}-${metric.key}`}
                    className={`${styles.card} ${policyStyles.metricCard}`}
                  >
                    <div className={styles.cardTop}>
                      <div>
                        <span className={policyStyles.metricCategory}>
                          {guide.category}
                        </span>
                        <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                          {metric.officialName || metric.label}
                        </h2>
                        <p className={styles.cardAddr}>
                          {metric.source} · {metric.operation}
                        </p>
                      </div>
                      <span className={`${styles.badge} ${policyStyles.metricValue}`}>
                        {formatValue(metric.value)}
                      </span>
                    </div>
                    {!repeatsExplanation && (
                      <p className={policyStyles.metricExplanation}>
                        {guide.explanation}
                      </p>
                    )}
                  </div>
                );
              })}

              <div className={`${styles.card} ${policyStyles.sourceCard}`}>
                <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                  이 지역 자료를 만든 한국관광공사 OpenAPI
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
                <a className={policyStyles.sourceLink} href="/sources">
                  데이터 출처와 판단 역할 전체 보기
                </a>
              </div>

              {missions.length > 0 && (
                <div className={`${styles.card} ${policyStyles.missionCard}`}>
                  <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                    개선 미션 {missions.length}건
                  </h2>
                  <ul className={policyStyles.missionList}>
                    {missions.slice(0, 6).map((mission, index) => (
                      <li key={mission.missionId ?? mission.id ?? index}>
                        <span>{missionStatusLabel(mission.status)}</span>
                        <strong>
                          {mission.title ?? mission.summary ?? "개선 미션"}
                        </strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {missions.length === 0 && (
                <div className={`${styles.card} ${policyStyles.emptyMission}`}>
                  <span aria-hidden="true">0</span>
                  <div>
                    <h2 className={styles.cardTitle} style={{ fontSize: 16 }}>
                      현재 공개된 개선 미션이 없습니다
                    </h2>
                    <p>
                      “개선할 문제가 없다”는 뜻이 아닙니다. 공식 데이터 공백이
                      감지되거나, 동의된 비식별 여행 복구 기록이 공개 최소
                      표본을 충족한 뒤에만 미션이 생성됩니다.
                    </p>
                  </div>
                </div>
              )}

              {insight.warnings.map((warning) => (
                <div
                  key={warning}
                  className={`${styles.noteCard} ${policyStyles.warningCard}`}
                  role="status"
                >
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
