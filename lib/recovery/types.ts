import type { AvailabilityEvidence } from "@/lib/kto/availability";
import type { KtoAudit, KtoServiceName } from "@/lib/kto/types";
import type { WalkingRouteEvidence } from "@/lib/mobility/routing";
import type { WeatherEvidence } from "@/lib/weather/service";

export type RecoveryStatus =
  | "verified"
  | "degraded"
  | "no_valid_candidate"
  | "unsupported_coverage"
  | "upstream_unavailable";

export type RecoveryMode =
  | "registered_itinerary"
  | "inline_itinerary"
  /* 등록된 일정 없이, 지금 비어 있는 시간 구간만 받아 채우는 모드. 일정을
     교체하는 것이 아니라 한 곳을 끼워 넣으므로 changedNodeCount는 0이고,
     보존 대상은 사용자가 알려 준 다음 장소 또는 종료 시각뿐이다. */
  | "open_window"
  | "proximity_fallback";

export type AccessibilityEvidence = {
  status: "not_required" | "verified" | "partial" | "unverified";
  grade: "A" | "B" | "C" | "X";
  audience: "general" | "stroller" | "wheelchair" | "senior";
  confirmedFields: Array<{ field: string; value: string }>;
  requiredChecks: Array<{
    label: string;
    status: "confirmed" | "missing";
    fields: string[];
  }>;
  supplementalFields: Array<{ field: string; value: string }>;
  note: string;
  /* 같은 설명의 영어 표기. 영어 화면에서 검증 사유만 한국어로 남는 일을 막는다. */
  noteEn?: string;
};

export type CrowdEvidence = {
  status: "available" | "unavailable";
  relativeRate?: number;
  baseDate?: string;
  note: string;
  noteEn?: string;
};

export type PublicAvailabilityEvidence = Omit<
  AvailabilityEvidence,
  "audit"
>;

export type ScheduleNodeSummary = {
  id: string;
  sequence: number;
  type: "visit" | "reservation" | "meal" | "transit" | "stay" | "other";
  title: string;
  startAt?: string;
  endAt?: string;
  locked: boolean;
  reservation: boolean;
};

export type NextFixedAppointmentProof = {
  nodeId: string;
  title: string;
  scheduledAt: string;
  estimatedArrivalAt?: string;
  arrivalBufferMinutes?: number;
  safetyBufferMinutes: number;
  status: "preserved" | "at_risk" | "unverified";
};

export type ContinuityWaypointProof = {
  nodeId: string;
  title: string;
  scheduledAt: string;
  estimatedArrivalAt: string;
  arrivalBufferMinutes: number;
  requiredBufferMinutes: number;
  locked: boolean;
  reservation: boolean;
  status: "preserved" | "at_risk";
};

export type ScheduleDiff = {
  mode: RecoveryMode;
  /* 원래 일정 한 곳을 바꾸는 복구와, 빈 시간에 한 곳을 끼워 넣는 추천을
     화면과 증명서가 같은 문장으로 설명하지 않도록 구분한다. */
  changeKind: "replace" | "insert";
  replacedNodeId?: string;
  replacementContentId: string;
  changedNodeIds: string[];
  unchangedNodeIds: string[];
  lockedNodeIds: string[];
  preservedLockedNodeIds: string[];
  changedNodeCount: number;
  nextFixedAppointmentPreserved?: boolean;
  arrivalTime?: string;
  safetyBufferMinutes?: number;
  note?: string;
  originalNode?: ScheduleNodeSummary;
  replacementNode: {
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    durationMinutes: number;
  };
  preservedWaypoints?: ContinuityWaypointProof[];
  nextFixedAppointment?: NextFixedAppointmentProof;
  openWindow?: OpenWindowProof;
};

/* 빈 시간 추천에서 "이 시간 안에 정말 다녀올 수 있는가"의 계산 근거.
   다음 장소를 알려 준 경우에는 그 도착까지 검증하고, 알려 주지 않은 경우에는
   같은 보행 경로로 돌아오는 시간까지 창 안에 들어가는지 검증한다. */
export type OpenWindowProof = {
  windowStartAt: string;
  windowEndAt: string;
  windowMinutes: number;
  travelToMinutes: number;
  plannedStayMinutes: number;
  appliedStayMinutes: number;
  /* 다음 장소가 있으면 그곳까지의 이동, 없으면 출발지로 되돌아오는 이동. */
  returnMinutes: number;
  returnBasis: "next_place_route" | "same_route_reversed";
  leftoverMinutes: number;
  status: "fits" | "at_risk";
};

export type ContinuityProof = {
  schemaVersion: "2026-07-v2";
  objective:
    | "minimize_changed_nodes_then_travel_minutes"
    | "maximize_fit_within_open_window"
    | "minimize_travel_minutes_without_registered_itinerary";
  recoveryMode: RecoveryMode;
  changedNodeCount: number;
  lockedNodesTotal: number;
  lockedNodesPreserved: number;
  nextFixedAppointmentPreserved?: boolean;
  routeEvidence: WalkingRouteEvidence | {
    status: "geodesic_estimate";
    provider: "ieoga_conservative_estimate";
    distanceMeters: number;
    durationMinutes: number;
    calculatedAt: string;
  };
  availabilityEvidence: PublicAvailabilityEvidence;
  purposePreservation?: TravelPurposeProof;
  weatherEvidence?: WeatherEvidence;
  generatedAt: string;
};

/* 기여 원장에 적히는 제공자 이름. 이름을 고정 문자열로 박아 두면 TMAP·기상청으로
   계산한 결과에도 OpenStreetMap·Open-Meteo라고 적힌다. 실제로 그런 상태였고,
   심사 증거로 제출하는 원장이 스스로 출처를 틀리게 적고 있었다. 그래서 응답이
   말한 제공자만 쓸 수 있도록 값을 열거한다. */
export type RoutingContributionSource =
  | "TMAP 보행자 경로안내"
  | "TMAP 자동차 경로안내"
  | "OpenStreetMap Routing";

export type WeatherContributionSource =
  | "기상청 단기예보"
  | "Open-Meteo";

export type DataContribution = {
  source:
    | KtoServiceName
    | RoutingContributionSource
    | WeatherContributionSource;
  fields: string[];
  decision: string;
  effect: "verified" | "excluded" | "ranked" | "bounded";
  status: "applied" | "unavailable";
};

export type TravelPurposeProof = {
  status:
    | "verified_related_place"
    | "verified_activity_type"
    | "supported_visit_category"
    /* 원래 하려던 활동과 유형이 다른 후보. 시간·날씨 조건은 통과했지만
       "목적을 유지한다"고 말할 수 없으므로 별도 상태로 분리한다. */
    | "changed_visit_category"
    /* 빈 시간 추천에는 보존할 원래 목적이 없다. 다음 장소를 알려 준 경우에는
       그 장소와 이어지는지를, 알려 주지 않은 경우에는 아무 목적도 주장하지
       않음을 명시한다. 없는 근거를 있는 것처럼 만들지 않기 위한 구분이다. */
    | "open_window_flow"
    | "open_window_unconstrained";
  originalPurpose: string;
  replacementPurpose: string;
  originalStopTitle: string;
  replacementTitle: string;
  evidenceSource: "TarRlteTarService1" | "KorService2" | "none";
  relatedRank?: number;
  statement: string;
  statementEn?: string;
};

export type RecoveryOption = {
  /* Conditions official data could not confirm for this option. */
  evidenceGaps: EvidenceGap[];
  confirmationRequired: boolean;
  id: string;
  strategy: "minimum_change" | "comfortable" | "local_discovery";
  strategyLabel: string;
  /* 같은 라벨의 영어 표기. 영어 화면에서 배지만 한국어로 남는 일을 막는다. */
  strategyLabelEn?: string;
  contentId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  contentTypeId: string;
  score: number;
  distanceMeters: number;
  estimatedTravelMinutes: number;
  travelEstimate: "routed" | "geodesic_conservative";
  routeGeometry?: Array<{ latitude: number; longitude: number }>;
  availability: PublicAvailabilityEvidence;
  indoorSuitability: {
    status: "type_based" | "not_required";
    note: string;
    noteEn?: string;
  };
  accessibility: AccessibilityEvidence;
  crowd: CrowdEvidence;
  relatedRank?: number;
  purposePreservation: TravelPurposeProof;
  why: string[];
  whyEn?: string[];
  sources: KtoServiceName[];
  sourceModifiedAt?: string;
  scheduleDiff: ScheduleDiff;
  continuityProof: ContinuityProof;
  dataContributions: DataContribution[];
};

/* A condition the official data could not confirm. Carried on an offered
   option so the traveller sees exactly what was not checked. */
export type EvidenceGap = {
  code:
    | "INDOOR_UNVERIFIED"
    | "ACCESSIBILITY_UNVERIFIED"
    | "CONCENTRATION_UNVERIFIED";
  note: string;
  noteEn?: string;
};

export type RejectedCandidate = {
  contentId?: string;
  title: string;
  reasonCode:
    | "INVALID_COORDINATE"
    | "DISTANCE_LIMIT"
    | "TIME_LIMIT"
    | "INDOOR_UNVERIFIED"
    | "ACCESSIBILITY_UNVERIFIED"
    | "CONCENTRATION_UNVERIFIED"
    | "CONCENTRATION_HIGH"
    | "SAME_AS_DISRUPTED_PLACE"
    | "TRAVEL_PURPOSE_MISMATCH"
    | "OFFICIALLY_CLOSED"
    | "CONTINUITY_WAYPOINT_AT_RISK"
    | "NEXT_FIXED_APPOINTMENT_AT_RISK"
    /* 빈 시간 추천에서 이동+체류+복귀가 남은 시간을 넘긴 후보. */
    | "OPEN_WINDOW_OVERFLOW"
    | "ROUTE_UNAVAILABLE";
  reason: string;
  distanceMeters?: number;
  changedNodeCount?: number;
  arrivalBufferMinutes?: number;
  requiredRelaxation?: {
    constraint:
      | "maximum_distance"
      | "available_time"
      | "minimum_stay"
      | "safety_buffer";
    amount: number;
    unit: "meters" | "minutes";
    currentLimit: number;
    requiredLimit: number;
    description: string;
    preservesLockedNodes: true;
    preservesNextFixedAppointment: true;
  };
};

export type CounterfactualProof = RejectedCandidate & {
  proofType: "single_constraint_minimum_relaxation";
  requiredRelaxation: NonNullable<
    RejectedCandidate["requiredRelaxation"]
  >;
  changedNodeCount: 1;
};

export type RecoveryResult = {
  requestId: string;
  status: RecoveryStatus;
  recoveryMode: RecoveryMode;
  itinerarySummary?: {
    itineraryId?: string;
    title: string;
    /* 빈 시간 추천에는 교체할 일정이 없으므로 비어 있을 수 있다. */
    disruptedNodeId?: string;
    nextFixedNodeId?: string;
    lockedNodeCount: number;
  };
  /* 빈 시간 추천에서 사용자가 알려 준 창 조건. 어떤 제약으로 계산했는지를
     결과와 같은 객체에 남긴다. */
  openWindowSummary?: {
    windowEndAt: string;
    windowMinutes: number;
    plannedStayMinutes: number;
    nextPlaceLabel?: string;
    nextPlaceArriveBy?: string;
  };
  scope: {
    coverage: "nationwide";
    regionCode?: string;
    districtCode?: string;
    originLabel: string;
  };
  options: RecoveryOption[];
  rejectedCount: number;
  /* Constraint-by-constraint breakdown of why candidates were removed, so an
     empty result can state its own cause. Counts only, no place names. */
  rejectionSummary: Array<{ reasonCode: string; count: number }>;
  counterfactual?: CounterfactualProof;
  dataContributions: DataContribution[];
  sourceLedger: KtoAudit[];
  warnings: string[];
  generatedAt: string;
  ruleVersion: string;
};
