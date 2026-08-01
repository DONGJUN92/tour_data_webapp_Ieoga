import type { ExternalProviderStatus } from "@/lib/runtime-readiness";

export type LaunchEvidenceStatus =
  | "verified"
  | "needs_field_evidence"
  | "release_blocker";

export type LaunchEvidenceItem = {
  id: string;
  title: string;
  status: LaunchEvidenceStatus;
  evidence: string;
  nextAction?: string;
};

export type LaunchEvidenceReport = {
  overall: "ready" | "evidence_collection" | "blocked";
  verifiedCount: number;
  totalCount: number;
  items: LaunchEvidenceItem[];
  generatedAt: string;
};

export const FIELD_EVIDENCE_TYPES = [
  "journey_completion_contract",
  "travel_purpose_preservation",
  "first_time_location_ux",
  "tripbreak_100",
  "first_time_users_20",
  "tourism_reviewers_3",
  "six_region_field_audit",
  "recovery_speed_and_false_positive",
] as const;

export type FieldEvidenceType =
  (typeof FIELD_EVIDENCE_TYPES)[number];

export type FieldEvidenceSummary = {
  evidenceType: FieldEvidenceType;
  validated: boolean;
  independentAuditStatus: "pending" | "approved" | "rejected";
  sampleSize: number;
  regionCount: number;
  reviewerCount: number;
  measuredAt: string;
  approvedAt?: string;
};

export function buildLaunchEvidenceReport(params: {
  ktoConfigured: boolean;
  d1Ready: boolean;
  r2Ready: boolean;
  sourceHealthCount: number;
  sourceHealthErrorCount: number;
  sourceHealthStale: boolean;
  providers: ExternalProviderStatus;
  providerProbesReady: boolean;
  sessionSigningReady: boolean;
  independentAuditorReady: boolean;
  releaseSecretsReady: boolean;
  fieldEvidence?: Partial<
    Record<FieldEvidenceType, FieldEvidenceSummary>
  >;
}): LaunchEvidenceReport {
  const managedProvidersReady =
    Object.values(params.providers).every((mode) => mode === "managed") &&
    params.providerProbesReady;
  const eightKtoSourcesReady =
    params.ktoConfigured &&
    params.sourceHealthCount >= 8 &&
    params.sourceHealthErrorCount === 0 &&
    !params.sourceHealthStale;
  const platformReady = params.d1Ready && params.r2Ready;
  const fieldStatus = (
    id: FieldEvidenceType,
  ): LaunchEvidenceStatus =>
    params.fieldEvidence?.[id]?.validated &&
    params.fieldEvidence?.[id]?.independentAuditStatus === "approved"
      ? "verified"
      : "needs_field_evidence";
  const fieldSummary = (
    id: FieldEvidenceType,
    missingEvidence: string,
  ): string => {
    const evidence = params.fieldEvidence?.[id];
    return evidence
      ? evidence.independentAuditStatus === "approved"
        ? `독립 감사 승인 증거: 표본 ${evidence.sampleSize}건, 지역 ${evidence.regionCount}곳, 검토자 ${evidence.reviewerCount}명, 측정일 ${evidence.measuredAt}, 승인일 ${evidence.approvedAt ?? "미기록"}.`
        : `증거가 등록되었지만 독립 감사 상태는 ${evidence.independentAuditStatus}입니다. 승인 전에는 검증 완료로 계산하지 않습니다.`
      : missingEvidence;
  };

  const items: LaunchEvidenceItem[] = [
    {
      id: "journey_completion_contract",
      title: "복구 적용부터 원래 여행 완주까지",
      status: fieldStatus("journey_completion_contract"),
      evidence: fieldSummary(
        "journey_completion_contract",
        "서버 계약 코드는 존재하지만 실제 브라우저에서 적용·길찾기·도착·원래 일정 복귀를 완주한 인증 증거가 아직 없습니다.",
      ),
    },
    {
      id: "travel_purpose_preservation",
      title: "장소가 아닌 여행 목적 보존",
      status: fieldStatus("travel_purpose_preservation"),
      evidence: fieldSummary(
        "travel_purpose_preservation",
        "연계 방문 순위와 콘텐츠 유형 규칙은 구현됐지만 실제 시나리오에서 목적 보존을 검토한 인증 증거가 아직 없습니다.",
      ),
    },
    {
      id: "first_time_location_ux",
      title: "위·경도 입력 없는 첫 사용 흐름",
      status: fieldStatus("first_time_location_ux"),
      evidence: fieldSummary(
        "first_time_location_ux",
        "위치 허용·거부·직접 검색을 실제 초행 사용자와 브라우저에서 통과한 인증 증거가 아직 없습니다.",
      ),
    },
    {
      id: "platform_runtime",
      title: "영속 DB·지역 증거 저장소",
      status: platformReady ? "verified" : "release_blocker",
      evidence: platformReady
        ? "D1과 R2 런타임 바인딩이 준비되었습니다."
        : "현재 런타임에서 D1 또는 R2 바인딩이 준비되지 않았습니다.",
      nextAction: platformReady
        ? undefined
        : "배포 환경의 D1·R2 바인딩과 마이그레이션을 확인하세요.",
    },
    {
      id: "stable_session_signing",
      title: "Stable anonymous-session signing",
      status: params.sessionSigningReady ? "verified" : "release_blocker",
      evidence: params.sessionSigningReady
        ? "A dedicated SESSION_SIGNING_KEY meets the server-enforced minimum quality and separation policy."
        : "A dedicated SESSION_SIGNING_KEY does not meet the server-enforced minimum quality and separation policy.",
      nextAction: params.sessionSigningReady
        ? undefined
        : "Configure a distinct CSPRNG-generated SESSION_SIGNING_KEY before release.",
    },
    {
      id: "release_secret_separation",
      title: "출시용 인증키 최소 품질과 권한 분리",
      status: params.releaseSecretsReady
        ? "verified"
        : "release_blocker",
      evidence: params.releaseSecretsReady
        ? "출시용 인증키 4개가 32바이트 이상이며 placeholder·낮은 문자 다양성·반복 패턴 차단 정책을 통과하고 모두 서로 다릅니다."
        : "출시용 인증키 4개의 서버 검증 가능 최소 품질과 상호 분리가 충족되지 않았습니다.",
      nextAction: params.releaseSecretsReady
        ? undefined
        : "4개 인증키를 각각 CSPRNG로 독립 생성해 서로 다른 배포 Secret으로 교체하세요. 서버 정책은 실제 엔트로피를 증명하지 않으므로 생성 절차도 별도로 확인해야 합니다.",
    },
    {
      id: "independent_field_evidence_auditor",
      title: "현장 증거 제출자와 독립 감사 승인자 분리",
      status: params.independentAuditorReady
        ? "verified"
        : "release_blocker",
      evidence: params.independentAuditorReady
        ? "OPS 제출 토큰과 다르고 최소 품질 정책을 통과한 RELEASE_AUDITOR_API_KEY가 구성되었습니다."
        : "독립 감사 키가 없거나 짧거나 OPS 토큰과 동일해 제출과 승인을 분리할 수 없습니다.",
      nextAction: params.independentAuditorReady
        ? undefined
        : "OPS_API_KEY와 다른 RELEASE_AUDITOR_API_KEY를 구성하고 독립 감사자가 증거를 승인하세요.",
    },
    {
      id: "eight_kto_openapis",
      title: "한국관광공사 OpenAPI 8종 실가동",
      status: eightKtoSourcesReady ? "verified" : "release_blocker",
      evidence: eightKtoSourcesReady
        ? "8종 모두 최신 운영 점검에서 오류 없이 확인되었습니다."
        : `현재 최신 정상 점검 근거는 ${params.sourceHealthCount}/8종입니다.`,
      nextAction: eightKtoSourcesReady
        ? undefined
        : "운영자 동기화를 실행해 8종의 최신 상태와 기준시점을 저장하세요.",
    },
    {
      id: "managed_external_providers",
      title: "출시용 지도·경로·날씨 제공자",
      status: managedProvidersReady ? "verified" : "release_blocker",
      evidence: managedProvidersReady
        ? "정방향·역방향 지오코딩, 보행 경로, 날씨의 관리형 제공자가 최근 실제 응답 계약 점검을 통과했습니다."
        : "공용 공유 엔드포인트가 남아 있거나 관리형 제공자의 최근 실제 응답 계약 점검 근거가 없습니다.",
      nextAction: managedProvidersReady
        ? undefined
        : "관리형 또는 자체 운영 엔드포인트를 연결한 뒤 인증된 제공자 실호출 점검을 통과시키세요.",
    },
    {
      id: "tripbreak_100",
      title: "K-TRIPBREAK 100 실전 중단 시나리오",
      status: fieldStatus("tripbreak_100"),
      evidence: fieldSummary(
        "tripbreak_100",
        "코드 경로 테스트는 통과했지만 전국 100개 실전 시나리오의 성공·실패 원장 근거는 아직 등록되지 않았습니다.",
      ),
      nextAction:
        "지역·시간·문제유형·고정예약 조합 100건을 실행하고 오추천과 실패 원인을 기록하세요.",
    },
    {
      id: "first_time_users_20",
      title: "초기 사용자 20명 무도움 과업 성공",
      status: fieldStatus("first_time_users_20"),
      evidence: fieldSummary(
        "first_time_users_20",
        "시뮬레이션 가이드는 구현됐지만 실제 초행 사용자 과업 성공률 근거는 아직 없습니다.",
      ),
      nextAction:
        "20명이 도움 없이 일정 등록→복구 적용→도착→완주하는지 측정하세요.",
    },
    {
      id: "tourism_reviewers_3",
      title: "관광 현장·지자체 실무자 3인 검토",
      status: fieldStatus("tourism_reviewers_3"),
      evidence: fieldSummary(
        "tourism_reviewers_3",
        "4대 실패유형 실행계약과 동일 시나리오 재검증은 구현됐지만 현장 조치 가능성 검토 서명은 아직 없습니다.",
      ),
      nextAction:
        "관광안내·지자체·관광사업자 각 1인 이상에게 조치 가능성과 책임주체를 검증받으세요.",
    },
    {
      id: "six_region_field_audit",
      title: "수도권·광역시·도서산간 포함 6개 권역 현장 점검",
      status: fieldStatus("six_region_field_audit"),
      evidence: fieldSummary(
        "six_region_field_audit",
        "전국 코드와 검색 범위는 지원하지만 서로 다른 이동·데이터 환경의 현장 점검표는 아직 없습니다.",
      ),
      nextAction:
        "최소 6개 권역에서 장소검색, 경로, 영업정보, 도착 계약을 실제 이동으로 확인하세요.",
    },
    {
      id: "recovery_speed_and_false_positive",
      title: "복구 중앙값 5초 이내·치명적 오추천 0건",
      status: fieldStatus("recovery_speed_and_false_positive"),
      evidence: fieldSummary(
        "recovery_speed_and_false_positive",
        "서버 응답 예산은 설정됐지만 실사용 기기·통신망 기준 성능과 오추천 감사표가 아직 없습니다.",
      ),
      nextAction:
        "100개 시나리오에서 중앙값·p95와 폐업, 목적불일치, 예약미도착 오추천을 함께 측정하세요.",
    },
  ];

  const hasBlocker = items.some((item) => item.status === "release_blocker");
  const needsEvidence = items.some(
    (item) => item.status === "needs_field_evidence",
  );
  return {
    overall: hasBlocker
      ? "blocked"
      : needsEvidence
        ? "evidence_collection"
        : "ready",
    verifiedCount: items.filter((item) => item.status === "verified").length,
    totalCount: items.length,
    items,
    generatedAt: new Date().toISOString(),
  };
}
