import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
} from "drizzle-orm";
import { getDb } from "@/db";
import {
  recoveryRuns,
  recoveryOutcomes,
  resilienceMissionEvents,
  resilienceMissions,
} from "@/db/schema";
import type { PolicyInsightPayload } from "@/lib/insights/service";

export const MISSION_CALCULATION_VERSION =
  "resilience-mission-2026.07-v1";
export const MINIMUM_BEHAVIOR_SAMPLE = 30;

export const FAILURE_CATEGORIES = [
  "content_gap",
  "data_gap",
  "operating_hours_gap",
  "mobility_gap",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export type RecoveryAggregate = {
  eligibleCount: number;
  noCandidateCount: number;
  upstreamUnavailableCount: number;
  totalOptionCount: number;
  totalRejectedCount: number;
  mobilityEligibleCount: number;
  mobilityNoCandidateCount: number;
  incidents: Record<string, number>;
  audiences: Record<string, number>;
  outcomeRunCount: number;
  arrivedCount: number;
  verifiedArrivedCount: number;
  selfReportedArrivedCount: number;
  continuedCount: number;
  abandonedCount: number;
  arrivedOnTimeCount: number;
  arrivedWithTimingCount: number;
  mobilityOutcomeCount: number;
  mobilityAbandonedCount: number;
};

export type MissionIntervention = {
  id: string;
  title: string;
  description: string;
  effortPoints: number;
  estimatedDays: number;
  uncertainty: "low" | "medium" | "high";
  closes: string[];
  objectiveScore: number;
};

export type RecommendedMissionPlan = {
  interventionId: string;
  title: string;
  rationale: string;
  objective: {
    minimize: [
      "estimated_effort",
      "estimated_time",
      "uncertainty",
    ];
    maximize: "evidence_or_recovery_gaps_closed";
    score: number;
  };
};

export type MissionScenario = {
  id: string;
  scope: {
    areaCode: string;
    districtCode: string;
  };
  missionType: MissionCandidate["missionType"];
  parameters: {
    failureCategory: FailureCategory;
  };
  calculationVersion: string;
  evaluator: {
    metric:
      | "official_evidence_coverage"
      | "confirmed_hub_count"
      | "no_candidate_rate"
      | "travel_abandonment_rate"
      | "mobility_no_candidate_rate";
    betterWhen: "higher" | "lower";
    activationRule: string;
    observationWindow: "official_base_month" | "rolling_30_days";
  };
};

export type MissionActionContract = {
  ownerOrganization: string;
  ownerRole: string;
  deadlineAt: string;
  successCondition: string;
  evidenceRequirement: string;
};

export type MissionActionEvidence = {
  actionSummary: string;
  artifactReferences: string[];
  occurredAt: string;
  recordedBy: string;
};

export type PublicMissionActionEvidence = {
  actionSummary: string;
  evidenceCount: number;
  occurredAt: string;
};

export type MissionCandidate = {
  id: string;
  regionCode: string;
  districtCode: string;
  missionType:
    | "policy_evidence_gap"
    | "hub_evidence_gap"
    | "recovery_scenario_gap"
    | "continuity_outcome_gap"
    | "mobility_recovery_gap";
  active: boolean;
  inactiveStatus: "resolved" | "suppressed";
  priority: number;
  title: string;
  summary: string;
  actionText: string;
  failureCategory: FailureCategory;
  actionContract: MissionActionContract;
  scenario: MissionScenario;
  evidence: Record<string, unknown>;
  currentValue: number | null;
  sampleSize: number;
  privacyState: "official_only" | "threshold_met" | "below_threshold";
  policyBaseMonth: string;
  interventions: MissionIntervention[];
  recommendedPlan: RecommendedMissionPlan;
};

type MissionCandidateSeed = Omit<
  MissionCandidate,
  | "failureCategory"
  | "actionContract"
  | "scenario"
  | "interventions"
  | "recommendedPlan"
>;

export type PublicMission = {
  id: string;
  regionCode: string;
  districtCode?: string;
  missionType: MissionCandidate["missionType"];
  status:
    | "open"
    | "in_progress"
    | "ready_for_recheck"
    | "resolved"
    | "dismissed";
  priority: number;
  title: string;
  summary: string;
  actionText: string;
  failureCategory: FailureCategory;
  actionContract: MissionActionContract;
  scenario: MissionScenario;
  actionEvidence?: PublicMissionActionEvidence;
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
  calculationVersion: string;
  firstDetectedAt: string;
  lastEvaluatedAt: string;
  resolvedAt?: string;
  interventions: MissionIntervention[];
  recommendedPlan: RecommendedMissionPlan;
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

export type MissionScenarioRevalidation = {
  mission: PublicMission;
  receipt: {
    scenarioId: string;
    sameScenario: true;
    previousStatus: string;
    nextStatus: PublicMission["status"];
    baselineValue: number | null;
    evaluatedValue: number | null;
    result: PublicMission["revalidation"]["result"];
    evaluatedAt: string;
  };
};

export type MissionRefreshResult = {
  persistence: "persisted" | "db_unavailable";
  privacyRule: {
    behaviorMinimumSample: number;
    exactLocationUsed: false;
    belowThresholdPublished: false;
  };
  activeCount: number;
  missions: PublicMission[];
};

const EMPTY_AGGREGATE: RecoveryAggregate = {
  eligibleCount: 0,
  noCandidateCount: 0,
  upstreamUnavailableCount: 0,
  totalOptionCount: 0,
  totalRejectedCount: 0,
  mobilityEligibleCount: 0,
  mobilityNoCandidateCount: 0,
  incidents: {},
  audiences: {},
  outcomeRunCount: 0,
  arrivedCount: 0,
  verifiedArrivedCount: 0,
  selfReportedArrivedCount: 0,
  continuedCount: 0,
  abandonedCount: 0,
  arrivedOnTimeCount: 0,
  arrivedWithTimingCount: 0,
  mobilityOutcomeCount: 0,
  mobilityAbandonedCount: 0,
};

function scopeDistrict(districtCode?: string): string {
  return districtCode ?? "_all";
}

function missionId(
  areaCode: string,
  districtCode: string,
  missionType: MissionCandidate["missionType"],
): string {
  return [
    "mission",
    MISSION_CALCULATION_VERSION,
    areaCode,
    districtCode,
    missionType,
  ].join(":");
}

function addDays(value: string, days: number): string {
  const base = new Date(value);
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  return new Date(
    safeBase.getTime() + days * 24 * 3_600_000,
  ).toISOString();
}

export function classifyMissionFailure(
  missionType: MissionCandidate["missionType"],
): FailureCategory {
  if (missionType === "policy_evidence_gap") return "data_gap";
  if (missionType === "hub_evidence_gap") return "content_gap";
  if (missionType === "recovery_scenario_gap") {
    return "operating_hours_gap";
  }
  return "mobility_gap";
}

function scenarioEvaluator(
  missionType: MissionCandidate["missionType"],
): MissionScenario["evaluator"] {
  if (missionType === "policy_evidence_gap") {
    return {
      metric: "official_evidence_coverage",
      betterWhen: "higher",
      activationRule:
        "공식 지표 누락 또는 OpenAPI 원천 오류가 1건 이상이면 활성화",
      observationWindow: "official_base_month",
    };
  }
  if (missionType === "hub_evidence_gap") {
    return {
      metric: "confirmed_hub_count",
      betterWhen: "higher",
      activationRule:
        "선택 시군구의 공식 중심관광지 응답이 0건이면 활성화",
      observationWindow: "official_base_month",
    };
  }
  if (missionType === "recovery_scenario_gap") {
    return {
      metric: "no_candidate_rate",
      betterWhen: "lower",
      activationRule:
        "동의 기반 30건 이상에서 유효 대안 없음 비율이 25% 이상이면 활성화",
      observationWindow: "rolling_30_days",
    };
  }
  if (missionType === "continuity_outcome_gap") {
    return {
      metric: "travel_abandonment_rate",
      betterWhen: "lower",
      activationRule:
        "동의 기반 최종 결과 30건 이상에서 여행 중단률이 20% 이상이면 활성화",
      observationWindow: "rolling_30_days",
    };
  }
  return {
    metric: "mobility_no_candidate_rate",
    betterWhen: "lower",
    activationRule:
      "이동·접근성 조건 요청 30건 이상에서 유효 대안 없음 비율이 20% 이상이면 활성화",
    observationWindow: "rolling_30_days",
  };
}

function buildMissionScenario(
  candidate: Pick<
    MissionCandidate,
    | "id"
    | "regionCode"
    | "districtCode"
    | "missionType"
    | "failureCategory"
  >,
): MissionScenario {
  return {
    id: candidate.id,
    scope: {
      areaCode: candidate.regionCode,
      districtCode: candidate.districtCode,
    },
    missionType: candidate.missionType,
    parameters: {
      failureCategory: candidate.failureCategory,
    },
    calculationVersion: MISSION_CALCULATION_VERSION,
    evaluator: scenarioEvaluator(candidate.missionType),
  };
}

function ownerScope(
  payload: PolicyInsightPayload,
  failureCategory: FailureCategory,
): Pick<MissionActionContract, "ownerOrganization" | "ownerRole"> {
  const localScope =
    [payload.regionName, payload.districtName]
      .filter(Boolean)
      .join(" ") || `지역코드 ${payload.areaCode}`;
  /* 이 값은 협약된 담당자가 아니라 "이 공백을 고칠 수 있는 주체"에 대한
     제안이다. 화면 라벨도 `제안 대상`으로 맞췄다. 협약 없이 특정 기관에
     책임과 마감일을 통보하는 것처럼 읽히지 않게 표현을 낮춘다. */
  if (failureCategory === "data_gap") {
    return {
      ownerOrganization: "한국관광공사 관광데이터 담당 부서(제안)",
      ownerRole: "공식 관광데이터 품질 검토",
    };
  }
  if (failureCategory === "content_gap") {
    return {
      ownerOrganization: `${localScope} 관광정책 담당부서(제안)`,
      ownerRole: "지역 대체관광 콘텐츠 검토",
    };
  }
  if (failureCategory === "operating_hours_gap") {
    return {
      ownerOrganization: `${localScope} 관광정보·시설 운영 담당부서(제안)`,
      ownerRole: "관광지 운영정보 개선 검토",
    };
  }
  return {
    ownerOrganization: `${localScope} 관광·교통 협업 담당부서(제안)`,
    ownerRole: "여행 이동 연속성 개선 검토",
  };
}

function buildActionContract(
  candidate: Pick<
    MissionCandidate,
    "missionType" | "failureCategory" | "recommendedPlan"
  >,
  payload: PolicyInsightPayload,
): MissionActionContract {
  const owner = ownerScope(payload, candidate.failureCategory);
  const deadlineDays = Math.min(
    Math.max(candidate.recommendedPlan.objective.score > 25 ? 30 : 14, 7),
    30,
  );
  if (candidate.failureCategory === "data_gap") {
    return {
      ...owner,
      deadlineAt: addDays(payload.generatedAt, deadlineDays),
      successCondition:
        "저장된 동일 지역·동일 API 조합을 재호출했을 때 필수 공식 지표가 모두 응답하고 원천 오류가 0건이어야 합니다.",
      evidenceRequirement:
        "수정된 공식 레코드 식별자, OpenAPI 요청 감사 ID, 조치 전후 응답 필드 비교를 제출해야 합니다.",
    };
  }
  if (candidate.failureCategory === "content_gap") {
    return {
      ...owner,
      deadlineAt: addDays(payload.generatedAt, deadlineDays),
      successCondition:
        "저장된 동일 중단 조건을 재실행했을 때 공식 식별자가 확인된 대체 관광지가 2개 이상 생성되어야 합니다.",
      evidenceRequirement:
        "보완된 한국관광공사 콘텐츠 ID, 지자체 확인 기록, 동일 시나리오 후보 생성 결과를 제출해야 합니다.",
    };
  }
  if (candidate.failureCategory === "operating_hours_gap") {
    return {
      ...owner,
      deadlineAt: addDays(payload.generatedAt, deadlineDays),
      successCondition:
        "저장된 동일 시간대·중단 유형 시나리오에서 운영 확인이 가능한 대안이 생성되고 유효 대안 없음 기준을 벗어나야 합니다.",
      evidenceRequirement:
        "공식 운영시간 또는 휴무정보 수정 근거, 반영된 API 응답, 같은 시간대 재실행 결과를 제출해야 합니다.",
    };
  }
  return {
    ...owner,
    deadlineAt: addDays(payload.generatedAt, deadlineDays),
    successCondition:
      candidate.missionType === "continuity_outcome_gap"
        ? "저장된 동일 이동·다음 예약 조건에서 복구안을 실행한 뒤 여행 중단률이 기준 미만으로 낮아져야 합니다."
        : "저장된 동일 이동·접근성 조건에서 검증된 대안이 생성되고 다음 고정 일정까지 이동 가능해야 합니다.",
    evidenceRequirement:
      "경로 또는 접근성 공식 근거, 조치 완료 기록, 같은 출발 조건의 재실행 감사 ID와 최종 도착 결과를 제출해야 합니다.",
  };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function dominant(
  values: Record<string, number>,
): { key: string; count: number } | null {
  const sorted = Object.entries(values).sort(
    ([leftKey, leftCount], [rightKey, rightCount]) =>
      rightCount - leftCount || leftKey.localeCompare(rightKey),
  );
  return sorted[0] ? { key: sorted[0][0], count: sorted[0][1] } : null;
}

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

/* 원천이 "값이 없다"고 답한 것과 우리가 "못 물어봤다"는 것을 가른다. 예전에는
   둘을 한 목록으로 묶어 개선 미션의 근거로 썼고, 그 미션은 공사 데이터 품질
   책임자에게 배정됐다. 즉 우리 조회 실패를 공사 데이터 공백으로 보고했다.
   실제로 같은 파라미터를 직접 호출하면 값이 나오는 경우가 있었다. */
function emptyPolicySources(payload: PolicyInsightPayload): string[] {
  return payload.sourceLedger
    .filter((source) => source.status === "empty")
    .map((source) => `${source.apiName}.${source.operation}`);
}

function erroredPolicySources(payload: PolicyInsightPayload): string[] {
  return payload.sourceLedger
    .filter((source) => source.status === "error")
    .map((source) => `${source.apiName}.${source.operation}`);
}

function uncertaintyPenalty(
  uncertainty: MissionIntervention["uncertainty"],
): number {
  if (uncertainty === "low") return 0;
  if (uncertainty === "medium") return 5;
  return 11;
}

function scoredIntervention(
  intervention: Omit<MissionIntervention, "objectiveScore">,
): MissionIntervention {
  const objectiveScore =
    intervention.effortPoints * 4 +
    intervention.estimatedDays * 0.5 +
    uncertaintyPenalty(intervention.uncertainty) -
    intervention.closes.length * 10;
  return {
    ...intervention,
    objectiveScore: Math.round(objectiveScore * 10) / 10,
  };
}

export function selectRecommendedPlan(
  interventions: MissionIntervention[],
): RecommendedMissionPlan {
  const ranked = [...interventions].sort(
    (left, right) =>
      left.objectiveScore - right.objectiveScore ||
      left.estimatedDays - right.estimatedDays ||
      left.effortPoints - right.effortPoints ||
      left.id.localeCompare(right.id),
  );
  const selected = ranked[0];
  if (!selected) {
    throw new Error("At least one intervention is required.");
  }
  return {
    interventionId: selected.id,
    title: selected.title,
    rationale:
      `예상 노력 ${selected.effortPoints}, ${selected.estimatedDays}일, 불확실성 ${selected.uncertainty} 조건에서 ` +
      `${selected.closes.length}개 공백을 닫는 최소개입안입니다.`,
    objective: {
      minimize: [
        "estimated_effort",
        "estimated_time",
        "uncertainty",
      ],
      maximize: "evidence_or_recovery_gaps_closed",
      score: selected.objectiveScore,
    },
  };
}

function interventionOptions(
  candidate: MissionCandidateSeed,
): MissionIntervention[] {
  if (candidate.missionType === "policy_evidence_gap") {
    const missingMetrics = Array.isArray(
      candidate.evidence.missingMetrics,
    )
      ? candidate.evidence.missingMetrics.map(String)
      : [];
    const incompleteSources = Array.isArray(
      candidate.evidence.incompleteSources,
    )
      ? candidate.evidence.incompleteSources.map(String)
      : [];
    return [
      scoredIntervention({
        id: "validate-scope-and-base-month",
        title: "지역코드·기준월 정합성 재점검",
        description:
          "법정동 코드 변환과 최신 가용 기준월을 다시 확인한 뒤 같은 요청을 재실행합니다.",
        effortPoints: 1,
        estimatedDays: 2,
        uncertainty: "low",
        closes: ["scope_or_base_month_mismatch"],
      }),
      scoredIntervention({
        id: "complete-official-policy-fields",
        title: "누락 정책 필드 보완 요청",
        description:
          "값이 없는 공식 지표와 오류 원천을 묶어 데이터 보완 요청으로 전달합니다.",
        effortPoints: 3,
        estimatedDays: 10,
        uncertainty: "medium",
        closes: [
          ...missingMetrics.map((metric) => `metric:${metric}`),
          ...incompleteSources.map((source) => `source:${source}`),
        ].slice(0, 7),
      }),
      scoredIntervention({
        id: "publish-data-quality-runbook",
        title: "반복 누락 자동점검 규칙 등록",
        description:
          "동일 지표가 다시 비는 경우 운영자가 즉시 확인할 수 있도록 정기 검증 규칙을 등록합니다.",
        effortPoints: 2,
        estimatedDays: 5,
        uncertainty: "low",
        closes: ["repeat_detection", "operator_notification"],
      }),
    ];
  }

  if (candidate.missionType === "hub_evidence_gap") {
    return [
      scoredIntervention({
        id: "verify-hub-code-and-identifier",
        title: "중심관광지 코드·식별자 재매칭",
        description:
          "시군구 코드와 중심관광지 명칭·좌표 매칭을 확인해 기술적 누락부터 제거합니다.",
        effortPoints: 1,
        estimatedDays: 2,
        uncertainty: "low",
        closes: ["hub_scope_match"],
      }),
      scoredIntervention({
        id: "complete-hub-official-record",
        title: "공식 중심관광지 정보 보완",
        description:
          "확인 가능한 중심 거점의 공식 정보와 식별자를 보완한 뒤 대체망 시나리오를 재실행합니다.",
        effortPoints: 3,
        estimatedDays: 12,
        uncertainty: "medium",
        closes: [
          "hub_official_record",
          "hub_identifier",
          "district_anchor",
        ],
      }),
      scoredIntervention({
        id: "validate-alternative-anchor-set",
        title: "대체 거점 후보군 현장 검증",
        description:
          "공식 중심지 응답이 계속 비는 경우 지자체와 대체 기준점을 검토하고 데이터 반영 가능성을 확인합니다.",
        effortPoints: 5,
        estimatedDays: 25,
        uncertainty: "high",
        closes: [
          "district_anchor",
          "alternative_network_seed",
          "local_validation",
        ],
      }),
    ];
  }

  if (candidate.missionType === "mobility_recovery_gap") {
    return [
      scoredIntervention({
        id: "audit-top-accessibility-rejections",
        title: "반복 탈락 관광지 접근성 필드 점검",
        description:
          "이동·접근성 조건에서 반복 탈락한 관광지의 무장애 상세 필드 누락을 우선 확인합니다.",
        effortPoints: 2,
        estimatedDays: 5,
        uncertainty: "low",
        closes: [
          "rejection_reason_visibility",
          "accessibility_field_gap",
        ],
      }),
      scoredIntervention({
        id: "complete-accessibility-records",
        title: "상위 대체지 무장애 정보 보완",
        description:
          "복구 반경 안의 상위 후보부터 출입구·화장실·유아차 등 공식 편의정보를 보완합니다.",
        effortPoints: 4,
        estimatedDays: 14,
        uncertainty: "medium",
        closes: [
          "accessibility_field_gap",
          "candidate_verification_gap",
          "mobility_recovery_gap",
        ],
      }),
      scoredIntervention({
        id: "develop-accessible-alternative-cluster",
        title: "이동약자 대체 콘텐츠 묶음 발굴",
        description:
          "공식 정보 보완만으로 후보가 생기지 않는 권역에 실내·무장애 대체 콘텐츠 묶음을 발굴합니다.",
        effortPoints: 6,
        estimatedDays: 35,
        uncertainty: "high",
        closes: [
          "candidate_supply_gap",
          "mobility_recovery_gap",
          "weather_resilience_gap",
          "local_validation",
        ],
      }),
    ];
  }

  if (candidate.missionType === "continuity_outcome_gap") {
    return [
      scoredIntervention({
        id: "classify-abandonment-outcomes",
        title: "여행 중단 결과 원인 분류",
        description:
          "도착·여행 지속·중단 결과와 중단 사유를 비식별 집계해 후보 생성 이후 이탈 구간을 확인합니다.",
        effortPoints: 2,
        estimatedDays: 4,
        uncertainty: "low",
        closes: [
          "outcome_visibility_gap",
          "abandonment_reason_gap",
        ],
      }),
      scoredIntervention({
        id: "repair-continuity-friction",
        title: "상위 여행 지속 방해요인 개선",
        description:
          "반복된 중단 사유 중 실제 경로·운영정보·도착 여유와 관련된 상위 항목을 먼저 개선합니다.",
        effortPoints: 4,
        estimatedDays: 14,
        uncertainty: "medium",
        closes: [
          "route_confidence_gap",
          "operation_confidence_gap",
          "continuity_outcome_gap",
        ],
      }),
      scoredIntervention({
        id: "field-validate-continuity-scenario",
        title: "취약 복구 시나리오 현장 재검증",
        description:
          "데이터 보완 후에도 중단률이 높은 시나리오를 현장에서 재현해 이동·안내·콘텐츠 문제를 함께 점검합니다.",
        effortPoints: 6,
        estimatedDays: 28,
        uncertainty: "high",
        closes: [
          "route_confidence_gap",
          "operation_confidence_gap",
          "continuity_outcome_gap",
          "local_validation",
        ],
      }),
    ];
  }

  return [
    scoredIntervention({
      id: "classify-recovery-rejections",
      title: "반복 복구 실패 원인 자동분류",
      description:
        "동의 기반 비식별 집계에서 반복되는 사건·탈락 사유를 콘텐츠, 운영정보, 접근성 공백으로 분리합니다.",
      effortPoints: 2,
      estimatedDays: 4,
      uncertainty: "low",
      closes: ["dominant_scenario", "rejection_reason_visibility"],
    }),
    scoredIntervention({
      id: "complete-top-rejected-candidates",
      title: "상위 탈락 후보 공식정보 보완",
      description:
        "가장 적은 조건 차이로 탈락한 후보의 운영·접근성·식별정보를 보완하고 동일 시나리오를 재실행합니다.",
      effortPoints: 4,
      estimatedDays: 12,
      uncertainty: "medium",
      closes: [
        "official_data_gap",
        "candidate_verification_gap",
        "recovery_scenario_gap",
      ],
    }),
    scoredIntervention({
      id: "develop-scenario-alternative-cluster",
      title: "취약 상황 대체 콘텐츠 묶음 발굴",
      description:
        "정보 보완 후에도 후보가 없는 경우 우세한 중단 상황에 맞는 지역 콘텐츠 묶음을 발굴합니다.",
      effortPoints: 6,
      estimatedDays: 30,
      uncertainty: "high",
      closes: [
        "candidate_supply_gap",
        "recovery_scenario_gap",
        "dispersion_network_gap",
        "local_validation",
      ],
    }),
  ];
}

function completeCandidate(
  candidate: MissionCandidateSeed,
  payload: PolicyInsightPayload,
): MissionCandidate {
  const interventions = interventionOptions(candidate);
  const recommendedPlan = selectRecommendedPlan(interventions);
  const failureCategory = classifyMissionFailure(
    candidate.missionType,
  );
  const completedWithoutContract = {
    ...candidate,
    failureCategory,
    scenario: buildMissionScenario({
      ...candidate,
      failureCategory,
    }),
    interventions,
    recommendedPlan,
  };
  return {
    ...completedWithoutContract,
    actionContract: buildActionContract(
      completedWithoutContract,
      payload,
    ),
  };
}

export function buildMissionCandidates(
  payload: PolicyInsightPayload,
  aggregate: RecoveryAggregate = EMPTY_AGGREGATE,
): MissionCandidate[] {
  const districtCode = scopeDistrict(payload.districtCode);
  const incompleteSources = emptyPolicySources(payload);
  const retrievalFailures = erroredPolicySources(payload);
  /* 값이 빈 지표를 원천별로 귀속시킨다.
     `metric.source`·`metric.operation`이 실패한 원장 항목과 일치하면, 그 값이
     비어 있는 이유는 공사에 데이터가 없는 것이 아니라 우리 호출이 실패한
     것이다. 이 구분이 없던 동안 미션 하나에 두 사실이 섞여, 담당 제안이
     `한국관광공사 관광데이터 담당 부서`로 찍힌 미션의 같은 지역 원장에는
     우리 `NETWORK_ERROR`가 남아 있었다. 공사에 보완을 요구하는 문서로
     쓰이는 산출물에서 이 혼동은 그대로 오귀속이 된다. */
  const erroredSourceKeys = new Set(retrievalFailures);
  const nullMetrics = payload.metrics.filter(
    (metric) => metric.value === null,
  );
  const metricLabel = (metric: (typeof nullMetrics)[number]) =>
    metric.officialName || metric.label;
  const unverifiableMetrics = nullMetrics
    .filter((metric) =>
      erroredSourceKeys.has(`${metric.source}.${metric.operation}`),
    )
    .map(metricLabel);
  const missingMetrics = nullMetrics
    .filter(
      (metric) =>
        !erroredSourceKeys.has(`${metric.source}.${metric.operation}`),
    )
    .map(metricLabel);
  const availableMetricCount = payload.metrics.length - nullMetrics.length;
  /* 확인할 수 있었던 지표만 분모로 쓴다. 우리가 못 불러온 지표를 분모에
     남기면 우리 실패가 지역의 데이터 완성도 점수를 깎는다. */
  const verifiableMetricCount = Math.max(
    payload.metrics.length - unverifiableMetrics.length,
    0,
  );
  /* 조회 실패만 있는 경우에는 미션을 만들지 않는다. 고쳐야 할 대상이 공사
     데이터가 아니라 우리 호출이기 때문이다. 그 사실은 아래 evidence에
     남겨 운영자가 볼 수 있게 한다. */
  const policyActive =
    missingMetrics.length > 0 || incompleteSources.length > 0;

  const policyMission: MissionCandidateSeed = {
    id: missionId(
      payload.areaCode,
      districtCode,
      "policy_evidence_gap",
    ),
    regionCode: payload.areaCode,
    districtCode,
    missionType: "policy_evidence_gap",
    active: policyActive,
    inactiveStatus: "resolved",
    priority: missingMetrics.length >= 4 ? 95 : 78,
    title: "정책 근거 데이터 완성도 점검",
    summary:
      (policyActive
        ? [
            missingMetrics.length > 0
              ? `정책 세부지표 ${missingMetrics.length}개`
              : "",
            incompleteSources.length > 0
              ? `원천 응답 ${incompleteSources.length}건`
              : "",
          ]
            .filter(Boolean)
            .join("와 ") +
          `이 ${payload.baseYm.slice(0, 4)}년 ${payload.baseYm.slice(4)}월 기준으로 비어 있습니다.`
        : verifiableMetricCount === 0
          ? `${payload.baseYm.slice(0, 4)}년 ${payload.baseYm.slice(4)}월 정책 세부지표를 한 건도 조회하지 못해 완성도를 판정하지 못했습니다.`
          : `확인 가능한 정책 세부지표 ${verifiableMetricCount}개가 현재 기준월에서 모두 확인됐습니다.`) +
      /* 우리 실패를 미션 본문에서 분리해 밝힌다. 이 문장이 없으면 담당 제안이
         공사로 찍힌 미션의 근거에 우리 오류가 조용히 섞인다. */
      (unverifiableMetrics.length
        ? ` 별도로 지표 ${unverifiableMetrics.length}개는 이어가의 조회가 실패해 판정하지 못했습니다(공사 데이터 공백이 아니며, 이어가가 고쳐야 할 항목입니다).`
        : ""),
    actionText:
      "누락 지표의 공식 원천·법정동 코드·기준월을 확인하고 같은 지역 범위를 다시 검증합니다.",
    evidence: {
      evidenceKind: "official_openapi",
      availableMetricCount,
      expectedMetricCount: 7,
      missingMetrics,
      incompleteSources,
      /* 우리 조회가 실패한 원천. 공사에 요구할 개선 대상이 아니라 이어가가
         고쳐야 할 항목이므로 별도 필드로 분리해 둔다. */
      retrievalFailures,
      /* 그 실패 때문에 판정 자체가 불가능했던 지표. `missingMetrics`와
         섞이면 공사에 없는 데이터로 읽힌다. */
      unverifiableMetrics,
      verifiableMetricCount,
      coverageMeaning:
        "관광지 품질 점수가 아니라 공식 정책 근거의 값 확인 여부입니다.",
      denominatorMeaning: unverifiableMetrics.length
        ? `조회에 실패한 지표 ${unverifiableMetrics.length}개는 분모에서 제외했습니다. 값이 없다는 판정이 아니라 확인하지 못했다는 뜻입니다.`
        : "전체 정책 세부지표를 분모로 씁니다.",
    },
    /* 확인할 수 있었던 지표가 하나도 없으면 완성도는 `0%`가 아니라 미측정이다.
       분모가 0인 비율을 0으로 발표하면 조회 실패가 최악의 데이터 품질로
       보인다. */
    currentValue: verifiableMetricCount
      ? percent(availableMetricCount, verifiableMetricCount)
      : null,
    sampleSize: 0,
    privacyState: "official_only",
    policyBaseMonth: payload.baseYm,
  };

  const hubAudit = payload.sourceLedger.find(
    (source) => source.apiName === "LocgoHubTarService1",
  );
  const hubRequired = Boolean(payload.districtCode);
  /* 중심 관광지도 같은 기준이다. 우리 호출이 실패한 경우(`error`)는 공사에
     보완을 요구할 근거가 되지 않는다. */
  const hubActive =
    hubRequired &&
    hubAudit?.status !== "error" &&
    (payload.hubs.length === 0 || hubAudit?.status === "empty");
  const hubMission: MissionCandidateSeed = {
    id: missionId(
      payload.areaCode,
      districtCode,
      "hub_evidence_gap",
    ),
    regionCode: payload.areaCode,
    districtCode,
    missionType: "hub_evidence_gap",
    active: hubActive,
    inactiveStatus: "resolved",
    priority: 72,
    title: "기초지자체 대체 거점 근거 점검",
    summary: hubRequired
      ? hubActive
        ? "선택 시군구의 중심 관광지 근거를 확인하지 못해 지역 대체망의 기준점을 만들 수 없습니다."
        : `선택 시군구에서 중심 관광지 ${payload.hubs.length}개를 확인했습니다.`
      : "시도 단위 조회에는 기초지자체 중심 관광지 근거를 요구하지 않습니다.",
    actionText:
      "기초지자체 중심 관광지 응답과 관광지 식별자 정합성을 확인한 뒤 동일 시군구를 재검증합니다.",
    evidence: {
      evidenceKind: "official_openapi",
      requiredForScope: hubRequired,
      confirmedHubCount: payload.hubs.length,
      sourceStatus: hubAudit?.status ?? "not_required",
      sourceReferenceDate: hubAudit?.sourceReferenceDate ?? null,
    },
    currentValue: hubRequired ? payload.hubs.length : null,
    sampleSize: 0,
    privacyState: "official_only",
    policyBaseMonth: payload.baseYm,
  };

  const behaviorThresholdMet =
    aggregate.eligibleCount >= MINIMUM_BEHAVIOR_SAMPLE;
  const noCandidateRate = percent(
    aggregate.noCandidateCount,
    aggregate.eligibleCount,
  );
  const dominantIncident = dominant(aggregate.incidents);
  const recoveryActive =
    behaviorThresholdMet && noCandidateRate >= 25;
  const recoveryEvidence = behaviorThresholdMet
    ? {
        evidenceKind: "consented_generalized_recovery_requests",
        eligibleRequestCount: aggregate.eligibleCount,
        noCandidateRequestCount: aggregate.noCandidateCount,
        noCandidateRate,
        averageOptionCount:
          Math.round(
            (aggregate.totalOptionCount / aggregate.eligibleCount) * 10,
          ) / 10,
        averageRejectedCount:
          Math.round(
            (aggregate.totalRejectedCount / aggregate.eligibleCount) * 10,
          ) / 10,
        upstreamUnavailableCount: aggregate.upstreamUnavailableCount,
        dominantIncident,
        interpretation:
          "사용자가 대안을 실제 선택·방문했다는 성과지표가 아니라, 동의한 복구 요청에서 유효 후보를 만들 수 있었는지의 집계입니다.",
      }
    : {
        evidenceKind: "suppressed_behavior_aggregate",
        privacyState: "below_threshold",
        minimumSampleSize: MINIMUM_BEHAVIOR_SAMPLE,
      };
  const recoveryMission: MissionCandidateSeed = {
    id: missionId(
      payload.areaCode,
      districtCode,
      "recovery_scenario_gap",
    ),
    regionCode: payload.areaCode,
    districtCode,
    missionType: "recovery_scenario_gap",
    active: recoveryActive,
    inactiveStatus: behaviorThresholdMet ? "resolved" : "suppressed",
    priority: noCandidateRate >= 50 ? 98 : 88,
    title: "여행 중단 복구 공백 개선",
    summary: behaviorThresholdMet
      ? recoveryActive
        ? `동의 기반 비식별 요청 ${aggregate.eligibleCount}건 중 유효 대안이 없었던 요청이 ${noCandidateRate}%입니다.`
        : `동의 기반 비식별 요청의 유효 대안 없음 비율이 ${noCandidateRate}%로 관리 기준 이내입니다.`
      : "행동 집계는 최소 공개기준 30건을 충족하기 전까지 생성·공개하지 않습니다.",
    actionText:
      "우세한 중단 상황의 탈락 원인을 콘텐츠 부족·운영정보 누락·접근성 정보 누락으로 분리하고, 보완 후 동일 조건을 재실행합니다.",
    evidence: recoveryEvidence,
    currentValue: behaviorThresholdMet ? noCandidateRate : null,
    sampleSize: behaviorThresholdMet ? aggregate.eligibleCount : 0,
    privacyState: behaviorThresholdMet
      ? "threshold_met"
      : "below_threshold",
    policyBaseMonth: payload.baseYm,
  };

  const outcomeThresholdMet =
    aggregate.outcomeRunCount >= MINIMUM_BEHAVIOR_SAMPLE;
  const continuityCount =
    aggregate.arrivedCount + aggregate.continuedCount;
  const continuityRate = percent(
    continuityCount,
    aggregate.outcomeRunCount,
  );
  const abandonmentRate = percent(
    aggregate.abandonedCount,
    aggregate.outcomeRunCount,
  );
  const onTimeArrivalRate = percent(
    aggregate.arrivedOnTimeCount,
    aggregate.arrivedWithTimingCount,
  );
  const outcomeActive =
    outcomeThresholdMet && abandonmentRate >= 20;
  const outcomeEvidence = outcomeThresholdMet
    ? {
        evidenceKind: "consented_generalized_continuity_outcomes",
        finalizedOutcomeCount: aggregate.outcomeRunCount,
        arrivedCount: aggregate.arrivedCount,
        verifiedArrivedCount: aggregate.verifiedArrivedCount ?? 0,
        selfReportedArrivedCount:
          aggregate.selfReportedArrivedCount ??
          aggregate.arrivedCount,
        continuedCount: aggregate.continuedCount,
        abandonedCount: aggregate.abandonedCount,
        continuityRate,
        abandonmentRate,
        arrivedWithTimingCount: aggregate.arrivedWithTimingCount,
        onTimeArrivalRate:
          aggregate.arrivedWithTimingCount > 0
            ? onTimeArrivalRate
            : null,
        interpretation:
          "후보 생성 수가 아니라 사용자가 기록한 도착·여행 지속·중단의 최신 최종 결과를 복구 실행별로 한 번만 집계합니다.",
      }
    : {
        evidenceKind: "suppressed_behavior_aggregate",
        privacyState: "below_threshold",
        minimumSampleSize: MINIMUM_BEHAVIOR_SAMPLE,
      };
  const outcomeMission: MissionCandidateSeed = {
    id: missionId(
      payload.areaCode,
      districtCode,
      "continuity_outcome_gap",
    ),
    regionCode: payload.areaCode,
    districtCode,
    missionType: "continuity_outcome_gap",
    active: outcomeActive,
    inactiveStatus: outcomeThresholdMet ? "resolved" : "suppressed",
    priority: abandonmentRate >= 40 ? 100 : 94,
    title: "실제 여행 지속 결과 개선",
    summary: outcomeThresholdMet
      ? outcomeActive
        ? `최종 결과 ${aggregate.outcomeRunCount}건 중 여행 중단이 ${abandonmentRate}%로 확인됐습니다.`
        : `최종 결과의 여행 중단 비율이 ${abandonmentRate}%로 관리 기준 이내입니다.`
      : "도착·여행 지속·중단 결과는 최소 공개기준 30건을 충족하기 전까지 생성·공개하지 않습니다.",
    actionText:
      "여행 중단 사유를 경로·운영정보·도착 여유·현장 접근성으로 분류하고 최소개입안을 적용한 뒤 동일 시나리오의 최종 결과를 재검증합니다.",
    evidence: outcomeEvidence,
    currentValue: outcomeThresholdMet ? abandonmentRate : null,
    sampleSize: outcomeThresholdMet ? aggregate.outcomeRunCount : 0,
    privacyState: outcomeThresholdMet
      ? "threshold_met"
      : "below_threshold",
    policyBaseMonth: payload.baseYm,
  };

  const mobilityThresholdMet =
    aggregate.mobilityEligibleCount >= MINIMUM_BEHAVIOR_SAMPLE;
  const mobilityNoCandidateRate = percent(
    aggregate.mobilityNoCandidateCount,
    aggregate.mobilityEligibleCount,
  );
  const dominantAudience = dominant(
    Object.fromEntries(
      Object.entries(aggregate.audiences).filter(
        ([audience]) => audience !== "general",
      ),
    ),
  );
  const mobilityActive =
    mobilityThresholdMet && mobilityNoCandidateRate >= 20;
  const mobilityEvidence = mobilityThresholdMet
    ? {
        evidenceKind: "consented_generalized_recovery_requests",
        eligibleRequestCount: aggregate.mobilityEligibleCount,
        noCandidateRequestCount: aggregate.mobilityNoCandidateCount,
        noCandidateRate: mobilityNoCandidateRate,
        dominantAudience,
        interpretation:
          "건강정보나 정확한 위치가 아닌 이용자 선택 필터와 시군구 단위 결과만 집계합니다.",
      }
    : {
        evidenceKind: "suppressed_behavior_aggregate",
        privacyState: "below_threshold",
        minimumSampleSize: MINIMUM_BEHAVIOR_SAMPLE,
      };
  const mobilityMission: MissionCandidateSeed = {
    id: missionId(
      payload.areaCode,
      districtCode,
      "mobility_recovery_gap",
    ),
    regionCode: payload.areaCode,
    districtCode,
    missionType: "mobility_recovery_gap",
    active: mobilityActive,
    inactiveStatus: mobilityThresholdMet ? "resolved" : "suppressed",
    priority: mobilityNoCandidateRate >= 40 ? 99 : 92,
    title: "이동약자 동반 복구 공백 개선",
    summary: mobilityThresholdMet
      ? mobilityActive
        ? `이동·접근성 조건 요청 ${aggregate.mobilityEligibleCount}건 중 유효 대안 없음 비율이 ${mobilityNoCandidateRate}%입니다.`
        : `이동·접근성 조건 요청의 유효 대안 없음 비율이 ${mobilityNoCandidateRate}%로 관리 기준 이내입니다.`
      : "이동·접근성 조건 집계는 최소 공개기준 30건을 충족하기 전까지 생성·공개하지 않습니다.",
    actionText:
      "반복 탈락한 관광지의 무장애 상세정보와 인근 대체 콘텐츠를 보완하고, 동일 이용자 조건으로 재검증합니다.",
    evidence: mobilityEvidence,
    currentValue: mobilityThresholdMet ? mobilityNoCandidateRate : null,
    sampleSize: mobilityThresholdMet
      ? aggregate.mobilityEligibleCount
      : 0,
    privacyState: mobilityThresholdMet
      ? "threshold_met"
      : "below_threshold",
    policyBaseMonth: payload.baseYm,
  };

  return [
    completeCandidate(policyMission, payload),
    completeCandidate(hubMission, payload),
    completeCandidate(recoveryMission, payload),
    completeCandidate(outcomeMission, payload),
    completeCandidate(mobilityMission, payload),
  ];
}

async function loadRecoveryAggregate(params: {
  areaCode: string;
  districtCode?: string;
}): Promise<RecoveryAggregate> {
  const db = getDb();
  const since = new Date(
    Date.now() - 30 * 24 * 3_600_000,
  ).toISOString();
  const filters = [
    eq(recoveryRuns.analyticsEligible, true),
    eq(recoveryRuns.regionCode, params.areaCode),
    isNull(recoveryRuns.deletedAt),
    gte(recoveryRuns.startedAt, since),
  ];
  if (params.districtCode) {
    filters.push(
      eq(recoveryRuns.districtCode, params.districtCode),
    );
  }

  const rows = await db
    .select({
      sessionId: recoveryRuns.sessionId,
      incident: recoveryRuns.incident,
      audience: recoveryRuns.audience,
      status: recoveryRuns.status,
      optionCount: recoveryRuns.optionCount,
      rejectedCount: recoveryRuns.rejectedCount,
      startedAt: recoveryRuns.startedAt,
    })
    .from(recoveryRuns)
    .where(and(...filters))
    .orderBy(desc(recoveryRuns.startedAt))
    .limit(10_000);

  const aggregate: RecoveryAggregate = {
    ...EMPTY_AGGREGATE,
    incidents: {},
    audiences: {},
  };
  const latestRunBySession = new Map<
    string,
    (typeof rows)[number]
  >();
  for (const row of rows) {
    if (!latestRunBySession.has(row.sessionId)) {
      latestRunBySession.set(row.sessionId, row);
    }
  }
  for (const row of latestRunBySession.values()) {
    aggregate.eligibleCount += 1;
    aggregate.totalOptionCount += row.optionCount;
    aggregate.totalRejectedCount += row.rejectedCount;
    increment(aggregate.incidents, row.incident);
    increment(aggregate.audiences, row.audience);
    if (row.status === "no_valid_candidate") {
      aggregate.noCandidateCount += 1;
    }
    if (
      row.status === "upstream_unavailable" ||
      row.status === "unsupported_coverage"
    ) {
      aggregate.upstreamUnavailableCount += 1;
    }
    if (row.audience !== "general") {
      aggregate.mobilityEligibleCount += 1;
      if (row.status === "no_valid_candidate") {
        aggregate.mobilityNoCandidateCount += 1;
      }
    }
  }

  const outcomeRows = await db
    .select({
      runId: recoveryOutcomes.runId,
      sessionId: recoveryRuns.sessionId,
      event: recoveryOutcomes.event,
      occurredAt: recoveryOutcomes.occurredAt,
      arrivedOnTime: recoveryOutcomes.arrivedOnTime,
      metadataJson: recoveryOutcomes.metadataJson,
      audience: recoveryRuns.audience,
    })
    .from(recoveryOutcomes)
    .innerJoin(
      recoveryRuns,
      eq(recoveryRuns.id, recoveryOutcomes.runId),
    )
    .where(
      and(
        ...filters,
        inArray(recoveryOutcomes.event, [
          "arrived",
          "continued",
          "abandoned",
        ]),
      ),
    )
    .orderBy(desc(recoveryOutcomes.occurredAt))
    .limit(20_000);
  const latestFinalOutcomeBySession = new Map<
    string,
    (typeof outcomeRows)[number]
  >();
  for (const row of outcomeRows) {
    if (!latestFinalOutcomeBySession.has(row.sessionId)) {
      latestFinalOutcomeBySession.set(row.sessionId, row);
    }
  }
  for (const row of latestFinalOutcomeBySession.values()) {
    aggregate.outcomeRunCount += 1;
    if (row.event === "arrived") {
      aggregate.arrivedCount += 1;
      let arrivalEvidence = "self_reported";
      try {
        const metadata = JSON.parse(row.metadataJson) as {
          arrivalEvidence?: unknown;
        };
        if (
          metadata.arrivalEvidence === "server_verified" ||
          metadata.arrivalEvidence === "location_verified"
        ) {
          arrivalEvidence = metadata.arrivalEvidence;
        }
      } catch {
        arrivalEvidence = "self_reported";
      }
      if (arrivalEvidence === "self_reported") {
        aggregate.selfReportedArrivedCount += 1;
      } else {
        aggregate.verifiedArrivedCount += 1;
      }
      if (
        arrivalEvidence !== "self_reported" &&
        row.arrivedOnTime !== null
      ) {
        aggregate.arrivedWithTimingCount += 1;
        if (row.arrivedOnTime) aggregate.arrivedOnTimeCount += 1;
      }
    } else if (row.event === "continued") {
      aggregate.continuedCount += 1;
    } else if (row.event === "abandoned") {
      aggregate.abandonedCount += 1;
    }
    if (row.audience !== "general") {
      aggregate.mobilityOutcomeCount += 1;
      if (row.event === "abandoned") {
        aggregate.mobilityAbandonedCount += 1;
      }
    }
  }
  return aggregate;
}

function revalidationResult(
  missionType: MissionCandidate["missionType"],
  baselineValue: number | null,
  currentValue: number | null,
): PublicMission["revalidation"] {
  if (baselineValue === null || currentValue === null) {
    return {
      baselineValue,
      currentValue,
      delta: null,
      result: "not_comparable",
    };
  }
  const delta =
    Math.round((currentValue - baselineValue) * 10) / 10;
  const lowerIsBetter = [
    "recovery_scenario_gap",
    "continuity_outcome_gap",
    "mobility_recovery_gap",
  ].includes(missionType);
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  const regressed = lowerIsBetter ? delta > 0 : delta < 0;
  return {
    baselineValue,
    currentValue,
    delta,
    result: improved
      ? "improved"
      : regressed
        ? "regressed"
        : "unchanged",
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function storedFailureCategory(
  value: string,
  missionType: MissionCandidate["missionType"],
): FailureCategory {
  return (FAILURE_CATEGORIES as readonly string[]).includes(value)
    ? (value as FailureCategory)
    : classifyMissionFailure(missionType);
}

function storedScenario(
  row: typeof resilienceMissions.$inferSelect,
  missionType: MissionCandidate["missionType"],
): MissionScenario {
  const parsed = parseJsonRecord(row.scenarioJson);
  const scope =
    parsed.scope &&
    typeof parsed.scope === "object" &&
    !Array.isArray(parsed.scope)
      ? (parsed.scope as Record<string, unknown>)
      : {};
  const evaluator =
    parsed.evaluator &&
    typeof parsed.evaluator === "object" &&
    !Array.isArray(parsed.evaluator)
      ? (parsed.evaluator as Record<string, unknown>)
      : {};
  const parameters =
    parsed.parameters &&
    typeof parsed.parameters === "object" &&
    !Array.isArray(parsed.parameters)
      ? (parsed.parameters as Record<string, unknown>)
      : {};
  if (
    parsed.id === row.id &&
    parsed.missionType === missionType &&
    parsed.calculationVersion === MISSION_CALCULATION_VERSION &&
    typeof scope.areaCode === "string" &&
    typeof scope.districtCode === "string" &&
    typeof parameters.failureCategory === "string" &&
    (FAILURE_CATEGORIES as readonly string[]).includes(
      parameters.failureCategory,
    ) &&
    typeof evaluator.metric === "string" &&
    (evaluator.betterWhen === "higher" ||
      evaluator.betterWhen === "lower") &&
    typeof evaluator.activationRule === "string" &&
    (evaluator.observationWindow === "official_base_month" ||
      evaluator.observationWindow === "rolling_30_days")
  ) {
    return parsed as unknown as MissionScenario;
  }
  return buildMissionScenario({
    id: row.id,
    regionCode: row.regionCode,
    districtCode: row.districtCode,
    missionType,
    failureCategory: storedFailureCategory(
      row.failureCategory,
      missionType,
    ),
  });
}

function storedActionEvidence(
  value: string,
): MissionActionEvidence | undefined {
  const parsed = parseJsonRecord(value);
  if (
    typeof parsed.actionSummary !== "string" ||
    !Array.isArray(parsed.artifactReferences) ||
    typeof parsed.occurredAt !== "string" ||
    typeof parsed.recordedBy !== "string"
  ) {
    return undefined;
  }
  return {
    actionSummary: parsed.actionSummary,
    artifactReferences: parsed.artifactReferences.map(String),
    occurredAt: parsed.occurredAt,
    recordedBy: parsed.recordedBy,
  };
}

function asPublicMission(
  row: typeof resilienceMissions.$inferSelect,
): PublicMission | null {
  if (
    row.status === "suppressed" ||
    row.privacyState === "below_threshold"
  ) {
    return null;
  }
  const missionType =
    row.missionType as MissionCandidate["missionType"];
  const actionEvidence = storedActionEvidence(
    row.actionEvidenceJson,
  );
  return {
    id: row.id,
    regionCode: row.regionCode,
    districtCode:
      row.districtCode === "_all" ? undefined : row.districtCode,
    missionType,
    status: row.status as PublicMission["status"],
    priority: row.priority,
    title: row.title,
    summary: row.summary,
    actionText: row.actionText,
    failureCategory: storedFailureCategory(
      row.failureCategory,
      missionType,
    ),
    actionContract: {
      ownerOrganization: row.ownerOrganization,
      ownerRole: row.ownerRole,
      deadlineAt: row.deadlineAt,
      successCondition: row.successCondition,
      evidenceRequirement: row.evidenceRequirement,
    },
    scenario: storedScenario(row, missionType),
    actionEvidence: actionEvidence
      ? {
          actionSummary: actionEvidence.actionSummary,
          evidenceCount: actionEvidence.artifactReferences.length,
          occurredAt: actionEvidence.occurredAt,
        }
      : undefined,
    actionRecordedAt: row.actionRecordedAt ?? undefined,
    lastRevalidatedAt: row.lastRevalidatedAt ?? undefined,
    lastRevalidationResult:
      (row.lastRevalidationResult as PublicMission["lastRevalidationResult"]) ??
      undefined,
    revalidationCount: row.revalidationCount,
    evidence: JSON.parse(row.evidenceJson) as Record<string, unknown>,
    baselineValue: row.baselineValue,
    currentValue: row.currentValue,
    sampleSize: row.sampleSize,
    minimumSampleSize: row.minimumSampleSize,
    privacyState: row.privacyState as PublicMission["privacyState"],
    policyBaseMonth: row.policyBaseMonth ?? undefined,
    calculationVersion: row.calculationVersion,
    firstDetectedAt: row.firstDetectedAt,
    lastEvaluatedAt: row.lastEvaluatedAt,
    resolvedAt: row.resolvedAt ?? undefined,
    interventions: JSON.parse(
      row.interventionsJson,
    ) as MissionIntervention[],
    recommendedPlan: JSON.parse(
      row.recommendedPlanJson,
    ) as RecommendedMissionPlan,
    revalidation: revalidationResult(
      missionType,
      row.baselineValue,
      row.currentValue,
    ),
  };
}

async function addMissionEvent(params: {
  missionId: string;
  eventType:
    | "detected"
    | "revalidated"
    | "reopened"
    | "resolved"
    | "suppressed"
    | "status_changed"
    | "action_recorded"
    | "scenario_revalidated";
  actorType?: "system" | "operator";
  note?: string;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db.insert(resilienceMissionEvents).values({
    missionId: params.missionId,
    eventType: params.eventType,
    actorType: params.actorType ?? "system",
    note: params.note ?? null,
    evidenceJson: JSON.stringify(params.evidence ?? {}),
  });
}

async function persistMissionCandidates(
  candidates: MissionCandidate[],
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    const existingRows = await db
      .select()
      .from(resilienceMissions)
      .where(eq(resilienceMissions.id, candidate.id))
      .limit(1);
    const existing = existingRows[0];
    const evidenceJson = JSON.stringify(candidate.evidence);
    const interventionsJson = JSON.stringify(
      candidate.interventions,
    );
    const recommendedPlanJson = JSON.stringify(
      candidate.recommendedPlan,
    );

    if (!candidate.active && !existing) continue;

    if (!existing) {
      await db.insert(resilienceMissions).values({
        id: candidate.id,
        regionCode: candidate.regionCode,
        districtCode: candidate.districtCode,
        missionType: candidate.missionType,
        failureCategory: candidate.failureCategory,
        status: "open",
        priority: candidate.priority,
        title: candidate.title,
        summary: candidate.summary,
        actionText: candidate.actionText,
        ownerOrganization:
          candidate.actionContract.ownerOrganization,
        ownerRole: candidate.actionContract.ownerRole,
        deadlineAt: candidate.actionContract.deadlineAt,
        successCondition:
          candidate.actionContract.successCondition,
        evidenceRequirement:
          candidate.actionContract.evidenceRequirement,
        scenarioJson: JSON.stringify(candidate.scenario),
        evidenceJson,
        interventionsJson,
        recommendedPlanJson,
        baselineValue: candidate.currentValue,
        currentValue: candidate.currentValue,
        sampleSize: candidate.sampleSize,
        minimumSampleSize: MINIMUM_BEHAVIOR_SAMPLE,
        privacyState: candidate.privacyState,
        policyBaseMonth: candidate.policyBaseMonth,
        calculationVersion: MISSION_CALCULATION_VERSION,
        firstDetectedAt: now,
        lastEvaluatedAt: now,
        updatedAt: now,
      });
      await addMissionEvent({
        missionId: candidate.id,
        eventType: "detected",
        evidence: candidate.evidence,
      });
      continue;
    }

    let nextStatus = existing.status;
    let eventType:
      | "revalidated"
      | "reopened"
      | "resolved"
      | "suppressed"
      | null = null;
    if (candidate.active) {
      if (
        existing.status === "resolved" ||
        existing.status === "suppressed"
      ) {
        nextStatus = "open";
        eventType = "reopened";
      } else if (
        existing.evidenceJson !== evidenceJson ||
        existing.currentValue !== candidate.currentValue
      ) {
        eventType =
          existing.status === "ready_for_recheck"
            ? null
            : "revalidated";
      }
    } else {
      if (candidate.inactiveStatus === "suppressed") {
        nextStatus = "suppressed";
        if (existing.status !== "suppressed") {
          eventType = "suppressed";
        }
      } else {
        // A scheduled data refresh may update the metric, but it must not
        // close an action contract. Resolution is reserved for the
        // authenticated, evidence-backed same-scenario rerun below.
        nextStatus = existing.status;
      }
    }

    await db
      .update(resilienceMissions)
      .set({
        status: nextStatus,
        failureCategory: candidate.failureCategory,
        priority: candidate.priority,
        title: candidate.title,
        summary: candidate.summary,
        actionText: candidate.actionText,
        ownerOrganization: existing.actionRecordedAt
          ? existing.ownerOrganization
          : candidate.actionContract.ownerOrganization,
        ownerRole: existing.actionRecordedAt
          ? existing.ownerRole
          : candidate.actionContract.ownerRole,
        deadlineAt: existing.actionRecordedAt
          ? existing.deadlineAt
          : candidate.actionContract.deadlineAt,
        successCondition: existing.actionRecordedAt
          ? existing.successCondition
          : candidate.actionContract.successCondition,
        evidenceRequirement: existing.actionRecordedAt
          ? existing.evidenceRequirement
          : candidate.actionContract.evidenceRequirement,
        scenarioJson: JSON.stringify(candidate.scenario),
        evidenceJson,
        interventionsJson,
        recommendedPlanJson,
        currentValue: candidate.currentValue,
        sampleSize: candidate.sampleSize,
        privacyState: candidate.privacyState,
        policyBaseMonth: candidate.policyBaseMonth,
        lastEvaluatedAt: now,
        resolvedAt:
          nextStatus === "resolved"
            ? existing.resolvedAt ?? now
            : null,
        updatedAt: now,
      })
      .where(eq(resilienceMissions.id, candidate.id));

    if (eventType) {
      await addMissionEvent({
        missionId: candidate.id,
        eventType,
        evidence: candidate.evidence,
      });
    }
  }
}

function computedMission(
  candidate: MissionCandidate,
): PublicMission | null {
  if (!candidate.active || candidate.privacyState === "below_threshold") {
    return null;
  }
  const now = new Date().toISOString();
  return {
    id: candidate.id,
    regionCode: candidate.regionCode,
    districtCode:
      candidate.districtCode === "_all"
        ? undefined
        : candidate.districtCode,
    missionType: candidate.missionType,
    status: "open",
    priority: candidate.priority,
    title: candidate.title,
    summary: candidate.summary,
    actionText: candidate.actionText,
    failureCategory: candidate.failureCategory,
    actionContract: candidate.actionContract,
    scenario: candidate.scenario,
    revalidationCount: 0,
    evidence: candidate.evidence,
    baselineValue: candidate.currentValue,
    currentValue: candidate.currentValue,
    sampleSize: candidate.sampleSize,
    minimumSampleSize: MINIMUM_BEHAVIOR_SAMPLE,
    privacyState: candidate.privacyState,
    policyBaseMonth: candidate.policyBaseMonth,
    calculationVersion: MISSION_CALCULATION_VERSION,
    firstDetectedAt: now,
    lastEvaluatedAt: now,
    interventions: candidate.interventions,
    recommendedPlan: candidate.recommendedPlan,
    revalidation: revalidationResult(
      candidate.missionType,
      candidate.currentValue,
      candidate.currentValue,
    ),
  };
}

export async function refreshResilienceMissions(
  payload: PolicyInsightPayload,
): Promise<MissionRefreshResult> {
  let aggregate = EMPTY_AGGREGATE;
  let databaseAvailable = true;
  try {
    aggregate = await loadRecoveryAggregate({
      areaCode: payload.areaCode,
      districtCode: payload.districtCode,
    });
  } catch {
    databaseAvailable = false;
  }

  const candidates = buildMissionCandidates(payload, aggregate);
  if (databaseAvailable) {
    try {
      await persistMissionCandidates(candidates);
      const page = await listResilienceMissions({
        areaCode: payload.areaCode,
        districtCode: payload.districtCode,
        includeResolved: true,
        limit: 20,
      });
      return {
        persistence: "persisted",
        privacyRule: {
          behaviorMinimumSample: MINIMUM_BEHAVIOR_SAMPLE,
          exactLocationUsed: false,
          belowThresholdPublished: false,
        },
        /* 페이지가 아니라 전체 집합의 상태 분포에서 센다. 20건에서 잘린
           목록으로 세면 활성 미션 수가 조용히 20으로 수렴한다. */
        activeCount:
          (page.byStatus.open ?? 0) +
          (page.byStatus.in_progress ?? 0) +
          (page.byStatus.ready_for_recheck ?? 0),
        missions: page.missions,
      };
    } catch {
      databaseAvailable = false;
    }
  }

  const computed = candidates
    .map(computedMission)
    .filter((mission): mission is PublicMission => Boolean(mission));
  return {
    persistence: "db_unavailable",
    privacyRule: {
      behaviorMinimumSample: MINIMUM_BEHAVIOR_SAMPLE,
      exactLocationUsed: false,
      belowThresholdPublished: false,
    },
    activeCount: computed.length,
    missions: computed,
  };
}

export const MISSION_PAGE_MAX = 200;

export type MissionPage = {
  missions: PublicMission[];
  /* 필터 조건을 만족하는 **전체** 건수. 한 페이지의 길이가 아니다. */
  total: number;
  /* 전체 집합에 대한 상태별 분포. 페이지에서 센 값이 아니다. */
  byStatus: Record<string, number>;
  pageSize: number;
  truncated: boolean;
  nextCursor: string | null;
};

/* 정렬 키를 그대로 담은 커서. offset을 쓰면 크론이 페이지 사이에 미션을
   갱신할 때 같은 항목이 두 번 나오거나 건너뛰어진다. */
function encodeMissionCursor(row: {
  priority: number;
  lastEvaluatedAt: string;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify([row.priority, row.lastEvaluatedAt, row.id]),
    "utf8",
  ).toString("base64url");
}

export function decodeMissionCursor(
  value: string,
): { priority: number; lastEvaluatedAt: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== "number" ||
      !Number.isInteger(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string"
    ) {
      return null;
    }
    return {
      priority: parsed[0],
      lastEvaluatedAt: parsed[1],
      id: parsed[2],
    };
  } catch {
    return null;
  }
}

/* 회복력 미션 목록의 한 페이지.
 *
 * 예전 구현은 배열만 돌려주고 라우트가 `missionCount: missions.length`로
 * 공표했다. 기본 호출이 100건에서 잘리고 상한이 200건이므로, 전국 미션이
 * 그보다 많아지는 순간 화면과 API가 잘린 페이지 길이를 전국 총계로 발표하게
 * 된다. 상태별 분포도 같은 페이지에서 세고 있어 함께 틀어진다. 기획 15.7이
 * 금지한 형태의 숫자다 — 값이 틀린 것을 넘어, 틀렸다는 사실이 응답 어디에도
 * 드러나지 않는다는 점이 문제다. 총계와 분포는 전체 집합에서 세고, 잘렸다는
 * 사실과 이어 받을 커서를 함께 돌려준다. */
export async function listResilienceMissions(params: {
  areaCode?: string;
  districtCode?: string;
  status?: string;
  includeResolved?: boolean;
  limit?: number;
  cursor?: string;
} = {}): Promise<MissionPage> {
  const db = getDb();
  const filters = [ne(resilienceMissions.status, "suppressed")];
  if (params.areaCode) {
    filters.push(eq(resilienceMissions.regionCode, params.areaCode));
  }
  if (params.districtCode) {
    filters.push(
      eq(resilienceMissions.districtCode, params.districtCode),
    );
  }
  if (params.status) {
    filters.push(eq(resilienceMissions.status, params.status));
  } else if (!params.includeResolved) {
    filters.push(ne(resilienceMissions.status, "resolved"));
    filters.push(ne(resilienceMissions.status, "dismissed"));
  }

  const pageSize = Math.min(
    Math.max(
      Number.isInteger(params.limit) ? (params.limit as number) : 100,
      1,
    ),
    MISSION_PAGE_MAX,
  );

  /* 커서는 총계·분포에는 적용하지 않는다. 이어 받는 페이지에서도 전체
     숫자는 같아야 한다. */
  const scope = and(...filters);
  const cursor = params.cursor
    ? decodeMissionCursor(params.cursor)
    : null;
  const pageWhere = cursor
    ? and(
        scope,
        or(
          lt(resilienceMissions.priority, cursor.priority),
          and(
            eq(resilienceMissions.priority, cursor.priority),
            lt(resilienceMissions.lastEvaluatedAt, cursor.lastEvaluatedAt),
          ),
          and(
            eq(resilienceMissions.priority, cursor.priority),
            eq(resilienceMissions.lastEvaluatedAt, cursor.lastEvaluatedAt),
            gt(resilienceMissions.id, cursor.id),
          ),
        ),
      )
    : scope;

  const [rows, totalRows, statusRows] = await Promise.all([
    db
      .select()
      .from(resilienceMissions)
      .where(pageWhere)
      .orderBy(
        desc(resilienceMissions.priority),
        desc(resilienceMissions.lastEvaluatedAt),
        /* 같은 우선순위·같은 평가시각에서 순서가 흔들리면 커서가 항목을
           건너뛴다. */
        asc(resilienceMissions.id),
      )
      /* 다음 페이지가 있는지 알기 위해 한 건 더 읽는다. */
      .limit(pageSize + 1),
    db
      .select({ value: count() })
      .from(resilienceMissions)
      .where(scope),
    db
      .select({
        status: resilienceMissions.status,
        value: count(),
      })
      .from(resilienceMissions)
      .where(scope)
      .groupBy(resilienceMissions.status),
  ]);

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const missions = pageRows
    .map(asPublicMission)
    .filter((mission): mission is PublicMission => Boolean(mission));
  const lastRow = pageRows[pageRows.length - 1];

  return {
    missions,
    total: totalRows[0]?.value ?? 0,
    byStatus: Object.fromEntries(
      statusRows.map((row) => [row.status, row.value]),
    ),
    pageSize,
    truncated: hasMore,
    nextCursor: hasMore && lastRow ? encodeMissionCursor(lastRow) : null,
  };
}

export async function getResilienceMission(
  missionIdValue: string,
): Promise<PublicMission | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(resilienceMissions)
    .where(eq(resilienceMissions.id, missionIdValue))
    .limit(1);
  return rows[0] ? asPublicMission(rows[0]) : null;
}

export class MissionWorkflowError extends Error {
  readonly code:
    | "ACTION_EVIDENCE_REQUIRED"
    | "MISSION_NOT_READY"
    | "SCENARIO_MISMATCH";

  constructor(
    code:
      | "ACTION_EVIDENCE_REQUIRED"
      | "MISSION_NOT_READY"
      | "SCENARIO_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "MissionWorkflowError";
    this.code = code;
  }
}

export function isSameMissionScenario(
  stored: MissionScenario,
  candidate: MissionScenario,
): boolean {
  return (
    stored.id === candidate.id &&
    stored.scope.areaCode === candidate.scope.areaCode &&
    stored.scope.districtCode === candidate.scope.districtCode &&
    stored.missionType === candidate.missionType &&
    stored.parameters.failureCategory ===
      candidate.parameters.failureCategory &&
    stored.calculationVersion === candidate.calculationVersion &&
    stored.evaluator.metric === candidate.evaluator.metric &&
    stored.evaluator.observationWindow ===
      candidate.evaluator.observationWindow
  );
}

export async function updateMissionWorkflow(params: {
  missionId: string;
  status: "open" | "in_progress" | "ready_for_recheck" | "dismissed";
  note: string;
  actionContract?: MissionActionContract;
  actionEvidence?: MissionActionEvidence;
}): Promise<PublicMission | null> {
  const db = getDb();
  const currentRows = await db
    .select()
    .from(resilienceMissions)
    .where(eq(resilienceMissions.id, params.missionId))
    .limit(1);
  const current = currentRows[0];
  if (!current || current.status === "suppressed") return null;

  const updatedAt = new Date().toISOString();
  const existingEvidence = storedActionEvidence(
    current.actionEvidenceJson,
  );
  const nextEvidence = params.actionEvidence ?? existingEvidence;
  if (params.status === "ready_for_recheck" && !nextEvidence) {
    throw new MissionWorkflowError(
      "ACTION_EVIDENCE_REQUIRED",
      "조치 내용과 증빙을 먼저 기록해야 동일 시나리오 재검증을 요청할 수 있습니다.",
    );
  }
  const nextContract = params.actionContract ?? {
    ownerOrganization: current.ownerOrganization,
    ownerRole: current.ownerRole,
    deadlineAt: current.deadlineAt,
    successCondition: current.successCondition,
    evidenceRequirement: current.evidenceRequirement,
  };
  await db
    .update(resilienceMissions)
    .set({
      status: params.status,
      ownerOrganization: nextContract.ownerOrganization,
      ownerRole: nextContract.ownerRole,
      deadlineAt: nextContract.deadlineAt,
      successCondition: nextContract.successCondition,
      evidenceRequirement: nextContract.evidenceRequirement,
      actionEvidenceJson: nextEvidence
        ? JSON.stringify(nextEvidence)
        : current.actionEvidenceJson,
      actionRecordedAt: params.actionEvidence
        ? updatedAt
        : current.actionRecordedAt,
      resolvedAt: null,
      updatedAt,
    })
    .where(eq(resilienceMissions.id, params.missionId));
  if (params.actionEvidence) {
    await addMissionEvent({
      missionId: params.missionId,
      eventType: "action_recorded",
      actorType: "operator",
      note: params.actionEvidence.actionSummary,
      evidence: {
        artifactReferences:
          params.actionEvidence.artifactReferences,
        occurredAt: params.actionEvidence.occurredAt,
        recordedBy: params.actionEvidence.recordedBy,
        contract: nextContract,
      },
    });
  }
  await addMissionEvent({
    missionId: params.missionId,
    eventType: "status_changed",
    actorType: "operator",
    note: params.note,
    evidence: {
      previousStatus: current.status,
      nextStatus: params.status,
    },
  });
  return getResilienceMission(params.missionId);
}

export async function revalidateMissionScenario(
  missionIdValue: string,
  payload: PolicyInsightPayload,
  note = "운영자 승인 후 동일 시나리오 재검증",
): Promise<MissionScenarioRevalidation | null> {
  const db = getDb();
  const currentRows = await db
    .select()
    .from(resilienceMissions)
    .where(eq(resilienceMissions.id, missionIdValue))
    .limit(1);
  const current = currentRows[0];
  if (!current || current.status === "suppressed") return null;
  if (current.status !== "ready_for_recheck") {
    throw new MissionWorkflowError(
      "MISSION_NOT_READY",
      "조치 증빙을 기록하고 미션을 재검증 대기 상태로 전환한 뒤 실행해주세요.",
    );
  }
  const actionEvidence = storedActionEvidence(
    current.actionEvidenceJson,
  );
  if (!actionEvidence || !current.actionRecordedAt) {
    throw new MissionWorkflowError(
      "ACTION_EVIDENCE_REQUIRED",
      "동일 시나리오 재검증 전에 실제 조치와 증빙을 기록해야 합니다.",
    );
  }
  if (
    payload.areaCode !== current.regionCode ||
    scopeDistrict(payload.districtCode) !== current.districtCode
  ) {
    throw new MissionWorkflowError(
      "SCENARIO_MISMATCH",
      "저장된 미션과 다른 지역 조건으로는 재검증할 수 없습니다.",
    );
  }

  const aggregate = await loadRecoveryAggregate({
    areaCode: current.regionCode,
    districtCode:
      current.districtCode === "_all"
        ? undefined
        : current.districtCode,
  });
  const candidate = buildMissionCandidates(payload, aggregate).find(
    (entry) => entry.id === current.id,
  );
  if (!candidate) {
    throw new MissionWorkflowError(
      "SCENARIO_MISMATCH",
      "저장된 평가 규칙과 같은 시나리오를 구성하지 못했습니다.",
    );
  }
  const scenario = storedScenario(
    current,
    current.missionType as MissionCandidate["missionType"],
  );
  if (!isSameMissionScenario(scenario, candidate.scenario)) {
    throw new MissionWorkflowError(
      "SCENARIO_MISMATCH",
      "미션 생성 규칙이 변경되어 동일 시나리오로 비교할 수 없습니다.",
    );
  }

  const evaluatedAt = new Date().toISOString();
  const comparable =
    candidate.privacyState !== "below_threshold";
  const comparison = comparable
    ? revalidationResult(
        candidate.missionType,
        current.baselineValue,
        candidate.currentValue,
      )
    : {
        baselineValue: current.baselineValue,
        currentValue: null,
        delta: null,
        result: "not_comparable" as const,
      };
  const nextStatus: PublicMission["status"] = comparable
    ? candidate.active
      ? "open"
      : "resolved"
    : "ready_for_recheck";

  await db
    .update(resilienceMissions)
    .set({
      status: nextStatus,
      priority: candidate.priority,
      title: candidate.title,
      summary: candidate.summary,
      actionText: candidate.actionText,
      failureCategory: candidate.failureCategory,
      scenarioJson: JSON.stringify(candidate.scenario),
      evidenceJson: comparable
        ? JSON.stringify(candidate.evidence)
        : current.evidenceJson,
      interventionsJson: JSON.stringify(candidate.interventions),
      recommendedPlanJson: JSON.stringify(
        candidate.recommendedPlan,
      ),
      currentValue: comparable
        ? candidate.currentValue
        : current.currentValue,
      sampleSize: comparable ? candidate.sampleSize : current.sampleSize,
      privacyState: comparable
        ? candidate.privacyState
        : current.privacyState,
      policyBaseMonth: candidate.policyBaseMonth,
      lastEvaluatedAt: evaluatedAt,
      lastRevalidatedAt: evaluatedAt,
      lastRevalidationResult: comparison.result,
      revalidationCount: current.revalidationCount + 1,
      resolvedAt: nextStatus === "resolved" ? evaluatedAt : null,
      updatedAt: evaluatedAt,
    })
    .where(eq(resilienceMissions.id, current.id));

  await addMissionEvent({
    missionId: current.id,
    eventType: "scenario_revalidated",
    actorType: "operator",
    note,
    evidence: {
      scenario,
      sameScenario: true,
      actionEvidence,
      previousStatus: current.status,
      nextStatus,
      baselineValue: current.baselineValue,
      evaluatedValue: comparable ? candidate.currentValue : null,
      result: comparison.result,
    },
  });

  const mission = await getResilienceMission(current.id);
  if (!mission) {
    throw new Error("Revalidated mission could not be loaded.");
  }
  return {
    mission,
    receipt: {
      scenarioId: scenario.id,
      sameScenario: true,
      previousStatus: current.status,
      nextStatus,
      baselineValue: current.baselineValue,
      evaluatedValue: comparable ? candidate.currentValue : null,
      result: comparison.result,
      evaluatedAt,
    },
  };
}
