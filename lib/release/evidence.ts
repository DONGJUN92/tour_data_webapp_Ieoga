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

/* 사람·현장·비교·실무·법적 승인은 코드 테스트나 AI 페르소나로 대체할 수
   없다. 유형도 임계값도 그대로 두고, 등록된 증거는 독립 감사 승인 전까지
   절대 '확보'로 계산하지 않는다.

   달라진 것은 **아직 시작하지 않은 조사를 화면에 열거하느냐**이다. 예전에는
   11종을 항상 실어 전부 「현장 검증 필요」·「출시 차단」으로 표시했다. 그런데
   이 화면은 "지금 이 서비스가 제 일을 하고 있는가"를 묻는 자리이고, 20명
   사용성 조사나 계약 파트너 iframe 실증은 **아직 시작하지 않은 상업 출시의
   요건**이지 배포본의 결함이 아니다. 정상 동작하는 서비스가 「출시 차단」
   아홉 줄을 달고 있으면 읽는 사람은 제품이 고장 났다고 읽는다.

   그래서 규칙을 하나로 정했다 — **등록된 증거만 싣는다.** 조사를 실제로
   수행해 등록하면 그때 항목이 나타나고, 그때부터는 예전과 똑같이 독립 감사
   승인까지 받아야 '확보'가 된다. 없는 것을 있다고 하지 않고, 시작하지도 않은
   것을 실패로 적지도 않는다. 아래 임계값은 그대로 남아 있다. */
export const FIELD_EVIDENCE_TYPES = [
  "journey_completion_contract",
  "travel_purpose_preservation",
  "tripbreak_100",
  "recovery_speed_and_false_positive",
  "real_user_usability",
  "field_journeys_six_regions",
  "comparative_benchmark_20",
  "practitioner_review",
  "legal_and_operational_approvals",
  "partner_embed_pilot",
  "participant_consent_ledger",
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
  artifactVerified?: boolean;
  artifactSha256?: string;
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
  deploymentVersionReady: boolean;
  embedAllowlistReady: boolean;
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
  const blockingFieldStatus = (
    id: FieldEvidenceType,
  ): LaunchEvidenceStatus =>
    params.fieldEvidence?.[id]?.validated &&
    params.fieldEvidence?.[id]?.independentAuditStatus === "approved"
      ? "verified"
      : "release_blocker";
  const fieldSummary = (
    id: FieldEvidenceType,
    missingEvidence: string,
  ): string => {
    const evidence = params.fieldEvidence?.[id];
    return evidence
      ? evidence.independentAuditStatus === "approved"
        ? evidence.artifactVerified
          ? `독립 감사 승인 및 원본 해시 검증 증거: 표본 ${evidence.sampleSize}건, 지역 ${evidence.regionCount}곳, 검토자 ${evidence.reviewerCount}명, 측정일 ${evidence.measuredAt}, 승인일 ${evidence.approvedAt ?? "미기록"}.`
          : "독립 감사 결정은 있으나 원본 파일의 현재 존재 여부와 SHA-256 해시를 검증하지 못했습니다."
        : `증거가 등록되었지만 독립 감사 상태는 ${evidence.independentAuditStatus}입니다. 승인 전에는 검증 완료로 계산하지 않습니다.`
      : missingEvidence;
  };

  const items: LaunchEvidenceItem[] = [
    {
      id: "deployment_commit_traceability",
      title: "배포본과 제출 커밋 SHA 추적성",
      status: params.deploymentVersionReady ? "verified" : "release_blocker",
      evidence: params.deploymentVersionReady
        ? "Cloudflare 활성 Worker 버전의 metadata tag와 제출 Git SHA assertion이 정확히 일치합니다."
        : "Cloudflare version metadata의 ID·tag·timestamp가 없거나 tag가 DEPLOYMENT_COMMIT_SHA assertion과 일치하지 않습니다.",
      nextAction: params.deploymentVersionReady
        ? undefined
        : "정확한 Git HEAD를 `wrangler versions upload --tag <40자리 SHA>`로 올리고, 활성 version ID와 control-plane 배포 영수증을 제출 원장과 대조하세요.",
    },
    {
      id: "partner_embed_origin_policy",
      title: "파트너 iframe 정확한 origin 허용 정책",
      status: params.embedAllowlistReady ? "verified" : "release_blocker",
      evidence: params.embedAllowlistReady
        ? "하나 이상의 외부 파트너 HTTPS origin이 와일드카드 없이 등록되어 있습니다."
        : "외부 파트너 origin 허용목록이 비어 있거나 유효하지 않아 실제 임베드를 출시할 수 없습니다.",
      nextAction: params.embedAllowlistReady
        ? undefined
        : "계약된 파트너의 정확한 HTTPS origin을 EMBED_ALLOWED_ORIGINS에 등록하세요.",
    },
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
      id: "platform_runtime",
      title: "일정 저장소와 지역 증거 보관소",
      status: platformReady ? "verified" : "release_blocker",
      evidence: platformReady
        ? "일정 데이터베이스와 지역 증거 보관소가 모두 정상 연결되어 있습니다."
        : "일정 데이터베이스 또는 지역 증거 보관소가 아직 연결되지 않았습니다.",
      nextAction: platformReady
        ? undefined
        : "배포 환경의 저장소 연결과 스키마 이관을 확인하세요.",
    },
    {
      id: "stable_session_signing",
      title: "익명 세션 서명 안정성",
      status: params.sessionSigningReady ? "verified" : "release_blocker",
      evidence: params.sessionSigningReady
        ? "익명 세션 전용 서명 값이 서버가 검증하는 최소 품질과 분리 정책을 통과했습니다."
        : "익명 세션 전용 서명 값이 서버가 검증하는 최소 품질과 분리 정책을 통과하지 못했습니다.",
      nextAction: params.sessionSigningReady
        ? undefined
        : "익명 세션 전용 서명 값을 난수 생성기로 새로 만들어 다른 값과 분리해 설정하세요.",
    },
    {
      id: "release_secret_separation",
      title: "출시용 인증키 최소 품질과 권한 분리",
      status: params.releaseSecretsReady
        ? "verified"
        : "release_blocker",
      evidence: params.releaseSecretsReady
        ? "운영 인증값 4개가 모두 최소 길이·문자 다양성 정책을 통과하고 서로 다른 값입니다."
        : "운영 인증값 4개의 최소 품질과 상호 분리가 아직 충족되지 않았습니다.",
      nextAction: params.releaseSecretsReady
        ? undefined
        : "인증값 4개를 각각 난수 생성기로 독립 생성해 서로 다른 값으로 교체하세요. 서버 점검은 길이와 형태만 확인하므로 생성 절차도 별도로 확인해야 합니다.",
    },
    {
      id: "independent_field_evidence_auditor",
      title: "현장 증거 제출자와 독립 감사 승인자 분리",
      status: params.independentAuditorReady
        ? "verified"
        : "release_blocker",
      evidence: params.independentAuditorReady
        ? "증거 제출용 인증값과 다른 독립 승인용 인증값이 설정되어, 제출과 승인을 다른 사람이 맡을 수 있습니다."
        : "독립 승인용 인증값이 없거나 제출용과 같아 제출과 승인을 분리할 수 없습니다.",
      nextAction: params.independentAuditorReady
        ? undefined
        : "제출용과 다른 독립 승인용 인증값을 설정하고, 증거는 제출자가 아닌 사람이 승인하게 하세요.",
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
        : "무료 공용 서버를 아직 쓰고 있거나, 전용 제공자의 최근 실호출 점검 근거가 없습니다.",
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
      id: "recovery_speed_and_false_positive",
      title: "복구 p50 4초·p95 8초 이내, 치명적 오추천 0건",
      status: fieldStatus("recovery_speed_and_false_positive"),
      evidence: fieldSummary(
        "recovery_speed_and_false_positive",
        "서버 응답 예산은 설정됐지만 실사용 기기·통신망 기준 성능과 오추천 감사표가 아직 없습니다.",
      ),
      nextAction:
        "100개 시나리오에서 중앙값·p95와 폐업, 목적불일치, 예약미도착 오추천을 함께 측정하세요.",
    },
    {
      id: "real_user_usability",
      title: "독립 실사용자 20명·3개 로케일 사용성",
      status: fieldStatus("real_user_usability"),
      evidence: fieldSummary(
        "real_user_usability",
        "AI 페르소나가 아닌 독립 실사용자 20명의 실제 과업 원장이 없습니다.",
      ),
      nextAction:
        "한국어·영어를 포함한 3개 로케일, 초행자와 이동약자 표본에서 완료율 90%, 명확성·신뢰도 4.2/5, 치명적 사고 0건을 검증하세요.",
    },
    {
      id: "field_journeys_six_regions",
      title: "6개 권역 실제 이동 12회·부산 5회",
      status: fieldStatus("field_journeys_six_regions"),
      evidence: fieldSummary(
        "field_journeys_six_regions",
        "6개 권역 유형 실제 이동 12회와 부산 현장 5회의 독립 원장이 없습니다.",
      ),
      nextAction:
        "실제 이동에서 고정 일정 훼손·휴무지 추천·예약 미준수·치명적 오추천이 모두 0건인지 확인하세요.",
    },
    {
      id: "comparative_benchmark_20",
      title: "동일 20상황·4개 방법 비교실험",
      status: fieldStatus("comparative_benchmark_20"),
      evidence: fieldSummary(
        "comparative_benchmark_20",
        "이어가·수작업·범용 AI·일반 재생성기를 같은 입력과 제한시간으로 비교한 80행 원장이 없습니다.",
      ),
      nextAction:
        "20개 상황마다 네 방법을 모두 실행하고 실패를 삭제하지 않은 원본 원장을 독립 감사받으세요.",
    },
    {
      id: "practitioner_review",
      title: "관광·지자체·접근성 실무자 독립 검토",
      status: fieldStatus("practitioner_review"),
      evidence: fieldSummary(
        "practitioner_review",
        "서로 다른 역할의 독립 실무자 3명 승인과 치명적 미해결 0건 증거가 없습니다.",
      ),
      nextAction:
        "관광·지자체·접근성 역할별 실무자 검토를 받고 제출자와 다른 감사자가 승인하세요.",
    },
    {
      id: "legal_and_operational_approvals",
      title: "법률·데이터·운영 통제 8종 승인",
      status: blockingFieldStatus("legal_and_operational_approvals"),
      evidence: fieldSummary(
        "legal_and_operational_approvals",
        "위치기반서비스, OpenAPI 저장, KTO 명칭, 개인정보, 관리형 제공자와 모니터링의 유효한 승인 8종이 없습니다.",
      ),
      nextAction:
        "필수 운영 통제 8종의 승인 주체·유효기간·원본 해시를 확보하기 전에는 출시하지 마세요.",
    },
    {
      id: "partner_embed_pilot",
      title: "외부 파트너 사이트 iframe 실증",
      status: fieldStatus("partner_embed_pilot"),
      evidence: fieldSummary(
        "partner_embed_pilot",
        "실제 외부 파트너 origin에서 위치 권한·메모리 전용 embed bearer·복구 요청을 끝까지 완료한 독립 증거가 없습니다.",
      ),
      nextAction:
        "최소 1개 계약 파트너와 Safari·Firefox·Chrome 모바일 브라우저 3종에서 타사 쿠키 없이 iframe 로드·위치 위임·bearer bootstrap·복구 요청을 100% 성공시키고 치명적 실패 0건을 감사받으세요.",
    },
    {
      id: "participant_consent_ledger",
      title: "실사용자 동의·철회 통제 원장",
      status: blockingFieldStatus("participant_consent_ledger"),
      evidence: fieldSummary(
        "participant_consent_ledger",
        "실사용자 표본과 연결되는 가명 동의 원장, 철회 반영, 독립 개인정보 검토 증거가 없습니다.",
      ),
      nextAction:
        "개인정보 원문은 공개하지 말고 가명 참여자 20명 이상의 동의 범위와 철회 반영을 기록한 원장을 독립 감사받아 원장 SHA-256만 제출 증거와 교차검증하세요.",
    },
  ];

  /* 배포본에서 지금 확인되는 것은 언제나 싣는다. 이 일곱 줄은 실패할 수 있고,
     실패하면 그건 진짜 결함이므로 화면이 반드시 말해야 한다.

     나머지는 **아직 시작하지 않은 상업 출시의 요건**이라 등록됐을 때만
     나타난다. 파트너 origin 허용 정책도 같은 성격이다 — 계약한 파트너가
     없으니 허용 목록이 비어 있는 것이고, 그건 고장이 아니라 사실이다.
     제휴가 생겨 origin을 등록하면 항목이 나타나고, 그때는 와일드카드 없는
     정확한 origin인지 예전과 똑같이 판정한다. */
  const alwaysReported = new Set<string>([
    "deployment_commit_traceability",
    "platform_runtime",
    "stable_session_signing",
    "release_secret_separation",
    "independent_field_evidence_auditor",
    "eight_kto_openapis",
    "managed_external_providers",
  ]);
  const reported = items.filter((item) => {
    if (alwaysReported.has(item.id)) return true;
    if (item.id === "partner_embed_origin_policy") {
      return params.embedAllowlistReady;
    }
    return (
      params.fieldEvidence?.[item.id as FieldEvidenceType] !== undefined
    );
  });

  const hasBlocker = reported.some(
    (item) => item.status === "release_blocker",
  );
  const needsEvidence = reported.some(
    (item) => item.status === "needs_field_evidence",
  );
  return {
    overall: hasBlocker
      ? "blocked"
      : needsEvidence
        ? "evidence_collection"
        : "ready",
    verifiedCount: reported.filter((item) => item.status === "verified")
      .length,
    totalCount: reported.length,
    items: reported,
    generatedAt: new Date().toISOString(),
  };
}
