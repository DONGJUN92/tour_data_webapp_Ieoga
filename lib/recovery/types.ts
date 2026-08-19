import type { AvailabilityEvidence } from "@/lib/kto/availability";
import type { KtoAudit, KtoServiceName } from "@/lib/kto/types";
import type {
  WalkingRouteEvidence,
  WalkingRouteProvider,
} from "@/lib/mobility/routing";
import type { WeatherEvidence } from "@/lib/weather/service";

export type RecoveryStatus =
  | "verified"
  | "degraded"
  | "no_valid_candidate"
  /* 여행자가 준 조건끼리 이미 모순이어서 **어떤 후보도 존재할 수 없는** 요청.
     `no_valid_candidate`와 갈라 놓는 이유는 여행자가 할 수 있는 일이 정반대이기
     때문이다 — 후보가 없으면 다시 시도하거나 조건을 넓히면 되지만, 조건 자체가
     불가능하면 무엇을 얼마나 바꿔야 하는지 알려 주어야 한다. 이 판정은 외부
     조회 0건으로 내린다. */
  | "input_infeasible"
  | "unsupported_coverage"
  | "upstream_unavailable";

/* 조건을 바꾸면 갈 수 있는 곳. `options`가 아니므로 적용 대상이 아니다.
   화면은 이것을 "추천"이 아니라 "이렇게 바꾸면 열리는 곳"으로 보여야 한다. */
export type NearMissCandidate = {
  contentId: string;
  title: string;
  distanceMeters?: number;
  /* 무엇이 얼마나 모자랐는지. 여행자가 우리를 검산할 수 있는 문장. */
  reason: string;
  reasonCode: RejectionReasonCode;
  /* 이것만 바꾸면 통과하는 최소 조정. 없으면 단일 조정으로는 열리지 않는다. */
  requiredRelaxation?: RejectedCandidate["requiredRelaxation"];
  /* 실제 경로까지 확인한 탈락인지, 사전 계산 단계 탈락인지. */
  verificationDepth?: "pre_filter" | "route_verified";
};

/* 조회 기준 시각에 운영하지 않는 곳. 밤 요청에서 특히 많다. */
export type ClosedCandidate = {
  contentId: string;
  title: string;
  distanceMeters?: number;
  reason: string;
};

/* 요청이 왜 불가능한지, 그리고 여행자가 바꿀 수 있는 최소 조정.
   `status === "input_infeasible"`일 때만 채워진다. */
export type InputFeasibility = {
  reason: "next_place_unreachable" | "window_too_short";
  /* 직선거리 기준 최소 이동시간. 어떤 실제 경로도 이보다 빠를 수 없다. */
  minimumTravelMinutes: number;
  geodesicMeters?: number;
  /* 이동에 실제로 쓸 수 있었던 시간과, 필요한 시간. */
  availableTravelMinutes: number;
  requiredTravelMinutes: number;
  shortfallMinutes: number;
  nextPlaceLabel?: string;
  travelMode: "walk" | "car" | "transit" | "bicycle";
  /* 여행자가 고를 수 있는 조정. 각 항목은 이것만 바꾸면 가능해지는 값이다. */
  remedies: Array<{
    kind:
      | "travel_mode"
      | "stay_minutes"
      | "window_minutes"
      /* 다음 장소의 약속 시각을 늦추는 것. 남은 시간을 늘리는 것과 다른 입력이라
         갈라 놓는다 — 화면이 어느 칸을 고쳐야 하는지 알아야 한 번 누르면
         다시 찾을 수 있다. */
      | "appointment_later"
      | "drop_next_place";
    label: string;
    labelEn: string;
    /* 그 조정을 적용했을 때의 값(수단은 코드, 분 단위는 숫자). */
    value?: string | number;
  }>;
};

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
  /* `assisted`는 유아차·휠체어·고령자를 합친 값이다. 예전 세 값은 저장된
     일정과 이미 발급된 결과를 계속 읽기 위해 남겨 둔다. */
  audience: "general" | "assisted" | "stroller" | "wheelchair" | "senior";
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
  /* 세 축이다. `available`은 집중률(직접 또는 주변 대체), `popularity_rank`는
     연관 관광지 순위, `unavailable`은 어디에도 없음. 집중률 데이터셋은
     관광지 전용이라 음식점·숙박·축제행사는 매칭률이 0%다 — 한 축만 두면 그
     유형들은 영원히 빈칸이 된다. */
  status: "available" | "popularity_rank" | "unavailable";
  relativeRate?: number;
  baseDate?: string;
  /* 오늘 값이 **그 장소 자신의** 최근 일별 분포에서 몇 번째 백분위인가(0~100).
     장소 간 절대값 비교는 이 지표의 단위 정의에 의존하는데 공식 정의를 확인하지
     못했다. 백분위는 단위가 무엇이든 잘 정의되므로 이쪽을 함께 싣는다. */
  percentileOfSeries?: number;
  seriesDays?: number;
  /* 카드에 쓰는 세 단계. 원문 수치는 근거 확인용으로 위에 그대로 남는다. */
  level?: "easy" | "normal" | "busy";
  /* 이 값이 이 장소를 직접 잰 것인지(`place`), 반경 800m 이웃에서 빌려 온
     것인지(`nearby`), 시군구 전체 값인지(`district`). 뒤로 갈수록 근거가
     약하므로 카드에 꼬리표로 밝히고 정렬 가중치도 줄인다. */
  basis?: "place" | "nearby" | "district";
  neighborCount?: number;
  neighborMeters?: number;
  /* `popularity_rank`일 때의 연관 관광지 순위. 붐빔이 아니라 인기다. */
  relatedRank?: number;
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
  /* `origin_return_route` is a separately requested candidate→origin route.
     It must never be inferred by copying the outbound duration: direction,
     traffic and transit schedules can all make the two legs asymmetric. */
  returnBasis: "next_place_route" | "origin_return_route";
  returnProvider: WalkingRouteProvider;
  returnDistanceMeters: number;
  returnCalculatedAt: string;
  /* A route that merely reaches the boundary is not an actionable travel
     recommendation. This is the user-declared reserve that must still remain
     after the verified return leg (or before the next fixed appointment). */
  requiredBufferMinutes: number;
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
  | "카카오맵 대중교통 길찾기"
  | "카카오맵 자전거 길찾기"
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

/* 시점별 날씨 한 줄. 지정 여행지와 대안을 **같은 시점으로 나란히** 놓아
   사용자가 직접 비교하게 하는 용도이며, 순위에는 쓰지 않는다.
   기상청에 30분 단위 예보가 없어 1시간 간격이다(실측 확인). */
export type WeatherGlance = {
  hoursAhead: number;
  at: string;
  precipitationType?: number;
  skyCode?: number;
  precipitationProbabilityPercent?: number;
  temperatureCelsius?: number;
};

/* 여행자가 그 장소를 고르기 위해 보는 값 하나. 예전 카드는 `why` 문장만 나열해서
   "무엇을 어떻게 확인했는지"는 길게 말하면서 "몇 시에 여는가", "대표메뉴가
   무엇인가" 같은 정작 필요한 값은 한 줄도 주지 않았다. 검증 서술과 장소 정보를
   서로 다른 자료구조로 나눠, 화면이 요약과 상세를 나눌 수 있게 한다. */
export type TravelerFact = {
  code:
    | "hours"
    | "rest_day"
    | "signature_menu"
    | "menu"
    | "fee"
    | "parking"
    | "reservation"
    | "credit_card"
    | "pet"
    | "check_in_out"
    | "event_period"
    /* 추천코스(25)의 공식 소요시간·길이. 코스는 여러 지점을 잇는 경로라
       "몇 시에 여는가"가 없고, 대신 이 값이 갈지 말지를 정한다. */
    | "course_scale"
    | "contact"
    | "crowd"
    | "indoor"
    | "transit_fare"
    | "taxi_fare"
    | "distance"
    | "spare_time";
  label: string;
  labelEn: string;
  value: string;
  valueEn?: string;
  /* 접지 않고 요약 카드에 바로 보여 줄 값인가. 갈지 말지를 실제로 가르는 값만
     참이다 — 나머지는 상세보기에서 읽는다. */
  prominent?: boolean;
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
  /* 이 후보 지점의 시점별 날씨. 격자 예보를 따로 받은 경우 그 값이다. */
  weatherGlance?: WeatherGlance[];
  contentId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  thumbnailUrl?: string;
  contentTypeId: string;
  tourismCategory: {
    code: string;
    labelKo: string;
    labelEn: string;
    source:
      | "KorService2.lclsSystm2"
      | "KorService2.lclsSystm1"
      | "KorService2.contenttypeid";
    officialLevel1Code?: string;
    officialLevel2Code?: string;
    officialLevel3Code?: string;
  };
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
  /* 장소 자체에 대한 사실. 검증 서술(`why`)과 섞지 않는다. */
  travelerFacts: TravelerFact[];
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
    | "CONCENTRATION_UNVERIFIED"
    /* 공식 응답은 받았지만 운영시간을 대조할 수 없는 곳. 빈 시간 추천에서는
       숨기지 않고, 대신 일정에 넣기 전에 확인을 받는다. */
    | "OPERATING_HOURS_UNVERIFIED";
  note: string;
  noteEn?: string;
};

/* 탈락 사유 코드를 이름 있는 유니온으로 둔다. 화면의 라벨 사전을 이 유니온으로
   좁히면, 새 사유를 추가하고 라벨을 빼먹었을 때 컴파일이 막힌다. 라벨이 없으면
   0건 화면 첫 줄에 `INDOOR_UNVERIFIED` 같은 내부 코드가 그대로 찍혔다. */
export type RejectionReasonCode =
  | "INVALID_COORDINATE"
  | "TIME_LIMIT"
  | "INDOOR_UNVERIFIED"
  | "ACCESSIBILITY_UNVERIFIED"
  | "CONCENTRATION_UNVERIFIED"
  | "CONCENTRATION_HIGH"
  | "SAME_AS_DISRUPTED_PLACE"
  | "TRAVEL_PURPOSE_MISMATCH"
  | "OFFICIALLY_CLOSED"
  /* 기간이 있는 콘텐츠(행사·공연·축제)가 조회 기준 날짜에 열리지 않는 경우.
     휴무와 구별한다 — 작년에 끝난 축제를 "휴무"라고 적으면 여행자는 다른 날
     가면 된다고 읽는다. */
  | "EVENT_NOT_RUNNING"
  /* The official endpoint responded, but did not contain enough structured
     operating data to prove the whole proposed stay is open. */
  | "OPERATING_STATUS_UNCONFIRMED"
  /* The operating-hours endpoint itself failed. Kept separate from a valid
     empty/unstructured response so callers know whether retrying can help. */
  | "OPERATING_STATUS_UPSTREAM_UNAVAILABLE"
  | "CONTINUITY_WAYPOINT_AT_RISK"
  | "NEXT_FIXED_APPOINTMENT_AT_RISK"
  /* 빈 시간 추천에서 이동+체류+복귀가 남은 시간을 넘긴 후보. */
  | "OPEN_WINDOW_OVERFLOW"
  | "ROUTE_UNAVAILABLE";

export type RejectedCandidate = {
  contentId?: string;
  title: string;
  reasonCode: RejectionReasonCode;
  reason: string;
  distanceMeters?: number;
  changedNodeCount?: number;
  arrivalBufferMinutes?: number;
  requiredRelaxation?: {
    constraint:
      | "available_time"
      | "minimum_stay"
      | "safety_buffer"
      /* 숫자 한도가 아니라 켜고 끄는 조건. 실측에서 가장 많은 탈락 사유였는데
         완화 대상 유니온에 없어 반사실 설명이 항상 비어 있었다. */
      | "indoor_requirement";
    amount: number;
    unit: "meters" | "minutes" | "condition";
    currentLimit: number;
    requiredLimit: number;
    description: string;
    /* 사전 걸러내기 단계의 후보는 경로를 아직 검증하지 않았으므로 예약 보존을
       주장할 수 없다. `true` 리터럴이었을 때는 검증하지 않은 것을 보존했다고
       단정하게 됐다. */
    preservesLockedNodes: boolean;
    preservesNextFixedAppointment: boolean;
  };
  /* 이 판정이 어디까지 확인된 것인가. `pre_filter`는 거리·시간 조건만 비교한
     단계이고 경로·운영시간·예약 보존은 확인하지 않았다. 화면이 그 차이를
     그대로 말해야 한다. */
  verificationDepth?: "pre_filter" | "route_verified";
};

export type CounterfactualProof = RejectedCandidate & {
  proofType: "single_constraint_minimum_relaxation";
  requiredRelaxation: NonNullable<
    RejectedCandidate["requiredRelaxation"]
  >;
};

export type RecoveryResult = {
  requestId: string;
  /* The authoritative clock used for route departure, opening-hours checks,
     weather slots and locked-appointment continuity. `generatedAt` remains
     the actual computation time and must not be confused with this value. */
  referenceTime: {
    mode: "current" | "assumed";
    at: string;
  };
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
  /* 사용자가 원래 가려던 곳(또는 현재 위치)의 시점별 날씨. 대안 카드의 같은
     시점과 나란히 비교하는 기준이 된다 — 비교 대상이 없으면 대안의 날씨만
     보고 "여기가 나은가"를 판단할 수 없다. */
  originWeatherGlance?: WeatherGlance[];
  originWeatherLabel?: string;
  /* 제거실험으로 무엇을 끄고 얻은 결과인지. 심사위원이 화면에서 API를 끄고
     차이를 볼 때, 그 수치가 어떤 조건에서 나온 것인지 응답 자체가 말해야 한다.
     빈 배열이면 전체 사용이다. */
  ablation?: {
    disabledSources: string[];
    /* 끈 서비스가 실제로 어떤 결정을 못 하게 됐는가. 후보 수만 비교하면
       "별 차이 없다"로 읽히지만, 사라진 것은 판정 근거다. */
    lostCapabilities: string[];
    verifiedOptionCount: number;
    confirmationRequiredCount: number;
    relatedEvidenceCount: number;
    crowdEvidenceCount: number;
    accessibilityVerifiedCount: number;
  };
  /* 빈 시간 추천에서 사용자가 알려 준 창 조건. 어떤 제약으로 계산했는지를
     결과와 같은 객체에 남긴다. */
  openWindowSummary?: {
    windowStartAt: string;
    windowEndAt: string;
    windowMinutes: number;
    plannedStayMinutes: number;
    nextPlaceLabel?: string;
    nextPlaceArriveBy?: string;
    /* 다음 장소를 알려 주었지만 약속 시각이 없어 **마감으로 쓰지 않은** 경우.
       화면이 "이 장소 도착은 검증하지 않았다"를 말할 수 있어야 한다. */
    nextPlaceIsDirectionHint?: boolean;
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
  rejectionSummary: Array<{ reasonCode: RejectionReasonCode; count: number }>;
  counterfactual?: CounterfactualProof;
  /* 후보를 보기 전에 요청 자체가 불가능하다고 판정한 근거와 바꿀 수 있는 것들. */
  inputFeasibility?: InputFeasibility;
  /* **조건을 바꾸면 갈 수 있는 곳**과 **지금은 문을 닫은 곳**.

     이 배열은 `options`와 절대 섞이지 않는다. 여기 실린 장소는 실행 가능한
     추천이 아니라 **탈락한 후보를 탈락한 상태로** 보여 주는 것이다. 엔진은
     이 판정을 이미 하고 있었고, 최소 조정량까지 계산한 뒤 버렸다 — 실측에서
     1순위 탈락안이 "안전여유가 1분 부족, 체류 60→30분이면 통과"였다.
     그것을 알면서 "찾지 못했습니다"라고만 말하는 것이 오히려 덜 정직하다. */
  alternatives?: {
    /* 경로까지 검증했으나 시간이 모자란 곳. 최소 조정량이 함께 실린다. */
    nearMisses: NearMissCandidate[];
    /* 조회 기준 시각에는 휴무·운영시간 밖인 곳. */
    closedNow: ClosedCandidate[];
  };
  dataContributions: DataContribution[];
  sourceLedger: KtoAudit[];
  warnings: string[];
  generatedAt: string;
  ruleVersion: string;
};
