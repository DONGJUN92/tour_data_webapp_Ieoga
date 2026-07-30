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

export function buildLaunchEvidenceReport(params: {
  ktoConfigured: boolean;
  d1Ready: boolean;
  r2Ready: boolean;
  sourceHealthCount: number;
  sourceHealthErrorCount: number;
  sourceHealthStale: boolean;
  providers: ExternalProviderStatus;
}): LaunchEvidenceReport {
  const managedProvidersReady = Object.values(params.providers).every(
    (mode) => mode === "managed",
  );
  const eightKtoSourcesReady =
    params.ktoConfigured &&
    params.sourceHealthCount >= 8 &&
    params.sourceHealthErrorCount === 0 &&
    !params.sourceHealthStale;
  const platformReady = params.d1Ready && params.r2Ready;

  const items: LaunchEvidenceItem[] = [
    {
      id: "journey_completion_contract",
      title: "복구 적용부터 원래 여행 완주까지",
      status: "verified",
      evidence:
        "불변 복구 버전, 순차 도착 확인, 다음 예약 계약 충족, 남은 원래 일정 완주를 서버가 저장합니다.",
    },
    {
      id: "travel_purpose_preservation",
      title: "장소가 아닌 여행 목적 보존",
      status: "verified",
      evidence:
        "한국관광공사 연계 방문 순위와 관광 콘텐츠 유형으로 원래 활동과 다른 후보를 제외합니다.",
    },
    {
      id: "first_time_location_ux",
      title: "위·경도 입력 없는 첫 사용 흐름",
      status: "verified",
      evidence:
        "위치 허용 시 자동 입력하고, 거부 시 장소명·주소 검색으로 동일 흐름을 이어갑니다.",
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
        ? "정방향·역방향 지오코딩, 보행 경로, 날씨가 관리형 제공자로 구성되었습니다."
        : "공용 공유 엔드포인트가 남아 있어 상용 트래픽 SLA를 보장할 수 없습니다.",
      nextAction: managedProvidersReady
        ? undefined
        : "관리형 또는 자체 운영 지오코딩·경로·날씨 엔드포인트를 연결하세요.",
    },
    {
      id: "tripbreak_100",
      title: "K-TRIPBREAK 100 실전 중단 시나리오",
      status: "needs_field_evidence",
      evidence:
        "코드 경로 테스트는 통과했지만 전국 100개 실전 시나리오의 성공·실패 원장 근거는 아직 등록되지 않았습니다.",
      nextAction:
        "지역·시간·문제유형·고정예약 조합 100건을 실행하고 오추천과 실패 원인을 기록하세요.",
    },
    {
      id: "first_time_users_20",
      title: "초기 사용자 20명 무도움 과업 성공",
      status: "needs_field_evidence",
      evidence:
        "시뮬레이션 가이드는 구현됐지만 실제 초행 사용자 과업 성공률 근거는 아직 없습니다.",
      nextAction:
        "20명이 도움 없이 일정 등록→복구 적용→도착→완주하는지 측정하세요.",
    },
    {
      id: "tourism_reviewers_3",
      title: "관광 현장·지자체 실무자 3인 검토",
      status: "needs_field_evidence",
      evidence:
        "4대 실패유형 실행계약과 동일 시나리오 재검증은 구현됐지만 현장 조치 가능성 검토 서명은 아직 없습니다.",
      nextAction:
        "관광안내·지자체·관광사업자 각 1인 이상에게 조치 가능성과 책임주체를 검증받으세요.",
    },
    {
      id: "six_region_field_audit",
      title: "수도권·광역시·도서산간 포함 6개 권역 현장 점검",
      status: "needs_field_evidence",
      evidence:
        "전국 코드와 검색 범위는 지원하지만 서로 다른 이동·데이터 환경의 현장 점검표는 아직 없습니다.",
      nextAction:
        "최소 6개 권역에서 장소검색, 경로, 영업정보, 도착 계약을 실제 이동으로 확인하세요.",
    },
    {
      id: "recovery_speed_and_false_positive",
      title: "복구 중앙값 5초 이내·치명적 오추천 0건",
      status: "needs_field_evidence",
      evidence:
        "서버 응답 예산은 설정됐지만 실사용 기기·통신망 기준 성능과 오추천 감사표가 아직 없습니다.",
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
