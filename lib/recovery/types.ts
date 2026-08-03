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
};

export type ContinuityProof = {
  schemaVersion: "2026-07-v2";
  objective:
    | "minimize_changed_nodes_then_travel_minutes"
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

export type DataContribution = {
  source:
    | KtoServiceName
    | "OpenStreetMap Routing"
    | "Open-Meteo";
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
    | "changed_visit_category";
  originalPurpose: string;
  replacementPurpose: string;
  originalStopTitle: string;
  replacementTitle: string;
  evidenceSource: "TarRlteTarService1" | "KorService2";
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
    disruptedNodeId: string;
    nextFixedNodeId?: string;
    lockedNodeCount: number;
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
