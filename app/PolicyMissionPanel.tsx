"use client";

import { useEffect, useMemo, useState } from "react";
import { statusLabel as codeLabel } from "@/lib/text/status-labels";
import styles from "./PolicyMissionPanel.module.css";

type LoadState = "idle" | "loading" | "success" | "error";

type Region = {
  code: string;
  name: string;
};

type District = {
  code: string;
  name: string;
};

type MissionStatus =
  | "open"
  | "in_progress"
  | "ready_for_recheck"
  | "resolved"
  | "dismissed";

type FailureCategory =
  | "content_gap"
  | "data_gap"
  | "operating_hours_gap"
  | "mobility_gap";

type PolicyMission = {
  id: string;
  regionCode: string;
  districtCode?: string;
  missionType:
    | "policy_evidence_gap"
    | "hub_evidence_gap"
    | "recovery_scenario_gap"
    | "continuity_outcome_gap"
    | "mobility_recovery_gap";
  status: MissionStatus;
  priority: number;
  title: string;
  summary: string;
  actionText: string;
  failureCategory: FailureCategory;
  actionContract: {
    ownerOrganization: string;
    ownerRole: string;
    deadlineAt: string;
    successCondition: string;
    evidenceRequirement: string;
  };
  scenario: { id: string };
  actionEvidence?: {
    actionSummary: string;
    evidenceCount: number;
    occurredAt: string;
  };
  actionRecordedAt?: string;
  lastRevalidatedAt?: string;
  lastRevalidationResult?:
    | "improved"
    | "unchanged"
    | "regressed"
    | "not_comparable";
  revalidationCount: number;
  evidence: Record<string, unknown>;
  baselineValue: number | null;
  currentValue: number | null;
  sampleSize: number;
  minimumSampleSize: number;
  privacyState: "official_only" | "threshold_met";
  policyBaseMonth?: string;
  firstDetectedAt: string;
  lastEvaluatedAt: string;
  resolvedAt?: string;
  interventions: Array<{
    id: string;
    title: string;
    description: string;
    effortPoints: number;
    estimatedDays: number;
    uncertainty: "low" | "medium" | "high";
    closes: string[];
    objectiveScore: number;
  }>;
  recommendedPlan: {
    interventionId: string;
    title: string;
    rationale: string;
  };
  revalidation: {
    baselineValue: number | null;
    currentValue: number | null;
    delta: number | null;
    result:
      | "improved"
      | "unchanged"
      | "regressed"
      | "not_comparable";
  };
};

const LOOP_STAGES = [
  "공백 발견",
  "담당 지정",
  "개선 실행",
  "동일 조건 재검증",
  "종료",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readText(
  record: Record<string, unknown> | null,
  keys: string[],
): string {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickRows(payload: unknown, keys: string[]): unknown[] {
  const record = asRecord(payload);
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = asRecord(asRecord(payload)?.error);
    throw new Error(
      readText(error, ["message"]) ||
        `요청을 완료하지 못했습니다. (${response.status})`,
    );
  }
  return payload;
}

function statusLabel(status: MissionStatus): string {
  if (status === "open") return "공백 발견";
  if (status === "in_progress") return "개선 실행 중";
  if (status === "ready_for_recheck") return "재검증 대기";
  if (status === "resolved") return "개선 확인";
  return "운영 제외";
}

function statusProgress(status: MissionStatus): number {
  if (status === "open") return 1;
  if (status === "in_progress") return 2;
  if (status === "ready_for_recheck") return 3;
  return 4;
}

function failureCategoryLabel(category: FailureCategory): string {
  if (category === "content_gap") return "대체 콘텐츠 공백";
  if (category === "data_gap") return "공식 데이터 공백";
  if (category === "operating_hours_gap") {
    return "운영시간·휴무정보 공백";
  }
  return "이동·접근성 공백";
}

function formatDateTime(value?: string): string {
  if (!value) return "아직 실행되지 않음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function revalidationResultLabel(
  result?: PolicyMission["lastRevalidationResult"],
): string {
  if (result === "improved") return "개선";
  if (result === "regressed") return "악화";
  if (result === "unchanged") return "변화 없음";
  if (result === "not_comparable") return "표본 부족으로 비교 보류";
  return "";
}

function missionKindLabel(type: PolicyMission["missionType"]): string {
  if (type === "policy_evidence_gap") return "정책 근거";
  if (type === "hub_evidence_gap") return "대체 거점";
  if (type === "recovery_scenario_gap") return "복구 가능성";
  if (type === "continuity_outcome_gap") return "실제 여행 지속";
  return "이동·접근성";
}

function metricMeta(type: PolicyMission["missionType"]): {
  label: string;
  unit: string;
  direction: string;
} {
  if (type === "policy_evidence_gap") {
    return {
      label: "공식 근거 충족률",
      unit: "%",
      direction: "높을수록 공식 근거가 완전합니다.",
    };
  }
  if (type === "hub_evidence_gap") {
    return {
      label: "확인된 중심 관광지",
      unit: "개",
      direction: "공식 중심 관광지 응답 수입니다.",
    };
  }
  if (type === "continuity_outcome_gap") {
    return {
      label: "실제 여행 중단 비율",
      unit: "%",
      direction:
        "후보 수가 아니라 사용자가 기록한 도착·여행 지속·중단 결과이며, 낮을수록 좋습니다.",
    };
  }
  return {
    label: "유효 대안 없음 비율",
    unit: "%",
    direction: "낮을수록 같은 조건에서 복구 가능성이 높습니다.",
  };
}

function formatValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "기준 없음";
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`;
}

function formatMonth(value?: string): string {
  if (!value) return "기준월 미제공";
  if (/^\d{6}$/.test(value)) {
    return `${value.slice(0, 4)}년 ${value.slice(4, 6)}월`;
  }
  return value;
}

function normalizeRegions(payload: unknown): Region[] {
  return pickRows(payload, ["regions", "areas"]).flatMap((entry) => {
    const row = asRecord(entry);
    const code = readText(row, ["code", "areaCode"]);
    const name = readText(row, ["name", "areaName"]);
    return code && name ? [{ code, name }] : [];
  });
}

function normalizeDistricts(payload: unknown): District[] {
  return pickRows(payload, ["districts", "areas"]).flatMap((entry) => {
    const row = asRecord(entry);
    const code = readText(row, ["code", "sigunguCode"]);
    const name = readText(row, ["name", "sigunguName"]);
    return code && name ? [{ code, name }] : [];
  });
}

function normalizeMissions(payload: unknown): PolicyMission[] {
  return pickRows(payload, ["missions"]).filter(
    (entry): entry is PolicyMission =>
      Boolean(
        entry &&
          typeof entry === "object" &&
          typeof (entry as PolicyMission).id === "string",
      ),
  );
}

/** 미션이 속한 시도 이름. 시도를 직접 선택한 화면에서는 중복이라 생략한다. */
function missionRegionLabel(
  mission: { regionCode: string },
  regions: Region[],
): string {
  const match = regions.find((region) => region.code === mission.regionCode);
  return match?.name ?? "";
}

export function PolicyMissionPanel({
  className = "",
}: {
  className?: string;
}) {
  const [regions, setRegions] = useState<Region[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [areaCode, setAreaCode] = useState("");
  const [districtCode, setDistrictCode] = useState("");
  const [missions, setMissions] = useState<PolicyMission[]>([]);
  const [regionState, setRegionState] =
    useState<LoadState>("loading");
  const [districtState, setDistrictState] =
    useState<LoadState>("idle");
  const [missionState, setMissionState] =
    useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [revalidatingId, setRevalidatingId] = useState("");

  useEffect(() => {
    let active = true;
    fetchJson("/api/v1/insights/regions")
      .then((payload) => {
        if (!active) return;
        setRegions(normalizeRegions(payload));
        setRegionState("success");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRegionState("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "공식 지역 목록을 불러오지 못했습니다.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!areaCode) return;
    let active = true;
    fetchJson(
      `/api/v1/regions/${encodeURIComponent(areaCode)}/districts`,
    )
      .then((payload) => {
        if (!active) return;
        setDistricts(normalizeDistricts(payload));
        setDistrictState("success");
      })
      .catch(() => {
        if (!active) return;
        setDistricts([]);
        setDistrictState("error");
      });
    return () => {
      active = false;
    };
  }, [areaCode]);

  async function loadMissions(
    nextAreaCode = areaCode,
    nextDistrictCode = districtCode,
  ) {
    setMissionState("loading");
    setMessage("");
    const query = new URLSearchParams({ includeResolved: "1" });
    if (nextAreaCode) query.set("areaCode", nextAreaCode);
    if (nextDistrictCode) query.set("sigunguCode", nextDistrictCode);
    try {
      const payload = await fetchJson(
        `/api/v1/insights/missions?${query.toString()}`,
      );
      setMissions(normalizeMissions(payload));
      setMissionState("success");
    } catch (error) {
      setMissions([]);
      setMissionState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "회복력 미션을 불러오지 못했습니다.",
      );
    }
  }

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ includeResolved: "1" });
    if (areaCode) query.set("areaCode", areaCode);
    if (districtCode) query.set("sigunguCode", districtCode);
    fetchJson(`/api/v1/insights/missions?${query.toString()}`)
      .then((payload) => {
        if (!active) return;
        setMissions(normalizeMissions(payload));
        setMissionState("success");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMissions([]);
        setMissionState("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "회복력 미션을 불러오지 못했습니다.",
        );
      });
    return () => {
      active = false;
    };
  }, [areaCode, districtCode]);

  const selectedRegionName = useMemo(
    () =>
      regions.find((region) => region.code === areaCode)?.name ??
      "전국",
    [areaCode, regions],
  );
  const selectedDistrictName = useMemo(
    () =>
      districts.find((district) => district.code === districtCode)
        ?.name ?? "",
    [districtCode, districts],
  );
  const activeMissions = missions.filter(
    (mission) =>
      mission.status === "open" ||
      mission.status === "in_progress" ||
      mission.status === "ready_for_recheck",
  );
  const closedMissions = missions.filter(
    (mission) => mission.status === "resolved",
  );

  async function refreshMissionResult(mission: PolicyMission) {
    setRevalidatingId(mission.id);
    setMessage("");
    try {
      await loadMissions(areaCode, districtCode);
      setMessage(
        "인증된 운영자가 조치 증빙을 등록하고 저장된 동일 시나리오를 재실행한 최신 공개 기록을 불러왔습니다.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "미션을 재검증하지 못했습니다.",
      );
    } finally {
      setRevalidatingId("");
    }
  }

  return (
    <section
      className={`${styles.panel} ${className}`.trim()}
      aria-labelledby="policy-mission-title"
      data-testid="policy-mission-panel"
    >
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>RESILIENCE MISSION LOOP</p>
          <h2 id="policy-mission-title">
            숫자를 보는 데서 끝내지 않고, 빈틈을 고칩니다.
          </h2>
          <p className={styles.lead}>
            공식 데이터 공백을 개선 과제로 만들고 같은 지역·조건을
            다시 실행해 해결 여부를 확인합니다.
          </p>
        </div>
        <div className={styles.privacy}>
          <strong>행동 집계 공개 기준</strong>
          <span>분석 동의 · 시군구 일반화 · 익명 세션 30개 이상</span>
        </div>
      </header>

      <ol className={styles.loop} aria-label="회복력 미션 운영 단계">
        {LOOP_STAGES.map((stage, index) => (
          <li key={stage}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{stage}</strong>
          </li>
        ))}
      </ol>

      <div className={styles.filters}>
        <label>
          <span>시도</span>
          <select
            value={areaCode}
            onChange={(event) => {
              const nextAreaCode = event.target.value;
              setDistricts([]);
              setDistrictCode("");
              setDistrictState(nextAreaCode ? "loading" : "idle");
              setMissionState("loading");
              setMessage("");
              setAreaCode(nextAreaCode);
            }}
            disabled={regionState === "loading"}
          >
            <option value="">전국 공개 미션</option>
            {regions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>시군구</span>
          <select
            value={districtCode}
            onChange={(event) => {
              setMissionState("loading");
              setMessage("");
              setDistrictCode(event.target.value);
            }}
            disabled={!areaCode || districtState === "loading"}
          >
            <option value="">
              {districtState === "loading"
                ? "불러오는 중…"
                : "시도 전체"}
            </option>
            {districts.map((district) => (
              <option key={district.code} value={district.code}>
                {district.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void loadMissions()}
          disabled={missionState === "loading"}
        >
          {missionState === "loading" ? "확인 중…" : "미션 새로고침"}
        </button>
      </div>

      <div className={styles.summary} aria-live="polite">
        <div>
          <span>현재 범위</span>
          <strong>
            {selectedRegionName}
            {selectedDistrictName ? ` ${selectedDistrictName}` : ""}
          </strong>
        </div>
        <div>
          <span>실행 중 미션</span>
          <strong>{activeMissions.length}개</strong>
        </div>
        <div>
          <span>개선 확인</span>
          <strong>{closedMissions.length}개</strong>
        </div>
      </div>

      {message && (
        <p
          className={
            missionState === "error"
              ? styles.errorMessage
              : styles.message
          }
          role={missionState === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      )}

      {missionState === "loading" && (
        <div className={styles.empty} role="status">
          공개 가능한 회복력 미션을 확인하고 있습니다.
        </div>
      )}
      {missionState === "success" && missions.length === 0 && (
        <div className={styles.empty}>
          <strong>현재 공개된 개선 미션이 없습니다.</strong>
          <p>
            공식 데이터 공백이 감지되거나 30건 이상 비식별 집계에서
            반복 복구 공백이 확인되면 이곳에 생성됩니다.
          </p>
        </div>
      )}

      {missions.length > 0 && (
        <div className={styles.cards}>
          {missions.map((mission) => {
            const metric = metricMeta(mission.missionType);
            const progress = statusProgress(mission.status);
            return (
              <article className={styles.card} key={mission.id}>
                <div className={styles.cardTop}>
                  <div>
                    <span className={styles.kind}>
                      {missionKindLabel(mission.missionType)}
                    </span>
                    {/* 전국 목록에서는 같은 제목의 카드가 시도마다 하나씩
                        생긴다. 지역 이름이 없으면 100장이 전부 같은 카드로
                        보인다. */}
                    <h3>
                      {missionRegionLabel(mission, regions)
                        ? `${missionRegionLabel(mission, regions)} · ${mission.title}`
                        : mission.title}
                    </h3>
                  </div>
                  <span
                    className={`${styles.status} ${styles[mission.status]}`}
                  >
                    {statusLabel(mission.status)}
                  </span>
                </div>

                <p className={styles.description}>{mission.summary}</p>

                <div className={styles.contract}>
                  <div className={styles.contractHeading}>
                    <div>
                      <span>중단 원인 분류</span>
                      <strong>
                        {failureCategoryLabel(
                          mission.failureCategory,
                        )}
                      </strong>
                    </div>
                    <small>
                      {mission.revalidationCount > 0
                        ? `같은 조건으로 ${mission.revalidationCount}회 다시 확인함`
                        : "아직 같은 조건으로 다시 확인하지 않음"}
                    </small>
                  </div>
                  <div className={styles.contractFacts}>
                    <dl>
                      <dt>제안 대상</dt>
                      <dd>
                        {mission.actionContract.ownerOrganization}
                        <small>{mission.actionContract.ownerRole}</small>
                      </dd>
                    </dl>
                    <dl>
                      <dt>권고 완료 시점</dt>
                      <dd>
                        {formatDateTime(
                          mission.actionContract.deadlineAt,
                        )}
                      </dd>
                    </dl>
                    <dl>
                      <dt>해결 판정 기준</dt>
                      <dd>
                        {mission.actionContract.successCondition}
                      </dd>
                    </dl>
                    <dl>
                      <dt>필요한 증빙</dt>
                      <dd>
                        {mission.actionContract.evidenceRequirement}
                      </dd>
                    </dl>
                  </div>
                  {mission.actionEvidence && (
                    <details>
                      <summary>등록된 조치·증빙 확인</summary>
                      <p>{mission.actionEvidence.actionSummary}</p>
                      <small>
                        비공개 증빙 {mission.actionEvidence.evidenceCount}건을
                        운영자 검토함 ·{" "}
                        {formatDateTime(
                          mission.actionEvidence.occurredAt,
                        )}
                      </small>
                    </details>
                  )}
                  <p className={styles.revalidationRecord}>
                    마지막 동일 조건 재검증:{" "}
                    <strong>
                      {formatDateTime(mission.lastRevalidatedAt)}
                    </strong>
                    {mission.lastRevalidationResult
                      ? ` · ${revalidationResultLabel(
                          mission.lastRevalidationResult,
                        )}`
                      : ""}
                  </p>
                </div>

                <ol
                  className={styles.cardLoop}
                  aria-label={`${mission.title} 진행 상태`}
                >
                  {LOOP_STAGES.map((stage, index) => (
                    <li
                      key={stage}
                      className={
                        index < progress
                          ? styles.completed
                          : index === progress
                            ? styles.current
                            : ""
                      }
                    >
                      <span aria-hidden="true" />
                      <small>{stage}</small>
                    </li>
                  ))}
                </ol>

                <div className={styles.comparison}>
                  <div>
                    <span>최초 감지</span>
                    <strong>
                      {formatValue(
                        mission.baselineValue,
                        metric.unit,
                      )}
                    </strong>
                  </div>
                  <span aria-hidden="true">→</span>
                  <div>
                    <span>최근 재검증</span>
                    <strong>
                      {formatValue(
                        mission.currentValue,
                        metric.unit,
                      )}
                    </strong>
                  </div>
                </div>
                <p className={styles.metricNote}>
                  <strong>{metric.label}</strong> · {metric.direction}
                </p>

                <div className={styles.action}>
                  <span>다음 실행</span>
                  <p>{mission.actionText}</p>
                </div>

                <div className={styles.recommended}>
                  <span>최소개입 권고안</span>
                  <h4>{mission.recommendedPlan.title}</h4>
                  <p>{mission.recommendedPlan.rationale}</p>
                  <details>
                    <summary>
                      검토한 개입안 {mission.interventions.length}개
                    </summary>
                    <ul>
                      {mission.interventions.map((intervention) => (
                        <li key={intervention.id}>
                          <strong>{intervention.title}</strong>
                          <span>
                            {intervention.estimatedDays}일 예상 · 난이도{" "}
                            {codeLabel(intervention.uncertainty)} · 공백{" "}
                            {intervention.closes.length}건 해소
                          </span>
                          <p>{intervention.description}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>

                <footer className={styles.cardFooter}>
                  <div>
                    <span>{formatMonth(mission.policyBaseMonth)}</span>
                    <span>
                      {mission.privacyState === "official_only"
                        ? "공식 OpenAPI 근거"
                        : `동의 기반 익명 세션 ${mission.sampleSize}개`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshMissionResult(mission)}
                    disabled={
                      revalidatingId === mission.id ||
                      mission.status === "dismissed"
                    }
                  >
                    {revalidatingId === mission.id
                      ? "공개 기록 확인 중…"
                      : "공개 검증 기록 새로고침"}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
