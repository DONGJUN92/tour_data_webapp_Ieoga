import {
  CONCENTRATION_PAGE_SIZE,
  KTO_CANDIDATE_PAGE_SIZE,
  KTO_CANDIDATE_RADIUS_METERS,
  getAccessibilityDetail,
  getConcentrationForecast,
  getFestivals,
  getNearbyAccessibleTourism,
  getNearbyTourism,
  getRelatedTourism,
  normalizeAnalysisCodes,
} from "@/lib/kto/adapters";
import { ktoTourismCategory } from "@/lib/kto/category";
import { getRuntimeSecret } from "@/lib/runtime-env";
import {
  closedForWholeDate,
  eventRunsOnDate,
  koreaCompactDateString,
  evaluateAvailabilityItem,
  fetchAvailabilitySource,
  getAvailabilityEvidence,
  type AvailabilityEvidence,
} from "@/lib/kto/availability";
import {
  readHoursSnapshots,
  writeHoursSnapshots,
  type HoursSnapshotHit,
  type HoursSnapshotWrite,
} from "@/lib/kto/hours-snapshot";
import {
  isCacheableRouteMode,
  readRouteSnapshots,
  routeSnapshotKey,
  writeRouteSnapshots,
  type RouteSnapshotMode,
  type RouteSnapshotWrite,
} from "@/lib/mobility/route-snapshot";
import {
  KtoError,
  type KtoAudit,
  type KtoCallResult,
  type KtoItem,
  type KtoServiceName,
} from "@/lib/kto/types";
import {
  conservativeCyclingMinutes,
  conservativeDrivingMinutes,
  conservativeTransitMinutes,
  conservativeWalkingMinutes,
  geoTravelMode,
  haversineMeters,
  optimisticReachMeters,
  optimisticTravelMinutes,
  type GeoTravelMode,
} from "@/lib/geo";
import {
  getRoute,
  type WalkingRouteEvidence,
  type WalkingRouteProvider,
} from "@/lib/mobility/routing";
import { toKmaGrid } from "@/lib/weather/kma";
import { getWeatherEvidence } from "@/lib/weather/service";
import {
  outdoorTemperatureStrain,
  summariseStayWeather,
  weatherGlance,
  type StayWeather,
  type WeatherGlanceSlot,
} from "@/lib/weather/window";
import { withParticle } from "@/lib/text/korean";
import { strictFiniteNumber } from "@/lib/validation/numbers";
import type { RecoveryRequest } from "./schema";
import { recoveryReferenceTime } from "./reference-time";
import type {
  EvidenceGap,
  AccessibilityEvidence,
  InputFeasibility,
  ContinuityProof,
  DataContribution,
  OpenWindowProof,
  PublicAvailabilityEvidence,
  RecoveryMode,
  RecoveryOption,
  RecoveryResult,
  RejectedCandidate,
  RejectionReasonCode,
  ScheduleDiff,
  ScheduleNodeSummary,
  TravelerFact,
  TravelPurposeProof,
} from "./types";

export const RECOVERY_RULE_VERSION = "2026.08-continuity-v3";
/* Provider and latency guardrails, not traveller distance preferences.
   `locationBasedList2` itself caps radius at 20 km. We scan more pages while
   enough of the request's 20-second budget remains, then verify in small
   batches so failed candidates can be replaced without an unbounded burst. */
/* 공사 `contentTypeId` 15 = 행사·공연·축제. */
const FESTIVAL_CONTENT_TYPE_ID = "15";

/* 행사 전용 조회의 한 페이지 크기. 서울이 실측 32건이라 50이면 대부분 지역을
   한 번에 덮지만, 넘칠 수 있으므로 넘친 사실을 화면에 밝힌다. */
const FESTIVAL_PAGE_SIZE = 50;

/* `20260819` → `2026.08.19`. 여행자에게 보이는 문장에 그대로 들어간다. */
function readableCompactDate(value: number): string {
  return String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1.$2.$3");
}

const CANDIDATE_DISCOVERY_MAX_PAGES = 2;
const CANDIDATE_EXPANSION_TIMEOUT_MS = 2_500;
const CANDIDATE_DISCOVERY_RESERVE_MS = 10_000;
/* 후보 탐색은 20km 안에서 수백 곳을 가져오는데, 검증 풀이 18곳이라 그 뒤는 한 번도
   확인되지 않은 채 버려졌다. 실사용에서 "선택지가 너무 적다"로 나타났다 — 조건을
   통과할 수 있는 곳이 없어서가 아니라, 물어보지 않아서 없었다.

   두 배로 넓힌다. 함께 배치를 3에서 6으로 키우는데, KTO 클라이언트가 자체적으로
   동시 3건으로 대기열을 걸고 슬롯을 얻은 **뒤에** 타임아웃을 걸기 때문에
   운영시간 조회는 더 밀리지 않는다. 늘어나는 것은 경로 제공자 쪽 동시성이고,
   그만큼 응답 예산도 25초로 함께 올렸다. */
const CONTINUITY_RESULT_LIMIT = 24;
const CONTINUITY_VERIFICATION_HARD_LIMIT = 36;
const CONTINUITY_VERIFICATION_BATCH_SIZE = 6;

/* 요청 하나가 쓸 수 있는 외부 호출 수. 시간 예산과 나란히 있는 두 번째 한도이고,
   운영 환경에서는 이쪽이 먼저 바닥났다.

   Cloudflare Workers 무료 플랜은 요청당 서브리퀘스트를 50건으로 막는다. 예전
   구현은 이 한도를 모른 채 후보 서른여섯 곳을 검증하려 했고, 한 요청에 백열여섯
   건을 부르다 스무 건쯤에서 벽에 부딪혔다. 그 뒤의 경로 호출은 전부 실패했는데,
   실패 사유가 "경로를 확인하지 못함"이라 화면에는 마치 그 장소들에 길이 없는 것
   처럼 보였다. 실제로는 우리가 예산을 다 쓴 것이었다.

   그래서 한도를 넘기고 실패하는 대신, 남은 예산을 보고 멈춘다. 멈춘 사실은
   경고로 밝힌다 — 확인하지 못한 후보를 확인한 척하지 않는 것과 같은 규칙이다.
   45는 50에서 저장·세션 등 엔진 밖 호출 몫을 남긴 값이다. 유료 플랜(1000건)으로
   옮기면 `RECOVERY_SUBREQUEST_BUDGET`으로 올려 잡을 수 있다. */
const DEFAULT_SUBREQUEST_BUDGET = 45;

/* 남은 외부 호출 예산. 시간 마감과 같은 자리에서, 같은 방식으로 쓰인다. */
type SubrequestMeter = {
  spent: number;
  budget: number;
  /* 예산이 바닥나 검증을 멈췄는가. 시간 때문에 멈춘 것과 다르게 안내한다. */
  exhausted: boolean;
  /* 후보 한 곳의 경로 조회 비용. 보행은 복귀를 되짚어 쓰므로 1이다. */
  routeCost: number;
};

/* 호출 직전에 예산을 확보한다. 확보하지 못하면 부르지 않는다 — 한도를 넘겨
   실패하면 그 실패가 "경로가 없다"로 둔갑하기 때문이다. */
function reserveSubrequests(
  meter: SubrequestMeter | undefined,
  count: number,
): boolean {
  if (!meter) return true;
  if (meter.spent + count > meter.budget) {
    meter.exhausted = true;
    return false;
  }
  meter.spent += count;
  return true;
}

/* 후보 한 곳의 경로 검증이 실제로 쓰는 외부 호출 수.

   예전 값은 `travelMode === "walk" ? 1 : 2`로 **이동수단만** 봤다. 그런데
   TMAP 보행·자동차와 카카오 대중교통 어댑터는 구간마다 별도 호출을 한다
   (`points.slice(0, -1).map(fetchSegment)`). 다음 장소가 마감으로 들어오면
   경로는 `현재 → 후보 → 다음 장소` 3지점, 즉 실제 2건인데 1건으로 청구됐다.

   그 어긋남은 조용히 끝나지 않았다. 계량기가 45건 안이라고 믿는 동안 실제 호출은
   플랫폼 상한(무료 50건)을 넘고, 넘어서 실패한 경로 조회는 `ROUTE_UNAVAILABLE`로
   기록된다 — 화면에는 "그 장소에는 갈 길이 없다"로 보인다. 실측에서 3지점 요청은
   요청당 평균 2.7건, 2지점 요청은 0.2건의 `ROUTE_UNAVAILABLE`이 났다. 13배 차이는
   후보의 성질이 아니라 우리 산수의 결과였다.

   자전거만 예외다. 카카오 자전거는 경유지를 `via_x`/`via_y`로 한 번에 보내므로
   구간 수와 무관하게 1건이다.

   모르는 쪽으로 틀릴 때는 **많이 세는 쪽**으로 틀린다. 적게 세면 한도를 넘겨
   위와 같은 거짓 표시가 다시 생기고, 많이 세면 검증 후보가 몇 곳 줄 뿐이다. */
function perCandidateRouteCost(
  input: RecoveryRequest,
  context?: ItineraryContext,
): number {
  const mode = input.travelMode;
  /* 가는 경로의 구간 수: 현재 → 후보 → (연속성 노드들). */
  const outboundSegments = 1 + (context?.continuityNodes.length ?? 0);
  /* 복귀 경로는 창이 있고 다음 장소가 마감으로 없을 때만 조회한다. 보행은 가는
     경로를 되짚어 쓰므로 추가 호출이 없다(양방향 실측 편차 0.0%). */
  const needsReturnRoute = Boolean(context?.openWindow && !context.nextFixed);
  const returnSegments =
    needsReturnRoute && mode !== "walk" ? 1 : 0;

  if (mode === "bicycle") {
    /* 경유지를 한 번에 보내므로 가는 경로 1건, 복귀가 필요하면 1건 더. */
    return 1 + (needsReturnRoute ? 1 : 0);
  }
  /* 보행의 OSRM 폴백은 여기서 미리 잡지 않는다. TMAP이 실패할 때만 나가는
     호출이고, 후보마다 1건씩 예약하면 정상 요청에서 검증 후보가 절반으로 줄기
     때문이다. 그 몫은 예산과 플랫폼 상한 사이의 여유(45 대 50)가 흡수한다 —
     엔진 밖 호출은 D1·세션처럼 내부 예산(1,000건)을 쓰므로 이 다섯 건은
     실질적으로 이런 예외를 위한 자리다. */
  return outboundSegments + returnSegments;
}

function subrequestBudget(): number {
  const configured = Number(getRuntimeSecret("RECOVERY_SUBREQUEST_BUDGET"));
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SUBREQUEST_BUDGET;
}
const CONTINUITY_VERIFICATION_RESERVE_MS = 2_500;
const ACCESSIBILITY_DETAIL_RESERVE_MS = 8_000;

/* 기상 조회의 실제 호출 수. `getWeatherEvidence`는 초단기실황과 단기예보를
   각각 부르므로 지점 하나에 두 건이다. 원장에 남지 않으므로 계량기가 직접
   더해야 하고, 두 자리에 리터럴 `2`가 흩어져 있으면 한쪽만 고쳐지기 쉽다. */
const ORIGIN_WEATHER_CALLS = 2;
const CANDIDATE_GRID_WEATHER_CALLS = 2;
/* 후보 격자 예보에 예산을 쓰기 전에 반드시 남겨 두는 검증 몫(후보 수 기준).
   예보는 정확도를 높이는 값이고 검증은 갈 수 있는지를 가르는 값이므로, 둘이
   경쟁하면 검증이 이겨야 한다. */
const MIN_RESERVED_VERIFICATION_CANDIDATES = 10;

/* 탐색 반경을 도달 가능 거리보다 얼마나 넉넉하게 잡는가.

   딱 맞게 자르면 "조건을 조금만 바꾸면 갈 수 있는 곳"이 탐색 결과에 아예 들어오지
   않는다. 그런 곳은 결과에서 빠지더라도 **왜 빠졌는지 말해 줄 수 있어야** 하고,
   그러려면 후보로 들어와 있어야 한다. 25%는 그 몫이다. */
const DISCOVERY_REACH_MARGIN = 1.25;
/* 탐색 반경의 하한. 짧은 창에서 도달 반경이 수백 미터로 계산되는 것은 맞지만,
   그 반경 안에 공식 관광지가 몇 곳뿐인 지역에서는 근접 실패조차 보여 줄 수 없다.
   2km는 "그래도 이 정도는 훑어본다"는 최소선이고, 실제 통과 판정은 아래 하한
   계산이 따로 한다. */
const MIN_DISCOVERY_RADIUS_METERS = 2_000;

/* 수단별 보수(비관) 이동시간. 후보를 걸러내고 순위를 매기는 쪽에 쓴다.
   예전에는 이 분기가 호출 지점마다 인라인으로 복제돼 있었다. */
function conservativeMinutesFor(
  mode: RecoveryRequest["travelMode"],
  distanceMeters: number,
): number {
  return mode === "car"
    ? conservativeDrivingMinutes(distanceMeters)
    : mode === "bicycle"
      ? conservativeCyclingMinutes(distanceMeters)
      : mode === "transit"
        ? conservativeTransitMinutes(distanceMeters)
        : conservativeWalkingMinutes(distanceMeters);
}

/* 이 요청이 **이동에 쓸 수 있는** 시간. 창 전체에서 머무는 시간과 안전여유를
   뺀 값이다. 체류는 엔진이 적용할 수 있는 **가장 짧은** 값을 쓴다 — 넉넉한
   쪽으로 잡아야 갈 수 있는 후보를 탐색 단계에서 잃지 않는다. */
function travelTimeBudgetMinutes(
  input: RecoveryRequest,
  context?: ItineraryContext,
  /* 어느 체류 시간을 기준으로 계산할지.

     `floor`는 엔진이 자동으로 줄일 수 있는 하한이다. **거부 판정**은 반드시
     이쪽으로 해야 한다 — 체류를 줄이면 갈 수 있는 곳을 "갈 수 없다"고 막지
     않기 위해서다.

     `planned`는 여행자가 실제로 원한 체류다. **탐색 반경**은 이쪽으로 잡는다.
     하한으로 반경을 잡으면 "체류를 절반으로 줄여야 닿는 먼 곳"까지 후보 풀에
     들어와, 여행자가 원한 시간대로 갈 수 있는 가까운 곳을 밀어낸다. 실측에서
     그렇게 해 보니 추천이 16곳에서 8곳으로 줄었다. */
  basis: "floor" | "planned" = "floor",
): number {
  const minimumStay =
    basis === "planned"
      ? Math.max(
          input.minimumStayMinutes ?? 30,
          context?.openWindow?.plannedStayMinutes ??
            context?.originalDurationMinutes ??
            input.minimumStayMinutes ??
            30,
        )
      : (input.minimumStayMinutes ?? 30);
  const safetyBuffer = input.safetyBufferMinutes ?? 15;
  const window = context?.openWindow;
  if (!window) {
    /* 일정 복구는 `availableMinutes`로 **다음 예약까지 남은 시간**을 받는다.
       그 시간에는 대체 장소에 머무는 시간과 안전여유가 함께 들어가야 하므로,
       이동에 쓸 수 있는 시간은 그만큼 적다.

       예전에는 남은 시간을 그대로 이동 예산으로 썼다. 90분 뒤 예약이면 반경이
       9.6km로 잡혀, 실제로는 갈 수 없는 먼 후보가 검증 풀을 채우고 운영시간·경로
       조회를 쓴 뒤 `NEXT_FIXED_APPOINTMENT_AT_RISK`로 떨어졌다. 빈 시간 탭은 같은
       계산을 이미 제대로 하고 있었는데 복구 탭만 달랐다 — 그래서 두 탭이 다른
       알고리즘처럼 보였고, 후보가 적은 지역에서는 0건이 됐다.

       체류는 자동 완화가 내려갈 수 있는 하한을 쓴다. 넉넉한 쪽으로 잡아야 줄이면
       갈 수 있는 후보를 탐색 단계에서 잃지 않는다. */
    const minimumStay = input.minimumStayMinutes ?? 30;
    const safetyBuffer = input.safetyBufferMinutes ?? 15;
    if (!context) {
      /* 등록 일정도 빈 시간도 없는 구형 호출은 이 값을 이동시간 한도로 받는다. */
      return Math.max(1, input.availableMinutes);
    }
    return Math.max(
      1,
      input.availableMinutes - minimumStay - safetyBuffer,
    );
  }
  const windowMinutes = Math.max(
    0,
    Math.floor(
      (window.endAt.getTime() - context.occurredAt.getTime()) / 60_000,
    ),
  );
  /* 0을 1로 올리지 않는다. 머무는 시간과 안전여유가 창을 다 쓰면 이동에 쓸 수
     있는 시간은 실제로 0분이고, 그 사실을 그대로 말해야 아래 판정과 반사실이
     맞는 숫자를 낸다. 탐색 반경은 별도의 하한을 가지고 있다. */
  return Math.max(0, windowMinutes - minimumStay - safetyBuffer);
}

/* 요청이 그 자체로 불가능한지. 불가능하면 근거와 조정안을, 아니면 undefined.

   판정은 **하한**으로만 한다. 상한(보수 추정)으로 판정하면 실제로 갈 수 있는
   요청을 불가능하다고 막게 되고, 그것이 fail-closed가 깨지는 유일한 방향이다. */
function assessInputFeasibility(
  input: RecoveryRequest,
  context?: ItineraryContext,
): InputFeasibility | undefined {
  const window = context?.openWindow;
  if (!window) return undefined;
  const mode = geoTravelMode(input.travelMode);
  const stayMinutes = input.minimumStayMinutes ?? 30;
  const safetyBuffer = input.safetyBufferMinutes ?? 15;
  const availableTravelMinutes = travelTimeBudgetMinutes(input, context);

  /* 다음 장소가 마감으로 들어온 경우에만 그 구간이 강제된다. 방향 힌트일 때는
     왕복만 필요하고, 왕복의 하한은 0에 가까우므로(아주 가까운 곳) 요청 자체가
     불가능해지지 않는다 — 그때는 후보별 판정에 맡긴다. */
  const nextLocation = context.nextFixed?.location;
  if (!nextLocation) {
    if (availableTravelMinutes > 0) return undefined;
    /* 이동에 쓸 수 있는 시간이 0분이면 왕복조차 불가능하다. */
    const windowMinutes = Math.max(
      0,
      Math.floor(
        (window.endAt.getTime() - context.occurredAt.getTime()) / 60_000,
      ),
    );
    const needed = stayMinutes + safetyBuffer + 1 - windowMinutes;
    return {
      reason: "window_too_short",
      minimumTravelMinutes: 1,
      availableTravelMinutes: 0,
      requiredTravelMinutes: 1,
      shortfallMinutes: Math.max(1, needed),
      travelMode: mode,
      remedies: [
        {
          kind: "stay_minutes",
          label: `머무는 시간을 ${Math.max(30, windowMinutes - safetyBuffer - 30)}분 이하로 줄이기`,
          labelEn: `shorten the stay to ${Math.max(30, windowMinutes - safetyBuffer - 30)} minutes or less`,
          value: Math.max(30, windowMinutes - safetyBuffer - 30),
        },
        {
          kind: "window_minutes",
          label: `남은 시간을 ${windowMinutes + Math.max(1, needed)}분 이상으로 잡기`,
          labelEn: `set the window to at least ${windowMinutes + Math.max(1, needed)} minutes`,
          value: windowMinutes + Math.max(1, needed),
        },
      ],
    };
  }

  const geodesicMeters = haversineMeters(input.origin, {
    latitude: nextLocation.latitude,
    longitude: nextLocation.longitude,
  });
  const minimumTravelMinutes = Math.ceil(
    optimisticTravelMinutes(geodesicMeters, mode),
  );
  if (minimumTravelMinutes <= availableTravelMinutes) return undefined;

  const shortfallMinutes = minimumTravelMinutes - availableTravelMinutes;
  const nextPlaceLabel = window.nextPlaceLabel ?? nextLocation.label;

  /* 조정안. 각 항목은 **그것만** 바꾸면 가능해지는 값이다. 안전여유는 어느
     항목에서도 건드리지 않는다 — 안전 계약이고 순위 선호가 아니다. */
  const remedies: InputFeasibility["remedies"] = [];
  /* 더 빠른 수단으로 바꾸면 되는가. 제안은 **보수 추정**으로 검증한다 — 하한으로
     제안하면 "자동차로 6분"처럼 지킬 수 없는 희망을 주게 된다. */
  const fasterModes: Array<{ mode: GeoTravelMode; ko: string; en: string }> = [
    { mode: "bicycle", ko: "자전거", en: "bicycle" },
    { mode: "transit", ko: "대중교통", en: "transit" },
    { mode: "car", ko: "자동차", en: "car" },
  ];
  for (const candidateMode of fasterModes) {
    if (candidateMode.mode === mode) continue;
    const conservative = conservativeMinutesFor(
      candidateMode.mode,
      geodesicMeters,
    );
    if (conservative <= availableTravelMinutes) {
      remedies.push({
        kind: "travel_mode",
        label: `${withParticle(candidateMode.ko, "으로/로")} 이동하기 (약 ${conservative}분)`,
        labelEn: `travel by ${candidateMode.en} (about ${conservative} min)`,
        value: candidateMode.mode,
      });
    }
  }
  /* 체류 줄이기는 **제안하지 않는다.** 위 예산이 이미 자동 완화 하한(최소 체류)을
     가정하고 계산됐기 때문이다 — 즉 여기까지 왔다는 것은 체류를 최소로 줄여도
     모자란다는 뜻이고, 더 줄이라는 제안은 지킬 수 없는 희망이 된다. */
  /* 약속을 늦추면 되는가. */
  remedies.push({
    kind: "appointment_later",
    label: `약속 시각을 ${shortfallMinutes}분 이상 늦추기`,
    labelEn: `move the appointment at least ${shortfallMinutes} minutes later`,
    /* 늦춰야 하는 **양**이다. 화면이 현재 약속 시각에 더한다. */
    value: shortfallMinutes,
  });
  /* 마지막 수단: 다음 장소를 마감으로 두지 않기. 지우라는 뜻이 아니라 약속
     시각을 비워 방향 힌트로만 쓰면 남은 시간 안에 다녀올 곳을 찾는다는 뜻이다. */
  remedies.push({
    kind: "drop_next_place",
    label: "약속 시각을 비우고 다녀올 수 있는 곳만 찾기",
    labelEn: "clear the appointment time and just find places you can return from",
  });

  return {
    reason: "next_place_unreachable",
    minimumTravelMinutes,
    geodesicMeters: Math.round(geodesicMeters),
    availableTravelMinutes,
    requiredTravelMinutes: minimumTravelMinutes,
    shortfallMinutes,
    nextPlaceLabel,
    travelMode: mode,
    remedies,
  };
}

/* 불가능 판정을 한 문장으로. 숫자를 다 담아야 여행자가 우리를 검산할 수 있다. */
function feasibilityStatement(feasibility: InputFeasibility): string {
  if (feasibility.reason === "window_too_short") {
    return `남은 시간이 머무는 시간과 안전여유 ${feasibility.shortfallMinutes}분을 담기에도 부족해 이동할 시간이 남지 않습니다.`;
  }
  const km = ((feasibility.geodesicMeters ?? 0) / 1000).toFixed(1);
  /* "머무는 시간을 최소로 줄여도"를 반드시 적는다. 이 판정은 이미 자동 완화
     하한을 가정한 계산이므로, 그 말이 없으면 여행자는 체류를 줄여 보라는
     조언을 기대하게 되고 우리는 그것을 제안할 수 없다. */
  return `${feasibility.nextPlaceLabel}까지 직선 ${km}km로, ${withParticle(travelModeLabel(feasibility.travelMode), "으로/로")} 가장 빠르게 가도 ${feasibility.minimumTravelMinutes}분이 걸립니다. 머무는 시간을 최소로 줄여도 이동에 쓸 수 있는 시간은 ${feasibility.availableTravelMinutes}분뿐이어서 ${feasibility.shortfallMinutes}분 부족합니다.`;
}

/* 후보 탐색에 쓸 반경.

   예전에는 20km 고정이었다. 그 값은 공사 엔드포인트의 최대치이지 이 요청이
   도달할 수 있는 거리가 아니다. 도보로 120분이 비었을 때 실제로 갈 수 있는
   범위는 1km 남짓인데, 거리순 200건을 20km에서 긁어 오면 그 200건 대부분이
   산술적으로 통과할 수 없는 곳이다. 검증 예산은 그 건초더미에 쓰였다.

   실측에서 도보 요청으로 추천된 장소는 예외 없이 1.6km 안에 있었고, 60분 창에서는
   440m 안이었다. 반경을 시간 예산에서 유도하면 같은 100건이 거의 전부 실현 가능한
   후보로 채워진다 — 호출을 늘리지 않고 후보의 질을 바꾸는 변경이다. */
function discoveryRadiusMeters(
  input: RecoveryRequest,
  context?: ItineraryContext,
): number {
  /* 반경은 **여행자가 원한 체류**를 기준으로 잡는다. 위 주석의 이유다. */
  const travelBudget = travelTimeBudgetMinutes(input, context, "planned");
  /* 다음 장소가 마감으로 들어오면 경로는 편도가 아니라 `현재 → 후보 → 다음 장소`
     이지만, 후보가 그 마감 지점 근처에 있을 수도 있으므로 편도 예산을 깎지 않는다.
     복귀가 필요한 경우에만 절반으로 나눈다. */
  const oneWayBudget =
    context?.openWindow && !context.nextFixed
      ? travelBudget / 2
      : travelBudget;
  const reach = optimisticReachMeters(
    oneWayBudget,
    geoTravelMode(input.travelMode),
  );
  return Math.min(
    KTO_CANDIDATE_RADIUS_METERS,
    Math.max(
      MIN_DISCOVERY_RADIUS_METERS,
      Math.ceil(reach * DISCOVERY_REACH_MARGIN),
    ),
  );
}

type ItineraryNode = NonNullable<
  RecoveryRequest["itinerary"]
>["nodes"][number];

type ItineraryContext = {
  mode: Exclude<RecoveryMode, "proximity_fallback">;
  /* 원래 일정 한 곳을 교체하는지, 빈 시간에 한 곳을 끼워 넣는지. `insert`인
     경우 `disrupted`는 없고 보존 대상은 창의 끝 또는 다음 장소뿐이다. */
  changeKind: "replace" | "insert";
  id?: string;
  title: string;
  occurredAt: Date;
  disrupted?: ItineraryNode;
  nextFixed?: ItineraryNode;
  continuityNodes: ItineraryNode[];
  sortedNodes: ItineraryNode[];
  lockedNodeIds: string[];
  originalDurationMinutes: number;
  /* `insert`에서만 채워진다. 창 안에 들어가는지 판정할 때 쓴다. */
  openWindow?: {
    endAt: Date;
    plannedStayMinutes: number;
    nextPlaceLabel?: string;
    nextPlaceArriveBy?: Date;
    /* 다음 장소를 알려 주었지만 **약속 시각은 주지 않은** 경우. 그때 그 장소는
       마감이 아니라 방향 힌트이고, 검증은 출발지 왕복으로 한다. 이 사실을
       결과에 밝히기 위해 따로 들고 다닌다 — 라벨이 있다는 것만으로 "다음 장소
       도착까지 계산했다"고 적으면 거짓이 된다. */
    nextPlaceIsDirectionHint: boolean;
    /* 방향 힌트의 좌표. 순위에서 "가는 방향에 있는가"를 계산할 때 쓴다. */
    nextPlaceLocation?: { latitude: number; longitude: number };
  };
};

type WorkingCandidate = {
  /* Conditions that could not be confirmed from official data. The candidate
     is still offered, but never as if it had been verified. */
  evidenceGaps: EvidenceGap[];
  item: KtoItem;
  contentId: string;
  contentTypeId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  estimatedTravelMinutes: number;
  /* 경로 검증 전의 **회로 전체** 보수 추정 — 왕복이거나 다음 장소까지다.
     `estimatedTravelMinutes`는 출발지→후보 편도뿐이라 순위를 정하는 데 쓰면
     정작 탈락을 가르는 구간을 못 본다. */
  estimatedCircuitMinutes?: number;
  imageUrl?: string;
  /* 공사 `firstimage2`(썸네일). 원본만 비어 있고 썸네일은 있는 콘텐츠가
     있으므로 사진 칸의 두 번째 후보로 쓴다. 같은 목록 응답에 실려 오므로
     외부 조회를 한 건도 더 쓰지 않는다. */
  thumbnailUrl?: string;
  modifiedAt?: string;
  indoor: boolean;
  relatedRank?: number;
  purposePreservation: TravelPurposeProof;
  crowdRate?: number;
  crowdBaseDate?: string;
  /* 오늘 값이 그 장소 자신의 30일 분포에서 몇 번째 백분위인가. 장소 간 절대값
     비교와 달리 단위 정의에 의존하지 않는다. */
  crowdPercentile?: number;
  crowdSeriesDays?: number;
  /* 이 값이 **이 장소 자신의 것**인지, 주변 장소에서 빌려 온 것인지. 빌려 온
     값을 직접 측정한 값과 같은 얼굴로 보여 주면 근거를 부풀리는 것이다. */
  crowdBasis?: "place" | "nearby" | "district";
  crowdNeighborCount?: number;
  crowdNeighborMeters?: number;
  /* 이 후보에 **머무는 시간대**의 날씨. 출발지의 지금 하늘이 아니다. */
  stayWeather?: StayWeather;
  /* 이 후보 지점의 시점별 날씨(지금·1시간 후·2시간 후). 순위에는 쓰지 않고
     화면에서 지정 여행지와 나란히 비교하는 용도다. */
  weatherGlance?: WeatherGlanceSlot[];
  accessibility: AccessibilityEvidence;
  availability: PublicAvailabilityEvidence;
  routeEvidence:
    | WalkingRouteEvidence
    | {
        status: "geodesic_estimate";
        provider: "ieoga_conservative_estimate";
        distanceMeters: number;
        durationMinutes: number;
        calculatedAt: string;
      };
  scheduleDiff: ScheduleDiff;
  continuityProof: ContinuityProof;
  baseScore: number;
  comfortScore: number;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function candidateDiscoveryKey(item: KtoItem): string {
  const contentId = stringValue(item.contentid);
  if (contentId) return `content:${contentId}`;
  /* Invalid records are rejected later, but a bad record repeated on several
     pages must not inflate work or rejection counts. */
  return [
    "fallback",
    stringValue(item.contenttypeid),
    normalizeName(stringValue(item.title)),
    stringValue(item.mapx),
    stringValue(item.mapy),
  ].join(":");
}

function numberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return strictFiniteNumber(value, { minimum, maximum });
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizedImage(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  return raw.startsWith("http://") ? `https://${raw.slice(7)}` : raw;
}

const VERIFIED_INDOOR_CATEGORY_CODES = new Set([
  "A02060100", // museum
  "A02060200", // memorial hall
  "A02060300", // exhibition hall
  "A02060400", // convention centre
  "A02060500", // art museum / gallery
  "A02060600", // performance hall
  "A02060700", // cultural centre
  "A02060800", // library
  "A02060900", // large bookstore
  "A02061000", // cultural school
  "A02061100", // cinema
  "A04010100", // department store
  "A04010200", // shopping centre
  "A04010400", // duty-free shop
]);

export function hasVerifiedIndoorEvidence(item: KtoItem): boolean {
  const contentTypeId = stringValue(item.contenttypeid);
  const title = stringValue(item.title);
  const legacyCategoryCode = stringValue(item.cat3).toUpperCase();
  const officialLevel2Code = stringValue(item.lclsSystm2).toUpperCase();
  const officialLevel3Code = stringValue(item.lclsSystm3).toUpperCase();
  /* 신분류의 공원/자연휴양 분류는 이름과 콘텐츠 유형보다 우선한다. 반대로
     VE07 전시·문화시설은 공식 분류 자체가 실내 근거다. */
  if (["VE02", "VE03", "NA04"].includes(officialLevel2Code)) return false;
  if (
    officialLevel2Code === "VE07" ||
    officialLevel3Code.startsWith("VE07")
  ) {
    return true;
  }

  const explicitOutdoor =
    /공원|산책로|둘레길|트레킹|해변|해수욕장|광장|정원|수목원|숲|산\b|계곡|폭포|캠핑|야영|전망대|유적|고궁|궁궐|성곽|섬|항구|시장/i.test(
      `${title} ${stringValue(item.cat1)} ${stringValue(item.cat2)}`,
    );
  if (explicitOutdoor) return false;
  if (VERIFIED_INDOOR_CATEGORY_CODES.has(legacyCategoryCode)) return true;

  /* Food establishments are an indoor TourAPI content class unless the
     record explicitly describes an outdoor venue above. Culture and shopping
     are too broad (parks and traditional markets are often classified there),
     so they additionally require an indoor-specific name. */
  if (contentTypeId === "39") return true;
  const explicitIndoorName =
    /박물관|미술관|전시관|기념관|과학관|도서관|문화관|문화센터|공연장|극장|영화관|아쿠아리움|수족관|백화점|쇼핑몰|면세점|실내|갤러리|체험관/i.test(
      title,
    );
  return (
    explicitIndoorName &&
    (contentTypeId === "14" || contentTypeId === "38")
  );
}

function positiveAccessibility(value: string): boolean {
  if (!value) return false;
  /* `단차 없음`·`턱 없음`·`장애물 없음`은 장애물이 **없다**는 뜻이므로 무장애
     여행자에게는 가장 강한 긍정 진술이다. `없음`이라는 글자만 보고 부정으로
     처리하면 동선을 가장 정확하게 적어 둔 기록이 버려지고, 대신 `대여 가능`처럼
     동선과 무관한 한 줄이 등급을 올린다 — 운영시간 판정에서 겪은 역선택과 같은
     형태다. 부정 판정 전에 이 표현을 걷어낸다. */
  const withoutBarrierAbsence = value.replace(
    /(?:단차|문턱|턱|계단|장애물|경사)\s*(?:이|가)?\s*없(?:음|다|이|어|습니다)/gu,
    " ",
  );
  return !/(없음|불가|미제공|해당\s*없음|미확인|확인\s*불가|not available|none)/i.test(
    withoutBarrierAbsence,
  );
}

/* 무장애 필드의 값이 "빌려준다"만 말하는가.
 *
 * `wheelchair` 필드는 동선 정보일 때도 있고 대여 정보일 때도 있다. 부정 키워드가
 * 없다는 것만 확인하면 `'대여가능(동백섬 내 누리마루)'`이 "내부 이동 확인"으로
 * 승격되고, 그 한 줄로 야외 해안 산책로가 등급 A·자동 적용 가능이 됐다. 가상
 * 페르소나 조사에서 실제로 그랬고, 기획 14.2의 `정보 없는 후보의 오인 통과 0건`의
 * 반례 1호였다.
 *
 * 휠체어를 직접 가져오는 이용자에게 "대여 1대 있음"은 동선 근거가 아니다. 대여
 * 이야기만 있으면 필수 항목을 충족시키지 않고 보조 정보로만 남긴다. 정보를 버리는
 * 것이 아니라 등급을 올리는 근거로 쓰지 않는 것이다. */
function rentalOnlyAccessibility(value: string): boolean {
  if (!value) return false;
  const mentionsRental = /(대여|렌탈|렌털|보유|rental|rent)/i.test(value);
  if (!mentionsRental) return false;
  /* 같은 문장에 동선 표현이 함께 있으면 동선 근거로 인정한다. */
  const mentionsMobility =
    /(이동|통행|접근|진입|경사|단차|턱\s*없|평탄|엘리베이터|승강기|리프트|ramp|accessible|step[-\s]?free)/i.test(
      value,
    );
  return !mentionsMobility;
}

function accessibilityFields(
  audience: RecoveryRequest["audience"],
): string[] {
  /* `assisted`는 유아차·휠체어·고령자를 하나로 합친 값이다.
     셋을 따로 두었지만 실제 판정은 갈리지 않았다 — 휠체어와 고령자는 조회
     필드도 필수 항목도 **완전히 같았고**, 유아차만 `stroller` 필드를 따로
     봤다. 고르는 사람에게는 세 갈래인데 결과는 두 갈래였으니, 그 선택은
     대부분 아무 일도 하지 않으면서 입력 부담만 늘렸다.

     합치면서 확인 대상은 셋의 합집합으로 둔다. 좁히는 것이 아니라 넓히는
     방향이다 — 유아차 이용자도 엘리베이터가 확인되면 내부 이동을 인정받고,
     휠체어 이용자도 유아차 통행 기록이 있으면 근거로 쓴다. */
  if (audience === "assisted") {
    return [
      "stroller",
      "wheelchair",
      "elevator",
      "exit",
      "restroom",
      "parking",
      "lactationroom",
      "babysparechair",
    ];
  }
  if (audience === "stroller") {
    return [
      "stroller",
      "exit",
      "lactationroom",
      "babysparechair",
      "restroom",
      "parking",
    ];
  }
  if (audience === "wheelchair") {
    return ["wheelchair", "elevator", "restroom", "parking", "exit"];
  }
  if (audience === "senior") {
    return ["elevator", "restroom", "parking", "exit", "wheelchair"];
  }
  return [];
}

function evaluateAccessibility(
  audience: RecoveryRequest["audience"],
  item?: KtoItem,
): AccessibilityEvidence {
  if (audience === "general") {
    return {
      status: "not_required",
      grade: "A",
      audience,
      confirmedFields: [],
      requiredChecks: [],
      supplementalFields: [],
      note: "이동 편의 조건을 따로 요청하지 않았습니다.",
      noteEn: "You did not request any specific mobility condition.",
    };
  }

  if (!item) {
    return {
      status: "unverified",
      grade: "X",
      audience,
      confirmedFields: [],
      requiredChecks: [],
      supplementalFields: [],
      note: "한국관광공사 무장애여행정보에서 이 곳의 편의정보를 찾지 못했습니다.",
      noteEn:
        "No barrier-free facility record was found for this place in the official data.",
    };
  }

  const allFields = accessibilityFields(audience)
    .map((field) => ({ field, value: stringValue(item[field]) }))
    .filter((entry) => positiveAccessibility(entry.value));
  const requiredGroups =
    audience === "assisted"
      ? [
          { label: "출입 동선", fields: ["exit"] },
          {
            /* 유아차·휠체어·보행보조 중 무엇이든 안에서 다닐 수 있다는
               근거가 하나라도 있으면 인정한다. */
            label: "내부 이동",
            fields: ["elevator", "wheelchair", "stroller"],
          },
        ]
      : audience === "stroller"
      ? [
          { label: "유아차 이용 정보", fields: ["stroller"] },
          { label: "출입 동선", fields: ["exit"] },
        ]
      : [
          { label: "출입 동선", fields: ["exit"] },
          {
            label: "내부 이동",
            fields: ["elevator", "wheelchair"],
          },
        ];
  /* 필수 항목을 충족시킬 수 있는 필드에서 대여 전용 값을 뺀다. `elevator`는
     설비 자체를 말하므로 그대로 두고, `wheelchair`처럼 대여로도 쓰이는 필드만
     걸러진다. */
  const confirmedForRequired = new Set(
    allFields
      .filter((entry) => !rentalOnlyAccessibility(entry.value))
      .map((entry) => entry.field),
  );
  const requiredChecks = requiredGroups.map((group) => ({
    label: group.label,
    status: group.fields.some((field) => confirmedForRequired.has(field))
      ? ("confirmed" as const)
      : ("missing" as const),
    fields: group.fields,
  }));
  const confirmedRequiredCount = requiredChecks.filter(
    (check) => check.status === "confirmed",
  ).length;
  const supplementalFieldNames =
    audience === "assisted"
      ? ["lactationroom", "babysparechair", "restroom", "parking"]
      : audience === "stroller"
      ? ["lactationroom", "babysparechair", "restroom", "parking"]
      : ["restroom", "parking"];
  const supplementalFields = allFields.filter((entry) =>
    supplementalFieldNames.includes(entry.field),
  );
  const complete = confirmedRequiredCount === requiredChecks.length;
  const partial = confirmedRequiredCount > 0;
  const grade = complete
    ? supplementalFields.length
      ? "A"
      : "B"
    : partial
      ? "C"
      : "X";

  return {
    status: complete ? "verified" : partial ? "partial" : "unverified",
    grade,
    audience,
    confirmedFields: allFields,
    requiredChecks,
    supplementalFields,
    note: complete
      ? `접근성 필수 동선을 모두 확인했습니다(등급 ${grade}). 화장실·주차 등 보조정보는 별도로 표시합니다.`
      : partial
        ? "접근성 필수 동선 중 일부만 확인되어 자동 적용 가능한 복구안에서는 제외합니다."
        : "접근성 필수 동선을 확인하지 못해 자동 복구안에서 제외합니다.",
  };
}

function auditFromFailure(
  service: KtoServiceName,
  operation: string,
  error: unknown,
): KtoAudit {
  if (error instanceof KtoError) return error.audit;
  return {
    apiName: service,
    operation,
    status: "error",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: [],
    errorCode: "UNKNOWN",
    /* `KtoError`가 아닌 실패는 클라이언트 밖에서 난 것이므로 실제로 몇 건이
       나갔는지 알 수 없다. 예산을 적게 세는 쪽으로 틀리면 한도를 넘기므로
       한 건 나간 것으로 본다. */
    upstreamCalls: 1,
  };
}

function notRequiredAudit(
  service: KtoServiceName,
  operation: string,
  reason?: string,
): KtoAudit {
  return {
    apiName: service,
    operation,
    status: "not_required",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: [],
    ...(reason ? { errorCode: reason } : {}),
    /* 부르지 않기로 한 호출이다. 예산을 청구하면 안 된다 — 이 항목들이 원장에
       쌓여 계량기를 밀어 올리고 있었다. */
    upstreamCalls: 0,
  };
}

/* 원장에 적힌 **실제 외부 호출 수**. 항목 수가 아니다. */
function upstreamCallsSpent(ledger: KtoAudit[]): number {
  return ledger.reduce(
    (total, audit) => total + (audit.upstreamCalls ?? 1),
    0,
  );
}

function publicAvailability(
  evidence: AvailabilityEvidence,
): PublicAvailabilityEvidence {
  const { audit: _audit, ...publicEvidence } = evidence;
  void _audit;
  return publicEvidence;
}

function unknownAvailability(
  note = "공식 운영정보를 확인하지 못했습니다.",
): PublicAvailabilityEvidence {
  return {
    status: "unknown",
    checkedAt: new Date().toISOString(),
    note,
  };
}

function operatingStatusRejection(params: {
  candidate: Pick<
    WorkingCandidate,
    "contentId" | "title" | "distanceMeters"
  >;
  availability: PublicAvailabilityEvidence;
  lookupFailed: boolean;
  changedNodeCount: number;
  /* 운영시간을 대조하지 못한 곳을 목록에서 지우지 않고, 적용 직전에 확인을
     받을 것인가. 문이 닫혀 있다고 **확인된** 곳과 제공자에 **연결하지 못한**
     곳은 이 값과 무관하게 계속 제외한다 — 앞의 것은 미확인이 아니라 확인된
     사실이고, 뒤의 것은 보여 줄 근거 자체가 없다. */
  allowUnconfirmedHours?: boolean;
}): RejectedCandidate | undefined {
  if (params.availability.status === "confirmed_open") return undefined;
  if (
    params.allowUnconfirmedHours &&
    !params.lookupFailed &&
    params.availability.status !== "confirmed_closed"
  ) {
    return undefined;
  }
  const reasonCode: RejectionReasonCode =
    params.availability.status === "confirmed_closed"
      ? "OFFICIALLY_CLOSED"
      : params.lookupFailed
        ? "OPERATING_STATUS_UPSTREAM_UNAVAILABLE"
        : "OPERATING_STATUS_UNCONFIRMED";
  const reason =
    reasonCode === "OFFICIALLY_CLOSED"
      ? "공식 운영정보상 제안된 방문 구간에 운영하지 않아 제외했습니다."
      : reasonCode === "OPERATING_STATUS_UPSTREAM_UNAVAILABLE"
        ? "공식 운영정보 제공자에 연결하지 못해 방문 가능 여부를 검증할 수 없어 제외했습니다. 잠시 후 다시 시도할 수 있습니다."
        : "공식 응답은 받았지만 제안된 체류 구간 전체가 운영 중임을 확인할 수 없어 제외했습니다.";
  return {
    contentId: params.candidate.contentId,
    title: params.candidate.title,
    reasonCode,
    reason,
    distanceMeters: params.candidate.distanceMeters,
    changedNodeCount: params.changedNodeCount,
    verificationDepth: "route_verified",
  };
}

/* 집중률 예측의 오늘 값과, 그 값이 **그 장소 자신의 최근 분포에서 어디인지.**
 *
 * 이 API는 시군구당 관광지 x 30일 시계열을 준다. 예전에는 오늘 하루치만 쓰고
 * 29일치를 버렸다. 서울 종로 113곳 x 30일을 실측해 분산을 나눠 보면 장소 간
 * 변동 13.49, 장소 내 변동 13.28로 **거의 같다.** 즉 버린 29일치에 값의 절반이
 * 들어 있었다 — 같은 60점이 그 장소의 평소보다 유난히 붐비는 날일 수도, 유난히
 * 한적한 날일 수도 있다.
 *
 * 백분위는 단위 정의에 의존하지 않으므로 절대값과 함께 쓸 수 있다. 시간 단위
 * 값은 이 API에 없으므로 "지금 붐빔이 오르고 있다"는 판정은 하지 않는다. */
function currentForecastByTitle(
  items: KtoItem[],
  referenceAt = new Date(),
): Map<
  string,
  {
    rate: number;
    baseDate: string;
    /* 0~100. 오늘 값이 30일 분포에서 몇 번째 백분위인가. */
    percentileOfSeries?: number;
    seriesDays?: number;
    seriesMin?: number;
    seriesMax?: number;
  }
> {
  const koreaDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceAt);
  const koreaDate = Object.fromEntries(
    koreaDateParts.map((part) => [part.type, part.value]),
  );
  const today = `${koreaDate.year}${koreaDate.month}${koreaDate.day}`;
  const grouped = new Map<
    string,
    Array<{ rate: number; baseDate: string }>
  >();

  for (const item of items) {
    const name = normalizeName(stringValue(item.tAtsNm));
    const rate = numberInRange(item.cnctrRate, 0, 100);
    const baseDate = stringValue(item.baseYmd);
    if (!name || rate === undefined || !baseDate) continue;
    const values = grouped.get(name) ?? [];
    values.push({ rate, baseDate });
    grouped.set(name, values);
  }

  const selected = new Map<
    string,
    {
      rate: number;
      baseDate: string;
      percentileOfSeries?: number;
      seriesDays?: number;
      seriesMin?: number;
      seriesMax?: number;
    }
  >();
  for (const [name, values] of grouped) {
    values.sort((a, b) => a.baseDate.localeCompare(b.baseDate));
    const chosen =
      values.find((value) => value.baseDate >= today) ??
      values[values.length - 1];
    /* 하루치만 온 장소는 분포가 없다. 그때 백분위를 0이나 100으로 적으면
       없는 근거를 만들어 내는 것이므로 비워 둔다. */
    if (values.length < 7) {
      selected.set(name, chosen);
      continue;
    }
    const rates = values.map((value) => value.rate);
    const atOrBelow = rates.filter((rate) => rate <= chosen.rate).length;
    selected.set(name, {
      ...chosen,
      percentileOfSeries: Math.round((atOrBelow / rates.length) * 100),
      seriesDays: rates.length,
      seriesMin: Math.min(...rates),
      seriesMax: Math.max(...rates),
    });
  }
  return selected;
}

/* 혼잡을 피하려는 사용자에게 줄 수 있는 점수. 높을수록 덜 붐빈다.
 *
 * 이 지표가 무엇인지 실측으로 확인한 것과 확인하지 못한 것을 나눠 둔다.
 *
 * 확인한 것 (서울 종로 113곳 x 30일):
 * - 장소 간 변동(각 장소 30일 평균의 표준편차) 13.49, 장소 내 변동(각 장소
 *   30일 표준편차의 평균) 13.28. **비율 1.02로 두 성분이 거의 같다.** 즉 값은
 *   절반은 그 장소의 성격이고 절반은 그날의 사정이다. 어느 한쪽으로만 읽으면
 *   절반을 버린다.
 * - 장소 평균은 실제 유동인구를 따르지 않는다. 청와대 37.1이 경운동민병옥가옥
 *   81.5보다 낮다. 따라서 이 값을 "사람 수"로 읽으면 안 된다. 좁은 한옥이
 *   적은 인원으로도 포화될 수 있다는 뜻의 **포화도**에 가깝다.
 * - 값은 일 단위다. 시간 단위가 없으므로 "지금 붐빔이 오르는 중"은 판정하지
 *   않는다.
 *
 * 확인하지 못한 것: 공식 필드 정의. 그래서 어느 쪽도 단정하지 않고 두 성분을
 * 모두 쓴다. 절대값을 주 축으로 두되(포화도로서 여행객의 체감에 가깝다),
 * 그 장소 자신의 최근 분포에서 유난히 높거나 낮은 날은 양 끝에서만 보정한다.
 * 보정 폭을 작게 두는 이유는 어느 해석도 확정되지 않았기 때문이다.
 *
 * 점수와 정렬과 라벨이 이 함수 하나를 쓴다. 따로 적어 두면 갈라진다. 실제로
 * 갈려서 집중률 63.77 후보에 "덜 붐빌 것으로 예측된 곳" 라벨이 붙고 그 위
 * 카드가 14.01이었다. */
function crowdComfortScore(candidate: {
  crowdRate?: number;
  crowdPercentile?: number;
  crowdBasis?: "place" | "nearby" | "district";
}): number {
  if (candidate.crowdRate === undefined) return 50;
  /* 단조 감소로 바꿨다. 예전에는 60·80을 경계로 한 3단 계단이어서 61과 79가
     같은 점수를 받았다. 이제 후보 대부분이 값을 받으므로 그 손실을 감출
     이유가 없다. */
  let score = 100 - candidate.crowdRate * 0.8;
  if (candidate.crowdPercentile !== undefined) {
    if (candidate.crowdPercentile >= 85) score -= 12;
    else if (candidate.crowdPercentile <= 15) score += 8;
  }
  /* 주변에서 빌려 온 값은 중립 쪽으로 줄인다. 같은 크기라도 이 장소를 직접
     잰 값보다 확실하지 않으므로, 직접 잰 후보와 나란히 놓았을 때 그것을
     이기고 올라가서는 안 된다. */
  if (candidate.crowdBasis === "nearby") score = 50 + (score - 50) * 0.6;
  /* 시군구 전체 값은 후보 사이를 가르지 못한다(모두 같은 값을 받는다). 순위에
     끼어들지 못하도록 더 크게 줄인다 — 보여 줄 값이지 정렬할 값이 아니다. */
  if (candidate.crowdBasis === "district") score = 50 + (score - 50) * 0.25;
  return Math.round(Math.min(100, Math.max(0, score)));
}

/* 붐빔 조회는 완전 일치만 봤다. 그래서 서울 종로에서 집중률 3,390행과
   1,650행을 **정상으로 받고도** 대안 8건이 전부 "공식 정보 없음"이었다.
   호출이 아니라 이름이 문제였다: 공사의 두 API가 같은 곳을 `성심당` /
   `성심당본점`처럼 다르게 적는다.

   연관 관광지 쪽에는 이미 앞뒤 부분 일치가 있었는데 이쪽에만 없었다. 같은
   규칙을 준다. 접두·접미로만 맞추고 최소 길이를 두는 것은 `관`·`공원` 같은
   짧은 조각이 아무 곳에나 붙는 것을 막기 위해서다. */
const FORECAST_MIN_SHARED_LENGTH = 3;

function findForecastMatch<T>(
  forecasts: Map<string, T>,
  title: string,
): T | undefined {
  const normalized = normalizeName(title);
  if (!normalized) return undefined;
  const exact = forecasts.get(normalized);
  if (exact) return exact;
  let best: T | undefined;
  let bestLength = 0;
  for (const [name, value] of forecasts) {
    if (name.length < FORECAST_MIN_SHARED_LENGTH) continue;
    if (!normalized.startsWith(name) && !normalized.endsWith(name)) continue;
    /* 여러 개가 걸리면 가장 긴 것을 쓴다 — 더 구체적인 이름이 더 옳다. */
    if (name.length > bestLength) {
      best = value;
      bestLength = name.length;
    }
  }
  return best;
}

/* 집중률 데이터셋은 **관광지 전용**이다. 반경 5km 후보를 유형별로 세어 보면
   음식점은 대전 중구 45곳·서울 종로구 86곳에서 매칭 0곳이고, 축제행사·숙박·
   레포츠도 0%다. 관광지조차 26~27%에 그친다. 표본이 적어서가 아니라 대상에
   없다.

   그런데 우리는 이미 **시군구 전체 30일 시계열**을 받아 온다(종로 3,390행).
   매칭된 곳에는 좌표가 있으므로, 값이 없는 후보는 가까운 이웃들의 값을 빌려
   올 수 있다. 추가 호출이 한 건도 들지 않는다.

   성심당 옆 골목 식당에 "이 일대가 오늘 얼마나 붐비는가"는 실제로 유효한
   정보다. 다만 빌려 온 값임을 반드시 밝힌다 — 그 장소를 직접 잰 값과 같은
   얼굴로 내보내면 근거를 부풀리는 것이다.

   중앙값을 쓴다. 평균은 관광지 한 곳의 극단값이 골목 전체를 물들인다. */
function districtRatesFrom(items: KtoItem[]): number[] {
  let latest = "";
  for (const item of items) {
    const date = stringValue(item.baseYmd);
    if (date && date > latest) latest = date;
  }
  if (!latest) return [];
  const rates: number[] = [];
  for (const item of items) {
    if (stringValue(item.baseYmd) !== latest) continue;
    const rate = numberInRange(item.cnctrRate, 0, 100);
    if (rate !== undefined) rates.push(rate);
  }
  return rates;
}

const CROWD_NEIGHBOR_RADIUS_METERS = 800;
const CROWD_NEIGHBOR_MIN_SAMPLES = 2;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function withNeighborCrowd<
  T extends {
    latitude: number;
    longitude: number;
    crowdRate?: number;
    crowdPercentile?: number;
    crowdBaseDate?: string;
    crowdBasis?: "place" | "nearby" | "district";
    crowdNeighborCount?: number;
    crowdNeighborMeters?: number;
  },
>(candidates: T[], districtRates: number[]): T[] {
  const measured = candidates.filter(
    (candidate) => candidate.crowdBasis === "place",
  );
  /* 시군구 전체의 오늘 값. 이 지역에 집중률 데이터가 한 줄이라도 있으면
     **모든 후보가 최소한 이 값은 받는다.** 그 장소를 잰 값이 아니므로 가장
     약한 근거지만, 아무것도 못 주는 것보다는 낫다 — 여행자가 다른 지역과
     견줄 때 쓸 수 있고, 무엇 기준인지 꼬리표로 밝힌다. */
  const districtRate = districtRates.length
    ? medianOf(districtRates)
    : undefined;
  if (!measured.length && districtRate === undefined) return candidates;
  return candidates.map((candidate) => {
    if (candidate.crowdBasis === "place") return candidate;
    const near = measured
      .map((other) => ({
        other,
        meters: haversineMeters(candidate, other),
      }))
      .filter((entry) => entry.meters <= CROWD_NEIGHBOR_RADIUS_METERS);
    if (near.length < CROWD_NEIGHBOR_MIN_SAMPLES) {
      if (districtRate === undefined) return candidate;
      return {
        ...candidate,
        crowdRate: districtRate,
        crowdBasis: "district" as const,
      };
    }
    const percentiles = near
      .map((entry) => entry.other.crowdPercentile)
      .filter((value): value is number => value !== undefined);
    return {
      ...candidate,
      crowdRate: medianOf(near.map((entry) => entry.other.crowdRate ?? 0)),
      crowdPercentile: percentiles.length ? medianOf(percentiles) : undefined,
      crowdBaseDate: near[0].other.crowdBaseDate,
      crowdBasis: "nearby" as const,
      crowdNeighborCount: near.length,
      crowdNeighborMeters: Math.round(
        Math.min(...near.map((entry) => entry.meters)),
      ),
    };
  });
}

/* 붐빔 정도를 세 단계로. **점수와 같은 함수에서 뽑는다** — 따로 계산하면
   갈라지고, 이 프로젝트는 그 갈림으로 라벨이 자기 카드의 수치와 반대가 된 적이
   있다.

   숫자를 그대로 보여 주던 문구("집중률 예측 39.04/100이고, 최근 30일 예측 중
   60번째 백분위입니다")는 여행자가 묻지 않은 것을 답한다. 알고 싶은 것은
   "붐비나?" 하나이고, 백분위는 그 답을 계산하라고 떠넘기는 것이다. 원문 수치는
   근거 확인용으로 남겨 두고 카드에서는 세 단어로 말한다. */
export type CrowdLevel = "easy" | "normal" | "busy";

function crowdLevelOf(candidate: {
  crowdRate?: number;
  crowdPercentile?: number;
  crowdBasis?: "place" | "nearby" | "district";
}): CrowdLevel | undefined {
  if (candidate.crowdRate === undefined) return undefined;
  const score = crowdComfortScore(candidate);
  if (score >= 70) return "easy";
  if (score >= 40) return "normal";
  return "busy";
}

/* 연관 관광지의 대분류를 후보의 콘텐츠 유형으로 옮긴다. 실데이터의 대분류는
   `음식`·`숙박`·`관광지` 셋뿐이어서(서울 종로·부산 해운대·제주 3,000여 행 확인)
   모호함 없이 매핑된다. */
function relatedCategoryAllowsType(
  majorCategory: string,
  contentTypeId: string,
): boolean {
  if (majorCategory === "음식") return contentTypeId === "39";
  if (majorCategory === "숙박") return contentTypeId === "32";
  if (majorCategory === "관광지") {
    return contentTypeId !== "39" && contentTypeId !== "32";
  }
  /* 모르는 분류는 통과시키지 않는다. 새 분류가 생겼을 때 조용히 느슨해지는
     것보다 연결하지 않는 쪽이 안전하다. */
  return false;
}

type RelatedMatch = { rank: number; majorCategory: string };

function relatedRankByTitle(
  items: KtoItem[],
  originLabel: string,
): Map<string, RelatedMatch> {
  const ranks = new Map<string, RelatedMatch>();
  const normalizedOrigin = normalizeName(originLabel);
  if (!normalizedOrigin || normalizedOrigin === normalizeName("현재 위치")) {
    return ranks;
  }
  for (const item of items) {
    if (normalizeName(stringValue(item.tAtsNm)) !== normalizedOrigin) continue;
    const name = normalizeName(stringValue(item.rlteTatsNm));
    const rank = numberInRange(item.rlteRank, 1, 100_000);
    if (!name || rank === undefined) continue;
    const current = ranks.get(name);
    if (current === undefined || rank < current.rank) {
      ranks.set(name, {
        rank,
        majorCategory: stringValue(item.rlteCtgryLclsNm),
      });
    }
  }
  return ranks;
}

/* 두 공사 API가 같은 장소를 다르게 표기한다. 연관 관광지는 `동백섬`, 국문
   관광정보는 `해운대 동백섬`처럼 시군구 접두어가 붙는다. 정확 일치만 보면
   실측에서 50개 연관 후보 중 6개만 연결됐다.

   그래서 한쪽이 다른 쪽을 경계에서 포함하는 경우까지 허용하되, **분류가
   맞을 때만** 연결한다. 분류 검사가 없으면 `동백섬횟집`(음식점)이 `동백섬`
   (자연관광)에 붙어 "함께 방문한 기록이 있는 곳"이라는 사실 주장이 거짓이 된다.
   실측 표본에서 이 규칙은 참 1건을 더 얻고 거짓 1건을 정확히 배제했다.

   기획 7.5의 "자동 매칭 신뢰도가 기준 미만이면 연결하지 않음"을 따른다. */
function findRelatedMatch(
  ranks: Map<string, RelatedMatch>,
  title: string,
  contentTypeId: string,
): number | undefined {
  const normalized = normalizeName(title);
  if (!normalized) return undefined;

  const exact = ranks.get(normalized);
  /* 이름이 같으면 그 자체로 가장 강한 신호다. 분류가 어긋나는 경우는 두 API의
     분류 체계 차이일 수 있으므로 이름 일치를 우선한다. */
  if (exact) return exact.rank;

  const MIN_SHARED_LENGTH = 3;
  let best: number | undefined;
  for (const [relatedName, match] of ranks) {
    if (relatedName.length < MIN_SHARED_LENGTH) continue;
    if (
      !normalized.startsWith(relatedName) &&
      !normalized.endsWith(relatedName)
    ) {
      continue;
    }
    if (!relatedCategoryAllowsType(match.majorCategory, contentTypeId)) {
      continue;
    }
    if (best === undefined || match.rank < best) best = match.rank;
  }
  return best;
}

function disruptedNode(input: RecoveryRequest): ItineraryNode | undefined {
  return input.itinerary?.nodes.find(
    (node) => node.id === input.itinerary?.disruptedNodeId,
  );
}

/* `tier`는 "관광·체험을 하려던 사람에게 이 유형이 얼마나 관광다운가"이다.
   식당·쇼핑을 후보에서 빼면 도심에서 대안이 거의 사라지므로(아래
   preservesTravelPurpose 주석의 실측) 제외하지 않는다. 대신 순위에서
   관광 콘텐츠를 앞세워, 박물관이 있는데 간장게장이 1순위로 올라오는 일을
   막는다. 점수 차이가 없으면 사용자는 고를 근거가 없다. */
function candidatePurpose(contentTypeId: string): {
  key: string;
  label: string;
  tier: "sightseeing" | "shopping" | "meal" | "stay" | "unknown";
} {
  const purposes: Record<
    string,
    { key: string; label: string; tier: "sightseeing" | "shopping" | "meal" | "stay" }
  > = {
    /* TourAPI content type 12 means the broad official "관광지" class. It
       does not prove that a place is nature tourism: streets, food alleys and
       media installations can legitimately use the same content type.
       Calling every item "자연 관광" invents a narrower classification and
       makes otherwise correct official data look broken to the traveller. */
    "12": { key: "attraction", label: "관광 명소", tier: "sightseeing" },
    "14": { key: "culture", label: "문화·전시 관람", tier: "sightseeing" },
    "15": { key: "festival", label: "축제·공연 관람", tier: "sightseeing" },
    "25": { key: "course", label: "여행 코스 체험", tier: "sightseeing" },
    "28": { key: "activity", label: "레포츠·체험", tier: "sightseeing" },
    "32": { key: "stay", label: "숙박", tier: "stay" },
    "38": { key: "shopping", label: "쇼핑·시장 방문", tier: "shopping" },
    "39": { key: "meal", label: "식사", tier: "meal" },
  };
  return purposes[contentTypeId] ?? {
    key: "visit",
    label: "관광 방문",
    tier: "unknown",
  };
}

function originalPurpose(node?: ItineraryNode): {
  key: string;
  label: string;
} {
  if (node?.type === "meal") return { key: "meal", label: "식사" };
  if (node?.type === "stay") return { key: "stay", label: "숙박" };
  if (node?.type === "transit") return { key: "transit", label: "이동" };
  return { key: "visit", label: "관광·체험" };
}

function preservesTravelPurpose(params: {
  input: RecoveryRequest;
  contentTypeId: string;
  relatedRank?: number;
}): boolean {
  const original = originalPurpose(disruptedNode(params.input));
  const replacement = candidatePurpose(params.contentTypeId);
  if (!params.input.itinerary) return true;
  if (params.relatedRank !== undefined) return true;

  /* 목적은 **순위 조건이고 탈락 조건이 아니다.**

     예전에는 선언된 목적을 엄격하게 지켰다 — 식사는 식사로만, 숙박은 숙박으로만,
     예약된 이동은 아예 대체하지 않았다(`return false`). 그런데 그 규칙이 후보를
     **지워 버린다.** 여행자가 복구 탭에서 고르는 것은 "어느 일정이 틀어졌는가"이고,
     식당을 고르면 공사 데이터에서 `contenttypeid=39`인 곳만 살아남는다. 반경 2km에
     그런 곳이 몇 곳뿐인 지역에서는 그대로 0건이 되고, 이동 일정을 고르면 무조건
     0건이었다. 실측에서 명동 요청의 탈락 24건이 전부 이 사유였다.

     같은 논리가 이미 `visit`에 적용돼 있었다. 위 주석이 그 근거를 적어 두었다 —
     열 개 시나리오에서 336건 중 226건을 지웠고 여행자에게는 아무것도 남지 않았다.
     목적이 `visit`일 때 그것이 틀렸다면, `meal`·`stay`·`transit`일 때도 틀렸다.
     문제는 목적의 종류가 아니라 **목적을 탈락 조건으로 쓴 것**이다.

     그리고 순위 쪽에는 이미 올바른 장치가 있다. `pickOptions`는 목적을 지키는
     후보가 하나라도 있으면 그 안에서만 고르고, 하나도 없을 때에만 바뀐 후보를
     제시한다(`purposePreserving` 풀과 그 폴백). 여기서 미리 지워 버리면 그 장치가
     볼 것이 없어진다. 바뀐 사실은 `buildTravelPurposeProof`가
     `changed_visit_category`로 증명서에 남기고 카드가 그것을 말한다.

     즉 지금 하는 일은 하나다: 목적으로는 아무도 지우지 않는다. */
  void original;
  void replacement;
  return true;
}

function buildTravelPurposeProof(params: {
  input: RecoveryRequest;
  replacementTitle: string;
  contentTypeId: string;
  relatedRank?: number;
}): TravelPurposeProof {
  const node = disruptedNode(params.input);
  const original = originalPurpose(node);
  const replacement = candidatePurpose(params.contentTypeId);
  const originalStopTitle = node?.title ?? params.input.origin.label;

  /* 빈 시간 추천에는 보존할 원래 목적이 없다. 여기서 기존 분기를 그대로 타면
     "원래 하려던 관광·체험 대신…"처럼 사용자가 말한 적 없는 계획을 근거로
     제시하게 된다. 다음 장소를 알려 준 경우에만 그 장소와의 연결을 주장하고,
     아니면 아무 목적도 주장하지 않는다. */
  const openWindow = params.input.openWindow;
  if (openWindow) {
    const nextPlaceLabel = openWindow.nextPlace?.label;
    if (nextPlaceLabel) {
      return {
        status: "open_window_flow",
        originalPurpose: "조회 기준 시각부터 비어 있는 시간",
        replacementPurpose: replacement.label,
        originalStopTitle: nextPlaceLabel,
        replacementTitle: params.replacementTitle,
        evidenceSource:
          params.relatedRank !== undefined
            ? "TarRlteTarService1"
            : "KorService2",
        relatedRank: params.relatedRank,
        statement:
          params.relatedRank !== undefined
            ? `${withParticle(nextPlaceLabel, "와/과")} 함께 방문한 기록이 실제로 있는 곳입니다.`
            : `${withParticle(nextPlaceLabel, "으로/로")} 가는 길에 들를 수 있는 공식 관광 콘텐츠입니다.`,
        statementEn:
          params.relatedRank !== undefined
            ? `Official data records real visits to this place together with ${nextPlaceLabel}.`
            : `Official tourism content you can stop at on the way to ${nextPlaceLabel}.`,
      };
    }
    return {
      status: "open_window_unconstrained",
      originalPurpose: "조회 기준 시각부터 비어 있는 시간",
      replacementPurpose: replacement.label,
      originalStopTitle: params.input.origin.label,
      replacementTitle: params.replacementTitle,
      /* 보존할 목적이 없으므로 목적 근거로 쓴 공사 API도 없다. */
      evidenceSource: "none",
      /* 뒷문장("원래 계획을 알려 주지 않으셨으므로 목적 유지 여부는 판단하지
         않았습니다")을 뺐다. 그것은 이 화면의 모든 카드에 똑같이 붙는 내부
         판정 기록이고, 카드를 고르는 사람에게는 아무것도 알려 주지 않는다.
         빈 시간 추천에서 원래 계획을 묻지 않는다는 사실은 입력 화면이 이미
         말한다. */
      statement: `남은 시간 안에 다녀올 수 있는 ${replacement.label}입니다.`,
      statementEn: `Official ${replacement.label} content you can visit and return from within your remaining time.`,
    };
  }

  if (params.relatedRank !== undefined) {
    return {
      status: "verified_related_place",
      originalPurpose: original.label,
      replacementPurpose: replacement.label,
      originalStopTitle,
      replacementTitle: params.replacementTitle,
      evidenceSource: "TarRlteTarService1",
      relatedRank: params.relatedRank,
      statement: `${withParticle(originalStopTitle, "와/과")} 함께 방문한 기록이 실제로 있는 곳입니다.`,
      statementEn: `Official data records real visits to this place together with ${originalStopTitle}.`,
    };
  }

  if (
    (original.key === "meal" && replacement.key === "meal") ||
    (original.key === "stay" && replacement.key === "stay")
  ) {
    return {
      status: "verified_activity_type",
      originalPurpose: original.label,
      replacementPurpose: replacement.label,
      originalStopTitle,
      replacementTitle: params.replacementTitle,
      evidenceSource: "KorService2",
      statement: `${original.label} 일정을 같은 종류의 장소로 이어갑니다. 활동은 바뀌지 않습니다.`,
      statementEn: `Your ${original.label} stop continues at a place of the same kind — the activity does not change.`,
    };
  }

  /* 관광·체험을 하려던 사람에게 관광 콘텐츠를 제안하는 경우에만 "목적을
     유지한다"고 말한다. 식사·쇼핑으로 바뀐 후보에 같은 문장을 쓰면 화면에
     "관광·체험 → 식사"라고 표시하면서 목적을 유지했다고 주장하는 모순이
     생긴다. 바뀐 것은 바뀐 대로 쓴다. */
  if (replacement.tier === "sightseeing" || replacement.tier === "unknown") {
    return {
      status: "supported_visit_category",
      originalPurpose: original.label,
      replacementPurpose: replacement.label,
      originalStopTitle,
      replacementTitle: params.replacementTitle,
      evidenceSource: "KorService2",
      /* 문장은 비운다. 관광 목적끼리 이어지는 것은 이 앱이 후보를 고르는
         전제라 모든 카드에 똑같이 붙었고, 같은 말이 모든 카드에 있으면
         카드를 고르는 데 아무 도움이 되지 않는다. 판정 자체(`status`)는
         남아 목적이 **바뀐** 경우에만 문장이 나간다. */
      statement: "",
      statementEn: "",
    };
  }

  return {
    status: "changed_visit_category",
    originalPurpose: original.label,
    replacementPurpose: replacement.label,
    originalStopTitle,
    replacementTitle: params.replacementTitle,
    evidenceSource: "KorService2",
    statement: `원래 하려던 ${original.label} 대신 ${replacement.label} 장소입니다. 남은 시간과 조건 안에서 갈 수 있는 공식 관광정보로 제안합니다.`,
    statementEn: `This is a ${replacement.label} place instead of the ${original.label} you planned. It is offered because it is reachable within your remaining time and conditions.`,
  };
}

function nodeSequence(node: ItineraryNode, index: number): number {
  return node.sequence ?? index;
}

function nodeSummary(
  node: ItineraryNode,
  index: number,
): ScheduleNodeSummary {
  return {
    id: node.id,
    sequence: nodeSequence(node, index),
    type: node.type,
    title: node.title,
    startAt: node.startAt,
    endAt: node.endAt,
    locked: node.locked,
    reservation: node.reservation,
  };
}

function plannedDurationMinutes(
  node: ItineraryNode,
  fallback: number,
): number {
  if (node.durationMinutes) return node.durationMinutes;
  if (node.startAt && node.endAt) {
    const minutes = Math.floor(
      (Date.parse(node.endAt) - Date.parse(node.startAt)) / 60_000,
    );
    if (minutes > 0) return minutes;
  }
  return fallback;
}

function itineraryContext(
  input: RecoveryRequest,
): ItineraryContext | undefined {
  const itinerary = input.itinerary;
  if (!itinerary) return undefined;
  const sortedNodes = [...itinerary.nodes].sort(
    (a, b) =>
      nodeSequence(a, itinerary.nodes.indexOf(a)) -
      nodeSequence(b, itinerary.nodes.indexOf(b)),
  );
  const disrupted = sortedNodes.find(
    (node) => node.id === itinerary.disruptedNodeId,
  );
  if (!disrupted) return undefined;
  const disruptedIndex = sortedNodes.indexOf(disrupted);
  const occurredAt = new Date(recoveryReferenceTime(input).at);
  const explicitNext = itinerary.nextFixedNodeId
    ? sortedNodes.find((node) => node.id === itinerary.nextFixedNodeId)
    : undefined;
  const nextFixed =
    explicitNext ??
    sortedNodes
      .slice(disruptedIndex + 1)
      .find(
        (node) =>
          (node.locked || node.reservation) &&
          Boolean(node.startAt) &&
          Boolean(node.location),
      );
  const nextFixedIndex = nextFixed
    ? sortedNodes.indexOf(nextFixed)
    : -1;
  return {
    mode: itinerary.id ? "registered_itinerary" : "inline_itinerary",
    changeKind: "replace",
    id: itinerary.id,
    title: itinerary.title,
    occurredAt:
      Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    disrupted,
    nextFixed,
    continuityNodes:
      nextFixedIndex > disruptedIndex
        ? sortedNodes.slice(disruptedIndex + 1, nextFixedIndex + 1)
        : [],
    sortedNodes,
    lockedNodeIds: sortedNodes
      .filter((node) => node.locked || node.reservation)
      .map((node) => node.id),
    originalDurationMinutes: plannedDurationMinutes(
      disrupted,
      input.minimumStayMinutes ?? 30,
    ),
  };
}

/* 빈 시간 추천의 컨텍스트. 사용자가 알려 준 것은 "지금 어디에 있고, 언제까지
   비어 있고, 한 곳에 얼마나 머물 생각인지"이고 다음 장소는 선택이다. 다음
   장소를 알려 준 경우에는 그 장소를 잠금 노드로 취급해 기존 연속성 검증을 그대로
   재사용한다. 알려 주지 않은 경우에는 보존 대상이 창의 끝 시각뿐이다. */
function openWindowContext(
  input: RecoveryRequest,
): ItineraryContext | undefined {
  const window = input.openWindow;
  if (!window) return undefined;
  const endAt = new Date(window.availableUntil);
  if (Number.isNaN(endAt.getTime())) return undefined;
  const requestedDepartureAt = new Date(
    recoveryReferenceTime(input).at,
  );
  const occurredAt = Number.isNaN(requestedDepartureAt.getTime())
    ? new Date()
    : requestedDepartureAt;

  const nextPlace = window.nextPlace;
  /* 약속 시각이 **주어졌을 때만** 마감이 된다. 주지 않았으면 이 장소는 방향
     힌트이고, 아래에서 `nextFixed`가 만들어지지 않으므로 검증은 출발지 왕복으로
     내려간다 — 즉 실제로 결과가 나오는 경로다. */
  const nextPlaceArriveBy = nextPlace?.arriveBy
    ? new Date(nextPlace.arriveBy)
    : undefined;
  const nextFixed: ItineraryNode | undefined =
    nextPlace && nextPlaceArriveBy && !Number.isNaN(nextPlaceArriveBy.getTime())
      ? {
          id: "open-window-next-place",
          sequence: 1,
          type: "other",
          title: nextPlace.label,
          startAt: nextPlaceArriveBy.toISOString(),
          locked: true,
          reservation: false,
          location: {
            latitude: nextPlace.latitude,
            longitude: nextPlace.longitude,
            label: nextPlace.label,
            areaCode: nextPlace.areaCode,
            sigunguCode: nextPlace.sigunguCode,
          },
        }
      : undefined;

  return {
    mode: "open_window",
    changeKind: "insert",
    title: "조회 기준 시각부터 비어 있는 시간",
    occurredAt,
    disrupted: undefined,
    nextFixed,
    continuityNodes: nextFixed ? [nextFixed] : [],
    sortedNodes: nextFixed ? [nextFixed] : [],
    lockedNodeIds: nextFixed ? [nextFixed.id] : [],
    originalDurationMinutes: window.plannedStayMinutes,
    openWindow: {
      /* 약속 시각이 자유 시간의 끝보다 앞서면 그쪽이 실제 마감이다. 늦으면
         자유 시간이 먼저 끝나므로 그쪽을 쓴다. 이른 쪽이 항상 이긴다. */
      endAt:
        nextFixed && nextPlaceArriveBy && nextPlaceArriveBy < endAt
          ? nextPlaceArriveBy
          : endAt,
      plannedStayMinutes: window.plannedStayMinutes,
      nextPlaceLabel: nextPlace?.label,
      nextPlaceArriveBy: nextFixed ? nextPlaceArriveBy : undefined,
      nextPlaceIsDirectionHint: Boolean(nextPlace) && !nextFixed,
      nextPlaceLocation: nextPlace
        ? {
            latitude: nextPlace.latitude,
            longitude: nextPlace.longitude,
          }
        : undefined,
    },
  };
}

function recoveryContext(
  input: RecoveryRequest,
): ItineraryContext | undefined {
  return input.openWindow
    ? openWindowContext(input)
    : itineraryContext(input);
}

function summariseItinerary(
  context: ItineraryContext | undefined,
): RecoveryResult["itinerarySummary"] {
  if (!context) return undefined;
  return {
    itineraryId: context.id,
    title: context.title,
    disruptedNodeId: context.disrupted?.id,
    nextFixedNodeId: context.nextFixed?.id,
    lockedNodeCount: context.lockedNodeIds.length,
  };
}

/* 제거실험 요약. 후보 수만 비교하면 "API를 끄니 별 차이 없다"로 읽히므로,
   사라진 판정 근거를 함께 센다. 실제로 연관 관광지를 끄면 후보 수는 그대로여도
   "함께 방문한 기록" 근거가 0이 되고 세 번째 카드의 축이 사라진다. */
const ABLATION_CAPABILITY: Record<string, string> = {
  TarRlteTarService1: "원래 일정과의 연계 방문 근거 (의도 보존)",
  TatsCnctrRateService: "향후 집중률 예측 기반 혼잡 회피",
  KorWithService2: "무장애·영유아·고령자 편의정보 검증",
};

function summariseAblation(
  input: RecoveryRequest,
  options: RecoveryOption[],
): RecoveryResult["ablation"] {
  const disabledSources = input.disabledSources ?? [];
  return {
    disabledSources,
    lostCapabilities: disabledSources.map(
      (source) => ABLATION_CAPABILITY[source] ?? source,
    ),
    verifiedOptionCount: options.filter(
      (option) => !option.confirmationRequired,
    ).length,
    confirmationRequiredCount: options.filter(
      (option) => option.confirmationRequired,
    ).length,
    relatedEvidenceCount: options.filter(
      (option) => option.relatedRank !== undefined,
    ).length,
    crowdEvidenceCount: options.filter(
      (option) => option.crowd.status === "available",
    ).length,
    accessibilityVerifiedCount: options.filter(
      (option) => option.accessibility.status === "verified",
    ).length,
  };
}

function summariseOpenWindow(
  context: ItineraryContext | undefined,
): RecoveryResult["openWindowSummary"] {
  const window = context?.openWindow;
  if (!context || !window) return undefined;
  return {
    windowStartAt: context.occurredAt.toISOString(),
    windowEndAt: window.endAt.toISOString(),
    windowMinutes: Math.max(
      0,
      Math.floor(
        (window.endAt.getTime() - context.occurredAt.getTime()) / 60_000,
      ),
    ),
    plannedStayMinutes: window.plannedStayMinutes,
    nextPlaceLabel: window.nextPlaceLabel,
    nextPlaceArriveBy: window.nextPlaceArriveBy?.toISOString(),
    nextPlaceIsDirectionHint: window.nextPlaceIsDirectionHint || undefined,
  };
}

function scoreCandidate(
  candidate: Omit<WorkingCandidate, "baseScore" | "comfortScore">,
  input: RecoveryRequest,
): { baseScore: number; comfortScore: number } {
  const minimumStayMinutes = input.minimumStayMinutes ?? 30;
  const safetyBufferMinutes = input.safetyBufferMinutes ?? 15;
  const openWindowStartMs = Date.parse(input.openWindow?.departureAt ?? "");
  const openWindowEndMs = Date.parse(input.openWindow?.availableUntil ?? "");
  const authoritativeAvailableMinutes =
    Number.isFinite(openWindowStartMs) && Number.isFinite(openWindowEndMs)
      ? Math.max(
          0,
          Math.floor((openWindowEndMs - openWindowStartMs) / 60_000),
        )
      : input.availableMinutes;
  const windowProof = candidate.scheduleDiff.openWindow;
  const appointmentProof = candidate.scheduleDiff.nextFixedAppointment;
  /* 거리값은 같은 5km라도 이동수단·경로에 따라 부담이 전혀 다르다. 실제 검증
     뒤에는 왕복/다음 장소까지의 경로 시간을, 그 전에는 수단별 보수 추정을 쓴다.

     경로 검증 **전** 순위가 문제였다. 다음 장소가 마감으로 들어온 요청에서는
     `candidate.estimatedTravelMinutes`, 즉 출발지→후보 구간만 보고 있었다.
     그런데 모든 후보를 탈락시키는 구간은 그 다음, 후보→다음 장소 쪽이다. 즉
     `slackScore`(가중치 최대 0.40)가 정작 판정을 가르는 구간에 대해 아무 정보도
     담지 않은 채 검증 순서를 정하고 있었다. 회로 추정값을 쓴다. */
  const travelBurdenMinutes = windowProof
    ? windowProof.travelToMinutes + windowProof.returnMinutes
    : (candidate.estimatedCircuitMinutes ??
      (input.openWindow && !input.openWindow.nextPlace
        ? candidate.estimatedTravelMinutes * 2
        : candidate.estimatedTravelMinutes));
  const availableTravelMinutes = Math.max(
    1,
    authoritativeAvailableMinutes -
      minimumStayMinutes -
      safetyBufferMinutes,
  );
  const timeBurdenScore = Math.max(
    0,
    Math.min(
      100,
      100 - (travelBurdenMinutes / availableTravelMinutes) * 100,
    ),
  );
  const slackMinutes = appointmentProof
    ? (appointmentProof.arrivalBufferMinutes ?? 0) -
      appointmentProof.safetyBufferMinutes
    : windowProof
      ? windowProof.leftoverMinutes - windowProof.requiredBufferMinutes
      : authoritativeAvailableMinutes -
        minimumStayMinutes -
        safetyBufferMinutes -
        travelBurdenMinutes;
  const slackScore = Math.max(0, Math.min(100, 50 + slackMinutes * 2));
  /* 같은 `supported_visit_category`에 84점을 일괄로 주면 박물관과 식당의
     총점이 88 대 86처럼 붙어서 사용자가 고를 근거가 사라진다. 유형별로
     벌린다. */
  const replacementTier = candidatePurpose(candidate.contentTypeId).tier;
  const categoryScore =
    replacementTier === "sightseeing"
      ? 92
      : replacementTier === "unknown"
        ? 80
        : replacementTier === "shopping"
          ? 70
          : 58;
  const purposeScore =
    candidate.purposePreservation.status === "verified_related_place"
      ? Math.max(76, 102 - (candidate.relatedRank ?? 1) * 1.2)
      : candidate.purposePreservation.status === "verified_activity_type"
        ? 96
        : categoryScore;
  const crowdScore = crowdComfortScore(candidate);
  const accessScore =
    input.audience === "general"
      ? 75
      : candidate.accessibility.status === "verified"
        ? 100
        : 0;
  const indoorScore = candidate.indoor ? 100 : 35;
  let baseScore: number;
  if (input.incident === "rain") {
    baseScore =
      timeBurdenScore * 0.15 +
      indoorScore * 0.25 +
      accessScore * 0.13 +
      purposeScore * 0.18 +
      crowdScore * 0.04 +
      slackScore * 0.25;
  } else if (input.incident === "crowd") {
    baseScore =
      timeBurdenScore * 0.14 +
      crowdScore * 0.24 +
      accessScore * 0.14 +
      purposeScore * 0.18 +
      slackScore * 0.3;
  } else if (input.incident === "less_walk") {
    /* `less_walk`는 엔진에 아예 없었다. 화면은 "보행 부담과 접근성 조건을 먼저
       통과한 후보만 제시합니다"라고 약속하는데 실제로는 `delay`와 똑같이 계산됐다.
       고른 상황이 결과를 바꾸지 않으면 그 선택지는 화면 장식이다.

       이동 부담을 줄이는 것이 목적이므로 실제 이동시간 가중을 가장 크게 두고
       접근성을 그다음에 둔다. 거리는 표시 정보일 뿐 탈락·점수 기준이 아니다. */
    baseScore =
      timeBurdenScore * 0.38 +
      accessScore * 0.22 +
      purposeScore * 0.12 +
      indoorScore * 0.04 +
      crowdScore * 0.02 +
      slackScore * 0.22;
  } else {
    baseScore =
      timeBurdenScore * 0.23 +
      accessScore * 0.13 +
      purposeScore * 0.18 +
      crowdScore * 0.06 +
      slackScore * 0.4;
  }

  const comfortScore =
    accessScore * 0.27 +
    indoorScore * 0.2 +
    crowdScore * 0.14 +
    timeBurdenScore * 0.12 +
    purposeScore * 0.1 +
    slackScore * 0.17;

  /* 날씨는 순위에 넣지 않는다.
     체류 시간대 강수·기온을 감점으로 넣어 봤지만, 그 임계값(강수확률 30·60%,
     기온 33℃)은 **실측으로 조정한 값이 아니다.** 검증되지 않은 숫자를 순위에
     박아 넣으면 사용자는 왜 이 순서인지 알 수 없고 우리도 방어할 수 없다.
     대신 예보를 시점별 아이콘으로 그대로 보여 주고 판단은 사용자가 한다.

     우천 상황을 고른 요청에서 실내를 선호하는 것은 그대로 동작한다 —
     `indoorScore`가 `rain` 분기에서 25% 가중치를 갖고, 그것은 사용자가 직접
     선언한 조건이다. 이 감점을 빼도 그 시나리오는 잃지 않는다. */
  return {
    baseScore: Math.round(baseScore * 10) / 10,
    comfortScore: Math.round(comfortScore * 10) / 10,
  };
}

/* 밤에도 운영할 가능성이 있는 분류인지. **정렬에만** 쓴다.

   이 값으로 후보를 버리거나 판정을 바꾸지 않는다 — 그건 공식 운영정보가 할 일이고,
   여기서 추측으로 대신하면 실제로 문을 연 곳을 놓친다. 하는 일은 순서 하나다:
   밤 요청에서 검증 예산을 어느 분류에 먼저 쓸지.

   그게 필요한 이유는 아래 라운드로빈이 11개 분류를 **균등하게** 돌기 때문이다.
   밤 10시에는 문화시설·체험관광처럼 구조적으로 닫힌 분류가 검증 슬롯의 절반
   가까이를 가져가고, 그 후보들은 운영정보 조회를 한 건씩 쓴 뒤 `OFFICIALLY_CLOSED`로
   떨어진다. 실측에서 밤 요청의 탈락 사유 1위가 이것이었다.

   최악의 경우에도 오늘과 같은 결과가 나온다(순서만 다름). 그래서 하방 위험이 없다.

   값은 추측이 아니라 **실측에 맞춘 것**이다. 대전역 22:11 KST 요청에서 통과한
   10곳은 전부 시장·거리·공원·광장(공식 분류 `PARK` 또는 신분류가 없어 `OTHER`로
   떨어지는 `contenttypeid=12` 관광지)이었고, 휴무로 탈락한 곳은 식당 4곳·축제
   1곳·라운지 1곳이었다. 첫 시도에서 식당을 "심야까지 열려 있는 쪽"으로 올려
   두었다가 같은 측정에서 4곳 전부 탈락하는 것을 보고 내렸다.

   근거가 한 지점·한 시각뿐이므로 나머지 분류는 중립(1)에 둔다. 지역과 시각을
   넓혀 다시 측정하면 그때 조정할 값이고, 그때까지 없는 근거를 있는 것처럼
   숫자로 박아 두지 않는다. */
const NIGHT_VIABILITY: Record<string, number> = {
  /* 실측에서 야간에 통과한 유형. 공공 공간이라 운영시간 개념이 약하다. */
  PARK: 0,
  OTHER: 0,
  /* 중립 — 아직 근거가 없다. */
  SHOPPING: 1,
  HERITAGE: 1,
  NATURE: 1,
  COURSE: 1,
  /* 영업·개관 시간이 정해져 있어 야간에 닫히는 것이 확인된 유형. */
  FOOD: 2,
  EVENT: 2,
  LEISURE: 2,
  CULTURE: 2,
  EXPERIENCE: 2,
  ACCOMMODATION: 2,
};

/* 체류가 시작될 시각이 밤인가. 한국 시간 기준이고, 판정은 정렬에만 쓰이므로
   경계는 넉넉하게 잡는다. */
function isNightWindow(referenceAt: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(referenceAt),
  );
  if (!Number.isFinite(hour)) return false;
  return hour >= 19 || hour < 8;
}

/* 점수 상위가 한 분류에 몰려 공원·문화유산·식당이 검증 단계에 도달하지 못하는
   것을 막는다. 공식 KTO 분류별 큐에서 한 곳씩 순환하므로 각 분류 내부 점수순은
   유지하면서 검증 풀의 발견 다양성을 확보한다. */
function diversifyCandidatesByCategory(
  candidates: WorkingCandidate[],
  options: { nightFirst?: boolean } = {},
): WorkingCandidate[] {
  const buckets = new Map<string, WorkingCandidate[]>();
  for (const candidate of candidates) {
    const code = ktoTourismCategory(candidate.item).code;
    const bucket = buckets.get(code) ?? [];
    bucket.push(candidate);
    buckets.set(code, bucket);
  }

  /* 낮에는 모든 분류가 한 묶음이다 — 지금까지의 균등 라운드로빈 그대로.

     밤에는 **계층**으로 나눈다. 분류 순서만 바꿔 보았지만 아무 차이가 없었다
     (대전역 10곳→10곳, 서울시청 9곳→9곳). 당연한 결과다: 라운드로빈은 각
     묶음에서 한 곳씩 가져가므로 묶음의 순서를 바꿔도 뽑히는 **집합**이 거의
     같고, 순서는 잘리는 경계에서만 의미가 있다.

     그래서 앞 계층을 다 쓴 **뒤에** 다음 계층으로 넘어간다. 계층 안에서는 여전히
     균등 라운드로빈이므로 다양성은 그 안에서 유지되고, 야간에 구조적으로 닫힌
     유형은 뒤로 밀린다. 후보를 버리지는 않으므로 앞 계층이 비면 그대로 흘러
     내려온다 — 최악의 경우가 오늘과 같은 결과라는 성질은 유지된다. */
  /* 분류 순회 **순서**만 야간 운영 가능성으로 정한다. 한 바퀴에서 모든 분류가
     한 곳씩 나오는 구조는 그대로다.

     앞서 계층으로 나눠 앞 계층을 다 쓴 뒤 넘어가게 해 봤는데, 그것이
     **분류 편중을 만들었다.** tier 0(공원 + 신분류가 없는 관광지 = 거리·시장·
     광장)이 대부분 도시에서 가장 큰 묶음이라, 야간 요청의 검증 풀 36칸이 그
     두 분류로 다 채워졌다. 실측에서 대전역 22:11 결과 10곳이 전부 시장·거리·
     광장·공원이었다. 이용자가 "공원만 거의 나온다"고 보고한 것이 이것이다.

     얻은 것과 잃은 것을 견주면 답이 분명하다 — 계층 소진으로 얻은 것은 서울시청
     한 곳에서 추천 +1이었고(대전역과 주간은 변화 없음), 잃은 것은 분류 균형
     전체였다. 균형이 불변식이고 야간 우선순위는 그 안에서만 작동해야 한다. */
  const order = [...buckets.keys()];
  if (options.nightFirst) {
    order.sort(
      (a, b) => (NIGHT_VIABILITY[a] ?? 1) - (NIGHT_VIABILITY[b] ?? 1),
    );
  }

  const diversified: WorkingCandidate[] = [];
  while (diversified.length < candidates.length) {
    let appended = false;
    for (const code of order) {
      const candidate = buckets.get(code)?.shift();
      if (!candidate) continue;
      diversified.push(candidate);
      appended = true;
    }
    if (!appended) break;
  }
  return diversified;
}

/* 표시 순서에서도 분류가 몰리지 않게 섞는다.

   검증 풀이 균형을 잡아도 화면은 그렇지 않았다. `pickOptions`의 꼬리가 남은
   후보를 **순수 총점순**으로 붙이기 때문이다. 같은 분류가 총점 상위를 차지하면
   목록의 아래쪽 전체가 그 분류가 된다 — 여행자가 보는 것은 이 순서다.

   분류 안의 총점순은 그대로 두고 분류 사이만 번갈아 놓는다. 후보를 버리지도,
   판정을 바꾸지도 않는다. 순서만 바뀐다. */
function interleaveByCategory(
  candidates: WorkingCandidate[],
): WorkingCandidate[] {
  const buckets = new Map<string, WorkingCandidate[]>();
  for (const candidate of candidates) {
    const code = ktoTourismCategory(candidate.item).code;
    const bucket = buckets.get(code) ?? [];
    bucket.push(candidate);
    buckets.set(code, bucket);
  }
  /* 큰 묶음부터 돌린다. 작은 묶음부터 돌리면 목록 앞쪽이 희귀 분류로 채워져
     "가까운 순"으로 읽히지 않는다. 같은 크기면 총점이 높은 쪽이 먼저다. */
  const order = [...buckets.entries()]
    .sort(
      (a, b) =>
        b[1].length - a[1].length ||
        (b[1][0]?.baseScore ?? 0) - (a[1][0]?.baseScore ?? 0),
    )
    .map(([code]) => code);
  const mixed: WorkingCandidate[] = [];
  while (mixed.length < candidates.length) {
    let appended = false;
    for (const code of order) {
      const candidate = buckets.get(code)?.shift();
      if (!candidate) continue;
      mixed.push(candidate);
      appended = true;
    }
    if (!appended) break;
  }
  return mixed;
}

async function accessibilityDetails(
  candidates: WorkingCandidate[],
  audience: RecoveryRequest["audience"],
  signal?: AbortSignal,
  deadlineAt?: number,
  /* 예산 계량기. 예전에는 이 함수가 계량기를 몰랐고 시간 마감만 봤다. 그래서
     후보 36곳 전부에 1건씩 호출해 요청 예산의 80%를 여기서 태웠다. */
  meter?: SubrequestMeter,
): Promise<{ details: Map<string, KtoItem>; audits: KtoAudit[] }> {
  if (audience === "general") return { details: new Map(), audits: [] };

  const details = new Map<string, KtoItem>();
  const audits: KtoAudit[] = [];

  for (let offset = 0; offset < candidates.length; offset += 4) {
    if (
      signal?.aborted ||
      (deadlineAt !== undefined &&
        deadlineAt - Date.now() <= ACCESSIBILITY_DETAIL_RESERVE_MS)
    ) {
      break;
    }
    const group = candidates.slice(offset, offset + 4);
    /* 이 묶음만큼의 예산을 확보하지 못하면 부르지 않는다. 호출 뒤에 세는 것과
       호출 전에 확보하는 것의 차이가 곧 "한도를 넘겨 실패한 뒤 그 실패를 다른
       사유로 기록하는가"의 차이다. */
    if (!reserveSubrequests(meter, group.length)) break;
    const settled = await Promise.allSettled(
      group.map((candidate) =>
        getAccessibilityDetail(candidate.contentId, { signal }),
      ),
    );
    settled.forEach((entry, index) => {
      const candidate = group[index];
      if (entry.status === "fulfilled") {
        audits.push(entry.value.audit);
        if (entry.value.items[0]) {
          details.set(candidate.contentId, entry.value.items[0]);
        }
      } else {
        audits.push(
          auditFromFailure(
            "KorWithService2",
            "detailWithTour2",
            entry.reason,
          ),
        );
      }
    });
  }

  return { details, audits };
}

function geodesicEvidence(
  distanceMeters: number,
  durationMinutes: number,
): WorkingCandidate["routeEvidence"] {
  return {
    status: "geodesic_estimate",
    provider: "ieoga_conservative_estimate",
    distanceMeters: Math.round(distanceMeters),
    durationMinutes,
    calculatedAt: new Date().toISOString(),
  };
}

function fallbackScheduleDiff(
  candidate: {
    contentId: string;
    title: string;
    estimatedTravelMinutes: number;
  },
  referenceAt = new Date(),
): ScheduleDiff {
  const startAt = new Date(
    referenceAt.getTime() + candidate.estimatedTravelMinutes * 60_000,
  );
  const durationMinutes = 30;
  return {
    mode: "proximity_fallback",
    changeKind: "insert",
    replacementContentId: candidate.contentId,
    changedNodeIds: [],
    unchangedNodeIds: [],
    lockedNodeIds: [],
    preservedLockedNodeIds: [],
    changedNodeCount: 0,
    replacementNode: {
      id: `replacement-${candidate.contentId}`,
      title: candidate.title,
      startAt: startAt.toISOString(),
      endAt: new Date(
        startAt.getTime() + durationMinutes * 60_000,
      ).toISOString(),
      durationMinutes,
    },
  };
}

function fallbackContinuityProof(params: {
  candidate: {
    distanceMeters: number;
    estimatedTravelMinutes: number;
  };
  availability: PublicAvailabilityEvidence;
}): ContinuityProof {
  return {
    schemaVersion: "2026-07-v2",
    objective: "minimize_travel_minutes_without_registered_itinerary",
    recoveryMode: "proximity_fallback",
    changedNodeCount: 0,
    lockedNodesTotal: 0,
    lockedNodesPreserved: 0,
    routeEvidence: geodesicEvidence(
      params.candidate.distanceMeters,
      params.candidate.estimatedTravelMinutes,
    ),
    availabilityEvidence: params.availability,
    generatedAt: new Date().toISOString(),
  };
}

function itineraryScheduleDiff(params: {
  context: ItineraryContext;
  candidate: {
    contentId: string;
    title: string;
  };
  route: Extract<WalkingRouteEvidence, { status: "routed" }>;
  /* Required for an open window without a next appointment. It is a real
     candidate→origin request, never an outbound-duration estimate. */
  returnRoute?: Extract<WalkingRouteEvidence, { status: "routed" }>;
  stayMinutes: number;
  safetyBufferMinutes: number;
}): ScheduleDiff {
  const {
    context,
    candidate,
    route,
    returnRoute,
    stayMinutes,
    safetyBufferMinutes,
  } = params;
  const toCandidateMinutes =
    route.legs[0]?.durationMinutes ?? route.durationMinutes;
  const startAt = new Date(
    context.occurredAt.getTime() + toCandidateMinutes * 60_000,
  );
  const endAt = new Date(startAt.getTime() + stayMinutes * 60_000);
  let nextFixedAppointment: ScheduleDiff["nextFixedAppointment"];
  const preservedWaypoints: NonNullable<
    ScheduleDiff["preservedWaypoints"]
  > = [];
  let cursorMs = endAt.getTime();

  for (const [index, node] of context.continuityNodes.entries()) {
    if (!node.startAt) continue;
    const travelMinutes = route.legs[index + 1]?.durationMinutes ?? 0;
    const estimatedArrivalAt = new Date(
      cursorMs + travelMinutes * 60_000,
    );
    const scheduledAt = new Date(node.startAt);
    const requiredBufferMinutes =
      node.locked ||
      node.reservation ||
      node.id === context.nextFixed?.id
        ? safetyBufferMinutes
        : 0;
    const arrivalBufferMinutes = Math.floor(
      (scheduledAt.getTime() - estimatedArrivalAt.getTime()) / 60_000,
    );
    const status =
      arrivalBufferMinutes >= requiredBufferMinutes
        ? ("preserved" as const)
        : ("at_risk" as const);
    preservedWaypoints.push({
      nodeId: node.id,
      title: node.title,
      scheduledAt: node.startAt,
      estimatedArrivalAt: estimatedArrivalAt.toISOString(),
      arrivalBufferMinutes,
      requiredBufferMinutes,
      locked: node.locked,
      reservation: node.reservation,
      status,
    });

    if (node.id === context.nextFixed?.id) {
      nextFixedAppointment = {
        nodeId: node.id,
        title: node.title,
        scheduledAt: node.startAt,
        estimatedArrivalAt: estimatedArrivalAt.toISOString(),
        arrivalBufferMinutes,
        safetyBufferMinutes,
        status,
      };
      break;
    }

    const visitStartMs = Math.max(
      estimatedArrivalAt.getTime(),
      scheduledAt.getTime(),
    );
    cursorMs =
      visitStartMs +
      plannedDurationMinutes(node, 30) * 60_000;
  }

  const disrupted = context.disrupted;
  const changedNodeIds = disrupted ? [disrupted.id] : [];
  const unchangedNodeIds = context.sortedNodes
    .filter((node) => !changedNodeIds.includes(node.id))
    .map((node) => node.id);
  const preservedLockedNodeIds = context.lockedNodeIds.filter(
    (id) => !changedNodeIds.includes(id),
  );

  const openWindow = context.openWindow
    ? openWindowProof({
        context,
        windowStartAt: context.occurredAt,
        travelToMinutes: toCandidateMinutes,
        appliedStayMinutes: stayMinutes,
        arriveAt: startAt,
        leaveAt: endAt,
        route,
        returnRoute,
        nextFixedAppointment,
        requiredBufferMinutes: safetyBufferMinutes,
      })
    : undefined;

  const replacementNode = {
    id: `replacement-${candidate.contentId}`,
    title: candidate.title,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    durationMinutes: stayMinutes,
  };

  if (context.changeKind === "insert") {
    return {
      mode: context.mode,
      changeKind: "insert",
      replacementContentId: candidate.contentId,
      changedNodeIds: [],
      unchangedNodeIds,
      lockedNodeIds: context.lockedNodeIds,
      preservedLockedNodeIds,
      /* 끼워 넣기이므로 바뀐 일정은 0곳이다. 이 값을 1로 두면 증명서가
         있지도 않은 원래 일정을 바꿨다고 말하게 된다. */
      changedNodeCount: 0,
      nextFixedAppointmentPreserved:
        nextFixedAppointment?.status === "preserved"
          ? true
          : nextFixedAppointment
            ? false
            : undefined,
      arrivalTime: nextFixedAppointment?.estimatedArrivalAt,
      safetyBufferMinutes,
      note: nextFixedAppointment
        ? `비어 있는 시간에 한 곳을 더 넣고, 알려 주신 다음 장소 도착까지 실제 ${routeModeLabel(route.provider)} 경로로 검증했습니다.`
        : `비어 있는 시간에 한 곳을 더 넣고, 후보지에서 출발지로 돌아오는 실제 역방향 ${routeModeLabel(returnRoute?.provider ?? route.provider)} 경로를 별도로 조회해 왕복 시간이 남은 시간 안에 들어가는지 검증했습니다.`,
      replacementNode,
      preservedWaypoints,
      nextFixedAppointment,
      openWindow,
    };
  }

  const disruptedIndex = disrupted
    ? context.sortedNodes.indexOf(disrupted)
    : -1;

  return {
    mode: context.mode,
    changeKind: "replace",
    replacedNodeId: disrupted?.id,
    replacementContentId: candidate.contentId,
    changedNodeIds,
    unchangedNodeIds,
    lockedNodeIds: context.lockedNodeIds,
    preservedLockedNodeIds,
    changedNodeCount: 1,
    nextFixedAppointmentPreserved:
      nextFixedAppointment?.status === "preserved"
        ? true
        : nextFixedAppointment
          ? false
          : undefined,
    arrivalTime: nextFixedAppointment?.estimatedArrivalAt,
    safetyBufferMinutes,
    note: nextFixedAppointment
      ? "중단 일정 한 곳만 교체하고, 그 사이 원래 일정과 다음 고정 일정까지 순서대로 이동·도착 가능성을 검증했습니다."
      : "중단 일정 한 곳만 교체하고 나머지 잠금 일정을 유지했습니다.",
    originalNode: disrupted
      ? nodeSummary(disrupted, disruptedIndex)
      : undefined,
    replacementNode,
    preservedWaypoints,
    nextFixedAppointment,
  };
}

/* 창 안에 들어가는지의 계산을 한곳에 모은다. 다음 장소를 알려 준 경우에는 그
   도착 검증이 이미 끝났으므로 남는 여유를 그대로 쓰고, 알려 주지 않은 경우에는
   같은 보행 경로를 되짚어 오는 시간을 복귀로 잡는다. 왕복을 직선거리로
   추정하지 않고 실제 경로 구간을 재사용하는 것이 요점이다. */
const PROVIDER_MODE_LABEL: Record<
  WalkingRouteProvider,
  { ko: string; en: string }
> = {
  tmap_pedestrian: { ko: "보행", en: "walking" },
  openstreetmap_osrm: { ko: "보행", en: "walking" },
  tmap_car: { ko: "자동차", en: "driving" },
  kakao_transit: { ko: "대중교통", en: "transit" },
  kakao_bicycle: { ko: "자전거", en: "cycling" },
};

function routeModeLabel(provider: WalkingRouteProvider): string {
  return PROVIDER_MODE_LABEL[provider].ko;
}

/* 사용자가 고른 수단의 이름. 경로 조회 이전 단계의 문구에 쓴다. */
/* 실내 조건은 여기 한 곳에서만 결정한다. 예전에는 세 곳에서 각자
   `incident === "rain" || indoorOnly`를 계산해, 클라이언트가 실내를 끄고
   보내도 엔진이 우천이라는 이유로 다시 켰다. 여행자에게는 되돌릴 방법이
   없는 상태였다. 명시적으로 보낸 값이 항상 이긴다. */
function indoorRequirement(input: RecoveryRequest): boolean {
  return input.indoorOnly ?? input.incident === "rain";
}

function travelModeLabel(mode: RecoveryRequest["travelMode"]): string {
  return mode === "car"
    ? "자동차"
    : mode === "transit"
      ? "대중교통"
      : mode === "bicycle"
        ? "자전거"
        : "보행";
}

function openWindowProof(params: {
  context: ItineraryContext;
  windowStartAt: Date;
  travelToMinutes: number;
  appliedStayMinutes: number;
  arriveAt: Date;
  leaveAt: Date;
  route: Extract<WalkingRouteEvidence, { status: "routed" }>;
  returnRoute?: Extract<WalkingRouteEvidence, { status: "routed" }>;
  nextFixedAppointment?: ScheduleDiff["nextFixedAppointment"];
  requiredBufferMinutes: number;
}): OpenWindowProof | undefined {
  const window = params.context.openWindow;
  if (!window) return undefined;
  const windowMinutes = Math.max(
    0,
    Math.floor(
      (window.endAt.getTime() - params.windowStartAt.getTime()) / 60_000,
    ),
  );
  const nextPlaceLeg = params.route.legs[1];
  const returnRoute = params.returnRoute;
  if (!params.nextFixedAppointment && !returnRoute) return undefined;
  const returnMinutes = params.nextFixedAppointment
    ? (nextPlaceLeg?.durationMinutes ?? 0)
    : (returnRoute?.durationMinutes ?? 0);
  const returnBasis = params.nextFixedAppointment
    ? ("next_place_route" as const)
    : ("origin_return_route" as const);
  const returnProvider = params.nextFixedAppointment
    ? params.route.provider
    : (returnRoute?.provider ?? params.route.provider);
  const returnDistanceMeters = params.nextFixedAppointment
    ? (nextPlaceLeg?.distanceMeters ?? 0)
    : (returnRoute?.distanceMeters ?? 0);
  const returnCalculatedAt = params.nextFixedAppointment
    ? params.route.calculatedAt
    : (returnRoute?.calculatedAt ?? params.route.calculatedAt);
  const backAtMs = params.leaveAt.getTime() + returnMinutes * 60_000;
  const leftoverMinutes = Math.floor(
    (window.endAt.getTime() - backAtMs) / 60_000,
  );
  return {
    windowStartAt: params.windowStartAt.toISOString(),
    windowEndAt: window.endAt.toISOString(),
    windowMinutes,
    travelToMinutes: params.travelToMinutes,
    plannedStayMinutes: window.plannedStayMinutes,
    appliedStayMinutes: params.appliedStayMinutes,
    returnMinutes,
    returnBasis,
    returnProvider,
    returnDistanceMeters,
    returnCalculatedAt,
    requiredBufferMinutes: params.requiredBufferMinutes,
    leftoverMinutes,
    status:
      leftoverMinutes >= params.requiredBufferMinutes ? "fits" : "at_risk",
  };
}

async function enrichForContinuity(params: {
  candidate: WorkingCandidate;
  input: RecoveryRequest;
  context?: ItineraryContext;
  sourceLedger: KtoAudit[];
  rejected: RejectedCandidate[];
  weatherEvidence?: Awaited<ReturnType<typeof getWeatherEvidence>>;
  signal?: AbortSignal;
  meter?: SubrequestMeter;
  /* 이번 요청이 미리 읽어 둔 운영정보 사본. 있으면 외부 호출을 쓰지 않는다. */
  hoursSnapshots?: Map<string, HoursSnapshotHit>;
  /* 실시간으로 받아 온 원문을 여기에 모아 응답 뒤에 한 번에 저장한다. */
  snapshotWrites: HoursSnapshotWrite[];
  /* 사본으로 처리한 후보 수. 경고문에서 밝힌다. */
  snapshotHits: { count: number };
  /* 경로 사본. 도보·자전거에서만 채워진다. */
  routeSnapshots?: Map<string, WalkingRouteEvidence>;
  routeSnapshotWrites: RouteSnapshotWrite[];
  routeSnapshotHits: { count: number };
}): Promise<WorkingCandidate | null> {
  const {
    candidate,
    input,
    context,
    sourceLedger,
    rejected,
    weatherEvidence,
    signal,
    meter,
    hoursSnapshots,
    snapshotWrites,
    snapshotHits,
    routeSnapshots,
    routeSnapshotWrites,
    routeSnapshotHits,
  } = params;
  /* 사본에서 온 원문인지, 이번 호출에서 온 것인지. 아래 판정에 그대로 실어
     화면과 원장이 같은 사실을 말하게 한다. */
  let snapshotProvenance:
    | {
        evidenceSource: "snapshot";
        sourceFetchedAt: string;
        sourceModifiedAt: string;
      }
    | undefined;
  const minimumStay = input.minimumStayMinutes ?? 30;
  const safetyBuffer = input.safetyBufferMinutes ?? 15;

  let routeEvidence = candidate.routeEvidence;
  let scheduleDiff = candidate.scheduleDiff;
  let availability = candidate.availability;
  let availabilityLookupFailed = false;

  /* 운영정보를 경로보다 **먼저** 받는다.
     후보 한 곳을 검증하는 데 드는 외부 호출은 경로·복귀경로·운영정보 세 건인데,
     운영시간 때문에 떨어지는 후보가 실측에서 3분의 1이 넘는다. 경로를 먼저 조회
     하면 그 후보들이 이미 두 건을 쓴 뒤에 탈락한다. 순서를 바꾸면 같은 탈락이
     한 건으로 끝나고, 아낀 예산이 그대로 더 많은 후보를 보는 데 쓰인다.

     여기서 내리는 판정은 **도착 시각과 무관한 것**뿐이다 — 그날이 정기휴무이거나
     행사 기간 밖이거나, 운영시간 표기 자체를 대조할 수 없는 경우. 시간 구간
     대조는 실제 도착 시각을 알아야 하므로 경로를 얻은 뒤에 같은 원문으로 다시
     판정한다. 원문은 한 번만 받아 두 판정이 나눠 쓴다. */
  let availabilitySource:
    | Awaited<ReturnType<typeof fetchAvailabilitySource>>
    | undefined;
  if (context && candidate.contentTypeId) {
    /* 로컬 사본이 있으면 외부 호출을 쓰지 않는다.

       사본은 공사가 알린 콘텐츠 수정 시각이 지금과 같을 때만 쓰이므로, 지금 다시
       불러도 같은 원문이 온다. 판정은 어느 쪽이든 아래에서 이번 요청의 실제 체류
       구간에 다시 대조하므로, 사본을 쓴다고 해서 판정이 느슨해지지 않는다.

       이것이 후보당 외부 호출을 둘에서 하나로 줄인다 — 같은 50건 예산으로 볼 수
       있는 후보가 두 배가 된다는 뜻이다. */
    const snapshot = hoursSnapshots?.get(candidate.contentId);
    if (snapshot) {
      snapshotHits.count += 1;
      availabilitySource = {
        ok: true,
        item: snapshot.item,
        audit: {
          apiName: "KorService2",
          operation: "detailIntro2",
          status: "live",
          latencyMs: 0,
          resultCount: 1,
          totalCount: 1,
          fieldsUsed: ["usetime", "restdate", "infocenter"],
          /* 바깥으로 나가지 않았다. 원장이 이 사실을 그대로 말해야 예산 계량기도
             화면의 출처 표기도 거짓이 되지 않는다. */
          upstreamCalls: 0,
          errorCode: "SERVED_FROM_SNAPSHOT",
        },
      };
      snapshotProvenance = {
        evidenceSource: "snapshot",
        sourceFetchedAt: snapshot.fetchedAt,
        sourceModifiedAt: snapshot.sourceModifiedAt,
      };
      sourceLedger.push(availabilitySource.audit);
      if (closedForWholeDate(snapshot.item, context.occurredAt)) {
        rejected.push({
          contentId: candidate.contentId,
          title: candidate.title,
          reasonCode: "OFFICIALLY_CLOSED",
          reason:
            "공식 운영정보상 그날은 휴무이거나 행사 기간이 아니어서 제외했습니다.",
          distanceMeters: candidate.distanceMeters,
          changedNodeCount: context.changeKind === "insert" ? 0 : 1,
          verificationDepth: "pre_filter",
        });
        return null;
      }
    } else {
    /* 예산을 확보하지 못하면 아무것도 부르지 않고 물러난다. 탈락으로 세지도
       않는다 — 이 후보는 조건을 못 맞춘 것이 아니라 아직 보지 못한 것이다. */
    if (!reserveSubrequests(meter, 1)) return null;
    try {
      availabilitySource = await fetchAvailabilitySource(
        {
          contentId: candidate.contentId,
          contentTypeId: candidate.contentTypeId,
        },
        { signal },
      );
      if (availabilitySource.ok) {
        /* 이번에 실제로 받아 온 원문은 사본으로 남긴다. 추가 호출이 없다 —
           사람이 많이 가는 지역부터 저절로 더워진다. */
        snapshotWrites.push({
          contentId: candidate.contentId,
          contentTypeId: candidate.contentTypeId,
          sourceModifiedAt: candidate.modifiedAt,
          item: availabilitySource.item,
        });
        sourceLedger.push(availabilitySource.audit);
        if (
          closedForWholeDate(availabilitySource.item, context.occurredAt)
        ) {
          rejected.push({
            contentId: candidate.contentId,
            title: candidate.title,
            reasonCode: "OFFICIALLY_CLOSED",
            reason:
              "공식 운영정보상 그날은 휴무이거나 행사 기간이 아니어서 제외했습니다.",
            distanceMeters: candidate.distanceMeters,
            changedNodeCount: context.changeKind === "insert" ? 0 : 1,
            verificationDepth: "pre_filter",
          });
          return null;
        }
        /* 표기를 대조할 수 없다는 판정은 도착 시각을 바꿔도 달라지지 않는다.
           그러면 이 판정은 여기서 끝난다.

           그런 곳을 숨기지 않는다. 목록에서 지워 버리면 여행자는 그런 곳이
           있었다는 사실조차 모른 채 "갈 곳이 없다"는 화면을 본다. 운영시간
           원문은 우리가 이미 들고 있고, 사람은 그것을 읽을 수 있다. 그래서
           카드로 보여 주되 적용하기 전에 확인을 받는다 — 숨기는 것과 아무 말
           없이 넣게 두는 것 사이에 답이 있다.

           빈 시간 추천과 일정 복구에 같은 규칙을 쓴다. 한동안 복구에서는
           계속 제외했는데, 그러면 같은 장소가 어느 화면에서 왔느냐에 따라
           보이기도 하고 사라지기도 한다. 확인하지 못했다는 사실은 화면과
           무관하게 같은 사실이고, 그 사실을 안고 갈지는 여행자가 정한다.
           적용 화면이 무엇을 확인하지 못했는지 밝히고 동의를 받는다. */
      } else {
        sourceLedger.push(availabilitySource.evidence.audit);
      }
    } catch (error) {
      availabilityLookupFailed = true;
      sourceLedger.push(
        auditFromFailure("KorService2", "detailIntro2", error),
      );
      availability = unknownAvailability(
        "한국관광공사 상세 운영정보 호출에 실패해 운영 여부를 확정하지 못했습니다.",
      );
    }
    }
  }

  if (context) {
    const routePoints = [
      input.origin,
      { latitude: candidate.latitude, longitude: candidate.longitude },
      ...context.continuityNodes.map((node) => ({
        latitude: node.location!.latitude,
        longitude: node.location!.longitude,
      })),
    ];
    const requiresOriginReturn = Boolean(
      context.openWindow && !context.nextFixed,
    );
    /* 가는 경로의 로컬 사본이 있으면 외부 호출을 쓰지 않는다.

       도보·자전거만 저장한다 — 그 근거는 `routing.ts`가 이미 두 수단의 캐시 키를
       `static`으로 잡아 둔 판단이다. 자동차·대중교통은 시각에 따라 값이 달라지므로
       저장하지 않는다. 측정 시각은 근거에 그대로 실려 화면까지 간다. */
    const routeKeyParts =
      isCacheableRouteMode(input.travelMode) && !requiresOriginReturn
        ? routeSnapshotKey(routePoints, input.travelMode)
        : undefined;
    const cachedRoute = routeKeyParts
      ? routeSnapshots?.get(routeKeyParts.id)
      : undefined;

    /* 가는 경로와, 되짚어 쓸 수 없는 수단이면 복귀 경로까지 한 번에 확보한다.
       가는 경로만 부르고 복귀에서 예산이 떨어지면 그 후보는 반쪽만 검증된 채
       버려지고, 이미 쓴 호출도 되돌릴 수 없다. */
    if (
      !cachedRoute &&
      !reserveSubrequests(meter, meter?.routeCost ?? 1)
    ) {
      return null;
    }
    if (cachedRoute) routeSnapshotHits.count += 1;
    const route = cachedRoute ?? await getRoute(routePoints, {
      signal,
      mode: input.travelMode,
      departureAt: context.occurredAt.toISOString(),
      arriveBy: context.nextFixed?.startAt,
    });
    if (
      route.status !== "routed" ||
      route.legs.length < routePoints.length - 1
    ) {
      rejected.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "ROUTE_UNAVAILABLE",
        reason:
          `대체 일정부터 복귀 지점까지 이어지는 전체 ${travelModeLabel(input.travelMode)} 경로를 검증하지 못해 결과에서 제외했습니다.`,
        distanceMeters: candidate.distanceMeters,
        changedNodeCount: 1,
      });
      return null;
    }
    /* 실시간으로 얻은 경로만 사본으로 남긴다. 사본에서 온 것을 다시 저장하면
       만료 시각만 늘어나 "7일 상한"이 사실상 무한이 된다. */
    if (routeKeyParts && !cachedRoute) {
      routeSnapshotWrites.push({
        ...routeKeyParts,
        mode: input.travelMode as RouteSnapshotMode,
        value: route,
      });
    }
    /* 보행 복귀는 가는 경로를 되짚어 쓴다. 추정이 아니라 실측이다 — 서울·대전·
       부산의 6개 구간을 양방향으로 조회했을 때 TMAP 보행 경로는 12분짜리부터
       80분짜리까지 **소요시간이 초 단위까지 같았다**(편차 0.0%). 보행자에게는
       일방통행이 없으므로 당연한 결과이고, 같은 답을 얻으려고 호출을 한 번 더
       쓰는 것은 요청당 외부 호출 예산만 축낸다.

       다른 수단은 되짚어 쓰지 않는다. 같은 실측에서 자동차는 평균 33.6%·최대
       53.2%, 자전거는 평균 21.4%·최대 69.8% 어긋났다 — 33분 걸려 간 길이 복귀
       16분으로 나오는 구간이 있다. 그것을 갈음하면 복귀 시간을 절반으로 줄여
       잡게 되고, "남은 시간 안에 돌아올 수 있다"는 이 화면의 판정이 바로
       그 지점에서 무너진다. 호출을 아끼자고 판정을 틀리게 할 수는 없다. */
    const reversibleOutbound =
      requiresOriginReturn &&
      input.travelMode === "walk" &&
      route.provider === "tmap_pedestrian" &&
      routePoints.length === 2;
    const rawReturnRoute = reversibleOutbound
      ? ({
          ...route,
          geometry: [...route.geometry].reverse(),
          calculatedAt: route.calculatedAt,
        } satisfies WalkingRouteEvidence)
      : requiresOriginReturn
      ? await getRoute(
          [
            {
              latitude: candidate.latitude,
              longitude: candidate.longitude,
            },
            input.origin,
          ],
          {
            signal,
            mode: input.travelMode,
            departureAt: new Date(
              context.occurredAt.getTime() +
                ((route.legs[0]?.durationMinutes ?? route.durationMinutes) +
                  Math.max(minimumStay, context.originalDurationMinutes)) *
                  60_000,
            ).toISOString(),
            arriveBy: context.openWindow?.endAt.toISOString(),
          },
        )
      : undefined;
    if (
      requiresOriginReturn &&
      (!rawReturnRoute || rawReturnRoute.status !== "routed")
    ) {
      rejected.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "ROUTE_UNAVAILABLE",
        reason:
          "후보지에서 출발지로 돌아오는 실제 역방향 경로를 검증하지 못해 왕복 추천에서 제외했습니다.",
        distanceMeters: candidate.distanceMeters,
        changedNodeCount: 0,
      });
      return null;
    }
    const returnRoute =
      rawReturnRoute?.status === "routed" ? rawReturnRoute : undefined;

    const firstLeg = route.legs[0];
    const routedDistance =
      firstLeg?.distanceMeters ?? route.distanceMeters;
    const routedMinutes =
      firstLeg?.durationMinutes ?? route.durationMinutes;
    /* 체류시간은 등록 일정 또는 빈 시간 입력의 계획값이 권위 원천이다.
       레거시 availableMinutes로 조용히 줄이지 않고, 맞지 않으면 아래 연속성/창
       검증에서 명시적으로 탈락시킨다. */
    let stayMinutes = Math.max(minimumStay, context.originalDurationMinutes);
    scheduleDiff = itineraryScheduleDiff({
      context,
      candidate,
      route,
      returnRoute,
      stayMinutes,
      safetyBufferMinutes: safetyBuffer,
    });

    let atRisk = (scheduleDiff.preservedWaypoints ?? []).filter(
      (waypoint) => waypoint.status === "at_risk",
    );
    if (atRisk.length) {
      const shortfall = Math.max(
        ...atRisk.map(
          (waypoint) =>
            waypoint.requiredBufferMinutes -
            waypoint.arrivalBufferMinutes,
        ),
      );
      const automaticReduction = Math.min(
        Math.max(0, stayMinutes - minimumStay),
        shortfall,
      );
      if (automaticReduction > 0) {
        stayMinutes -= automaticReduction;
        scheduleDiff = itineraryScheduleDiff({
          context,
          candidate,
          route,
          returnRoute,
          stayMinutes,
          safetyBufferMinutes: safetyBuffer,
        });
        atRisk = (scheduleDiff.preservedWaypoints ?? []).filter(
          (waypoint) => waypoint.status === "at_risk",
        );
      }
    }

    /* 빈 시간 창을 넘긴 경우에도 같은 자동 완화를 적용한다.

       위 블록은 **다음 고정 일정 도착**이 위험할 때만 체류를 줄였고, 창 자체를
       넘기는 경우(`OPEN_WINDOW_OVERFLOW`)에는 아무 조정 없이 탈락시켰다. 그런데
       실측에서 탈락 사유 1위가 이것이었고, 반사실을 보면 "안전여유가 **1분**
       부족" 같은 것이 많았다 — 60분 머물 생각을 55분으로 줄이면 갈 수 있는 곳을
       "갈 수 없는 곳"으로 버린 것이다.

       줄이는 하한은 여행자가 선언한 최소 체류다. 안전여유는 건드리지 않는다.
       그리고 줄였다는 사실은 증명서의 `appliedStayMinutes`에 그대로 남아 카드가
       "요청한 60분보다 짧게 잡았다"고 말할 수 있다 — 조용히 줄이지 않는다. */
    const overflow = scheduleDiff.openWindow;
    if (overflow && overflow.status === "at_risk") {
      const shortfall = Math.max(
        0,
        overflow.requiredBufferMinutes - overflow.leftoverMinutes,
      );
      const automaticReduction = Math.min(
        Math.max(0, stayMinutes - minimumStay),
        shortfall,
      );
      if (automaticReduction > 0) {
        stayMinutes -= automaticReduction;
        scheduleDiff = itineraryScheduleDiff({
          context,
          candidate,
          route,
          returnRoute,
          stayMinutes,
          safetyBufferMinutes: safetyBuffer,
        });
        /* 체류가 줄면 다음 경유지 도착도 앞당겨지므로 위 판정을 다시 읽는다. */
        atRisk = (scheduleDiff.preservedWaypoints ?? []).filter(
          (waypoint) => waypoint.status === "at_risk",
        );
      }
    }

    routeEvidence = route;
    candidate.distanceMeters = routedDistance;
    candidate.estimatedTravelMinutes = routedMinutes;

    /* 이제 실제 도착·출발 시각이 확정됐으므로 같은 원문을 시간 구간까지 대조해
       다시 판정한다. 원문은 위에서 이미 받았으므로 호출은 추가되지 않는다. */
    if (availabilitySource?.ok) {
      availability = publicAvailability({
        ...evaluateAvailabilityItem(
          availabilitySource.item,
          availabilitySource.audit,
          new Date(scheduleDiff.replacementNode.startAt),
          new Date(scheduleDiff.replacementNode.endAt),
        ),
        /* 판정은 이번 요청의 체류 구간으로 다시 한 것이고, 원문의 출처는 별개
           사실이다. 둘을 함께 싣는다. */
        ...(snapshotProvenance ?? { evidenceSource: "live" as const }),
      });
    } else if (availabilitySource && !availabilitySource.ok) {
      availability = publicAvailability(availabilitySource.evidence);
    }

    const violations: RejectedCandidate[] = [];
    const operatingViolation = operatingStatusRejection({
      candidate,
      availability,
      lookupFailed: availabilityLookupFailed,
      changedNodeCount: context.changeKind === "insert" ? 0 : 1,
      allowUnconfirmedHours: true,
    });
    if (operatingViolation) violations.push(operatingViolation);
    /* 제외하지 않고 보여 주기로 한 곳에는 그 사실을 근거 공백으로 붙인다.
       카드가 "무엇을 확인하지 못했는지"를 말할 수 있어야, 넣기 직전의 확인이
       느닷없는 경고가 아니라 이미 읽은 사실의 확인이 된다. */
    if (
      !operatingViolation &&
      availability.status !== "confirmed_open"
    ) {
      candidate.evidenceGaps = [
        ...candidate.evidenceGaps.filter(
          (gap) => gap.code !== "OPERATING_HOURS_UNVERIFIED",
        ),
        {
          code: "OPERATING_HOURS_UNVERIFIED",
          note: "체류 시간 전체의 운영 여부를 공식 정보로 확인하지 못했습니다.",
          noteEn:
            "Official data does not confirm opening for the whole stay.",
        },
      ];
    }
    /* 거리 자체는 탈락 조건이 아니다. 등록 일정/빈 시간에서는 아래 연속성·창
       증명이 이동+체류+복귀(또는 다음 일정)를 실제 시각으로 fail-closed 한다.
       컨텍스트 없는 구형 호출만 호환 시간 한도를 사용한다. */
    if (!context && routedMinutes > input.availableMinutes) {
      const amount = Math.ceil(routedMinutes - input.availableMinutes);
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "TIME_LIMIT",
        reason: `현재 설정한 이동시간 한도보다 ${amount}분 더 필요합니다.`,
        distanceMeters: routedDistance,
        changedNodeCount: 1,
        requiredRelaxation: {
          constraint: "available_time",
          amount,
          unit: "minutes",
          currentLimit: input.availableMinutes,
          requiredLimit: Math.ceil(routedMinutes),
          description: `이동시간 한도 ${input.availableMinutes}분 → ${Math.ceil(routedMinutes)}분`,
          preservesLockedNodes: true,
          preservesNextFixedAppointment: true,
        },
      });
    }
    if (atRisk.length) {
      const shortfall = Math.max(
        ...atRisk.map(
          (waypoint) =>
            waypoint.requiredBufferMinutes -
            waypoint.arrivalBufferMinutes,
        ),
      );
      const firstRisk = atRisk[0];
      /* A counterfactual is used in a later request, after time has already
         advanced. Suggesting the exact mathematical boundary can therefore
         fail again seconds later. Round the stay reduction up to a five-minute
         step and reserve an additional execution margin. Never suggest
         weakening the declared safety buffer: it is a safety contract, not a
         ranking preference. */
      const counterfactualReduction =
        Math.ceil((shortfall + 2) / 5) * 5;
      const minimumStayAfterRelaxation =
        minimumStay - counterfactualReduction;
      const requiredRelaxation =
        minimumStayAfterRelaxation >= 10
          ? {
              constraint: "minimum_stay" as const,
              amount: counterfactualReduction,
              unit: "minutes" as const,
              currentLimit: minimumStay,
              requiredLimit: minimumStayAfterRelaxation,
              description: `최소 체류 ${minimumStay}분 → ${minimumStayAfterRelaxation}분`,
              preservesLockedNodes: true as const,
              preservesNextFixedAppointment: true as const,
            }
          : undefined;
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode:
          firstRisk.nodeId === context.nextFixed?.id
            ? "NEXT_FIXED_APPOINTMENT_AT_RISK"
            : "CONTINUITY_WAYPOINT_AT_RISK",
        reason: requiredRelaxation
          ? `${firstRisk.title}의 예약 시각을 지키려면 ${requiredRelaxation.description} 한 가지 조정이 필요합니다.`
          : `${firstRisk.title}까지 원래 순서와 시각을 지키는 단일 조건 조정을 찾지 못했습니다.`,
        distanceMeters: routedDistance,
        changedNodeCount: 1,
        arrivalBufferMinutes: firstRisk.arrivalBufferMinutes,
        requiredRelaxation,
      });
    }
    /* 빈 시간 추천에서 이동+체류+복귀가 창을 넘기는 후보. 체류를 줄이면
       들어가는 경우에는 그 최소 조정량을 반사실 근거로 남긴다. 30분 격자로만
       입력받으므로 조정 제안도 30분 단위로 내린다. */
    const windowProof = scheduleDiff.openWindow;
    if (windowProof && windowProof.status === "at_risk") {
      const shortfall = Math.max(
        0,
        windowProof.requiredBufferMinutes - windowProof.leftoverMinutes,
      );
      const reducedStay =
        Math.floor((windowProof.appliedStayMinutes - shortfall) / 30) * 30;
      violations.push({
        contentId: candidate.contentId,
        title: candidate.title,
        reasonCode: "OPEN_WINDOW_OVERFLOW",
        reason:
          windowProof.returnBasis === "next_place_route"
            ? `다녀오면 다음 장소에 필요한 ${windowProof.requiredBufferMinutes}분 안전여유가 ${shortfall}분 부족합니다.`
            : `다녀오면 복귀 뒤 필요한 ${windowProof.requiredBufferMinutes}분 안전여유가 ${shortfall}분 부족합니다.`,
        distanceMeters: routedDistance,
        changedNodeCount: 0,
        requiredRelaxation:
          reducedStay >= 30
            ? {
                constraint: "minimum_stay",
                amount: windowProof.appliedStayMinutes - reducedStay,
                unit: "minutes",
                currentLimit: windowProof.appliedStayMinutes,
                requiredLimit: reducedStay,
                description: `머무는 시간 ${windowProof.appliedStayMinutes}분 → ${reducedStay}분`,
                preservesLockedNodes: true,
                preservesNextFixedAppointment: true,
              }
            : undefined,
      });
    }
    /* 운영시간은 소프트 순위 조건이 아니다. 제안한 체류 구간 전체가 공식
       정보로 열려 있다고 확인된 후보만 실행 가능한 옵션이 된다. 휴무·데이터
       부족·제공자 장애는 서로 다른 사유로 원장에 남겨, 여행자에게는 헛걸음을
       막고 운영자에게는 재시도 가능한 장애인지 구분해 준다. */

    if (violations.length) {
      const [primary] = violations;
      if (violations.length > 1) {
        delete primary.requiredRelaxation;
        primary.reason = `${primary.reason} 또한 ${violations.length - 1}개의 필수 조건을 추가로 통과하지 못했습니다.`;
      }
      rejected.push(primary);
      return null;
    }
  } else if (candidate.contentTypeId) {
    try {
      const arrivalAt = new Date(scheduleDiff.replacementNode.startAt);
      const departureAt = new Date(scheduleDiff.replacementNode.endAt);
      const evidence = await getAvailabilityEvidence({
        contentId: candidate.contentId,
        contentTypeId: candidate.contentTypeId,
        startAt: arrivalAt,
        endAt: departureAt,
      }, { signal });
      sourceLedger.push(evidence.audit);
      availability = publicAvailability(evidence);
    } catch (error) {
      availabilityLookupFailed = true;
      sourceLedger.push(
        auditFromFailure("KorService2", "detailIntro2", error),
      );
      availability = unknownAvailability(
        "한국관광공사 상세 운영정보 호출에 실패해 운영 여부를 확정하지 못했습니다.",
      );
    }
  }

  if (!context) {
    const operatingViolation = operatingStatusRejection({
      candidate,
      availability,
      lookupFailed: availabilityLookupFailed,
      changedNodeCount: 0,
    });
    if (operatingViolation) {
      rejected.push(operatingViolation);
      return null;
    }
  }

  const continuityProof: ContinuityProof = {
    schemaVersion: "2026-07-v2",
    objective: !context
      ? "minimize_travel_minutes_without_registered_itinerary"
      : context.changeKind === "insert"
        ? "maximize_fit_within_open_window"
        : "minimize_changed_nodes_then_travel_minutes",
    recoveryMode: context?.mode ?? "proximity_fallback",
    changedNodeCount: scheduleDiff.changedNodeCount,
    lockedNodesTotal: scheduleDiff.lockedNodeIds.length,
    lockedNodesPreserved: scheduleDiff.preservedLockedNodeIds.length,
    nextFixedAppointmentPreserved:
      scheduleDiff.nextFixedAppointment?.status === "preserved"
        ? true
        : scheduleDiff.nextFixedAppointment
          ? false
          : undefined,
    routeEvidence,
    availabilityEvidence: availability,
    purposePreservation: candidate.purposePreservation,
    weatherEvidence,
    generatedAt: new Date().toISOString(),
  };

  /* 체류 시간대의 날씨. 예보 시계열은 이미 받아 둔 것이므로 추가 호출이 없다.
     지금 하늘이 아니라 "내가 거기 있을 동안"을 판정한다. */
  const stayWeather = summariseStayWeather(
    weatherEvidence,
    new Date(scheduleDiff.replacementNode.startAt),
    new Date(scheduleDiff.replacementNode.endAt),
  );
  /* 시점별 아이콘용. 기준 시각은 요청의 조회 기준 시각이다 — 지정 여행지와 대안을 같은
     시점으로 놓아야 비교가 되고, 후보마다 체류 시작이 달라 그것을 기준으로
     하면 카드 간 시점이 어긋난다. */
  const glance = weatherGlance(
    weatherEvidence,
    new Date(recoveryReferenceTime(input).at),
    { preferForecast: recoveryReferenceTime(input).mode === "assumed" },
  );

  const withoutScores = {
    ...candidate,
    availability,
    routeEvidence,
    scheduleDiff,
    continuityProof,
    stayWeather,
    weatherGlance: glance,
  };
  return {
    ...withoutScores,
    ...scoreCandidate(withoutScores, input),
  };
}

/* 여행 목적 문장은 카드에 전용 블록(purpose-contract)이 따로 있다. 예전에는
   이 목록의 첫 항목으로도 넣어서 같은 문장이 카드마다 두 번 찍혔다.
   또한 영어 화면에서 이 목록만 한국어로 남았으므로 두 언어를 함께 만든다. */
/* 카드에 실을 "장소에 대한 사실"을 모은다. 근거 문장(`buildWhy`)과 분리되어야
   하는 이유는 둘이 답하는 질문이 다르기 때문이다 — 근거는 "이 추천을 믿어도
   되는가"에 답하고, 이쪽은 "내가 거기서 무엇을 하게 되는가"에 답한다. 예전
   카드는 앞의 것만 길게 말하고 뒤의 것은 하나도 말하지 않았다. */
function buildTravelerFacts(
  candidate: WorkingCandidate,
  input: RecoveryRequest,
): TravelerFact[] {
  const facts: TravelerFact[] = [];
  const add = (fact: TravelerFact) => {
    const value = fact.value.replace(/\s+/gu, " ").trim();
    if (!value) return;
    facts.push({ ...fact, value });
  };

  const availability = candidate.availability;
  const place = availability?.placeFacts;

  /* 운영시간이 첫 줄이다. "문을 여는지 확인했습니다"가 아니라 **몇 시에 여는가**가
     여행자가 물은 것이고, 그 값은 이미 손에 있었다. */
  if (availability?.operatingHours) {
    add({
      code: "hours",
      label: "운영시간",
      labelEn: "Hours",
      value: availability.operatingHours,
      prominent: true,
    });
  }
  if (availability?.restDate) {
    add({
      code: "rest_day",
      label: "휴무",
      labelEn: "Closed",
      value: availability.restDate,
      prominent: true,
    });
  }
  if (place?.checkIn || place?.checkOut) {
    add({
      code: "check_in_out",
      label: "입실·퇴실",
      labelEn: "Check-in / out",
      value: [place.checkIn, place.checkOut].filter(Boolean).join(" · "),
      prominent: true,
    });
  }
  if (place?.courseDuration || place?.courseDistance) {
    add({
      code: "course_scale",
      label: "코스 전체",
      labelEn: "Whole course",
      value: [place.courseDuration, place.courseDistance]
        .filter(Boolean)
        .join(" · "),
      prominent: true,
    });
  }
  if (place?.eventPeriod) {
    add({
      code: "event_period",
      label: "행사 기간",
      labelEn: "Event period",
      value: place.eventPeriod,
      prominent: true,
    });
  }
  /* 식당 카드에서 대표메뉴는 사진 다음으로 먼저 보는 값이다. */
  if (place?.signatureMenu) {
    add({
      code: "signature_menu",
      label: "대표메뉴",
      labelEn: "Signature dish",
      value: place.signatureMenu,
      prominent: true,
    });
  }
  if (place?.menu) {
    add({
      code: "menu",
      label: "취급메뉴",
      labelEn: "Menu",
      value: place.menu,
    });
  }
  if (place?.fee) {
    add({
      code: "fee",
      label: "이용요금",
      labelEn: "Admission",
      value: place.fee,
      prominent: true,
    });
  }
  if (place?.parking) {
    add({
      code: "parking",
      label: "주차",
      labelEn: "Parking",
      value: place.parking,
      /* 자차로 가는 사람에게만 앞줄 값이다. */
      prominent: input.travelMode === "car",
    });
  }
  if (place?.reservation) {
    add({
      code: "reservation",
      label: "예약",
      labelEn: "Booking",
      value: place.reservation,
    });
  }
  if (place?.creditCard) {
    add({
      code: "credit_card",
      label: "카드 결제",
      labelEn: "Cards",
      value: place.creditCard,
    });
  }
  if (place?.petFriendly) {
    add({
      code: "pet",
      label: "반려동물",
      labelEn: "Pets",
      value: place.petFriendly,
    });
  }
  if (availability?.contact) {
    add({
      code: "contact",
      label: "문의",
      labelEn: "Phone",
      value: availability.contact,
      prominent: true,
    });
  }

  if (candidate.indoor && indoorRequirement(input)) {
    add({
      code: "indoor",
      label: "실내",
      labelEn: "Indoor",
      value: "실내에서 머물 수 있는 곳입니다.",
      valueEn: "You can stay indoors here.",
    });
  }

  if (candidate.crowdRate !== undefined) {
    const level = crowdLevelOf(candidate);
    add({
      code: "crowd",
      label: "붐빔 예측",
      labelEn: "Crowding",
      value:
        level === "easy"
          ? "원활한 편"
          : level === "busy"
            ? "붐비는 편"
            : "보통",
      valueEn:
        level === "easy" ? "Quiet" : level === "busy" ? "Busy" : "Average",
      prominent: true,
    });
  }

  if (candidate.routeEvidence.status === "routed") {
    const route = candidate.routeEvidence;
    add({
      code: "distance",
      label: "거리",
      labelEn: "Distance",
      value: `${Math.round(candidate.distanceMeters).toLocaleString("ko-KR")}m`,
      valueEn: `${Math.round(candidate.distanceMeters).toLocaleString("en-US")} m`,
    });
    if (typeof route.fareKrw === "number" || typeof route.transfers === "number") {
      add({
        code: "transit_fare",
        label: "대중교통",
        labelEn: "Transit",
        value: [
          typeof route.fareKrw === "number"
            ? `${route.fareKrw.toLocaleString("ko-KR")}원`
            : "",
          typeof route.transfers === "number" ? `환승 ${route.transfers}회` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        valueEn: [
          typeof route.fareKrw === "number"
            ? `${route.fareKrw.toLocaleString("en-US")} KRW`
            : "",
          typeof route.transfers === "number"
            ? `${route.transfers} transfer${route.transfers === 1 ? "" : "s"}`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
        prominent: true,
      });
    }
    /* 예전에는 "택시요금은 자차 비용이 아니므로 표시하지 않습니다"라고 적어
       두고 실제로 표시하지 않았다. 여행자가 알고 싶은 값을 손에 쥔 채 왜 안
       보여 주는지만 설명한 셈이다. 무엇의 값인지 밝히고 보여 준다. */
    if (typeof route.taxiFareKrw === "number") {
      add({
        code: "taxi_fare",
        label: "예상 택시요금",
        labelEn: "Est. taxi fare",
        value: `${route.taxiFareKrw.toLocaleString("ko-KR")}원 (자차 유류비·주차비는 별도)`,
        valueEn: `${route.taxiFareKrw.toLocaleString("en-US")} KRW (excludes fuel and parking if you drive)`,
        prominent: true,
      });
    }
  }

  const openWindow = candidate.scheduleDiff.openWindow;
  if (openWindow) {
    add({
      code: "spare_time",
      label: openWindow.returnBasis === "next_place_route"
        ? "다음 장소까지 여유"
        : "복귀 뒤 여유",
      labelEn:
        openWindow.returnBasis === "next_place_route"
          ? "Slack before next place"
          : "Spare time after returning",
      value: `${openWindow.leftoverMinutes}분`,
      valueEn: `${openWindow.leftoverMinutes} min`,
      prominent: true,
    });
  }

  return facts;
}

function buildWhy(
  candidate: WorkingCandidate,
  input: RecoveryRequest,
): { ko: string[]; en: string[] } {
  const ko: string[] = [];
  const en: string[] = [];
  const push = (korean: string, english: string) => {
    ko.push(korean);
    en.push(english);
  };

  /* 추천코스는 한 장소가 아니라 여러 지점을 잇는 경로다.
     계산은 틀리지 않았다 — "여기서 N분 머물고 다음 약속에 늦지 않는다"는 산수는
     참이다. 틀린 것은 **읽히는 방식**이었다. 카드가 코스를 다 도는 것처럼 보이는데
     공식 소요시간은 7시간이고(2026-08-19 실표본) 우리가 계획한 것은 30분이다.
     그 차이를 적지 않으면 여행자는 코스를 완주하는 계획으로 읽는다.

     경로도 코스의 시작 지점 좌표 하나로만 계산한다. 그 사실도 함께 밝힌다. */
  const courseDuration = candidate.availability?.placeFacts?.courseDuration;
  if (courseDuration) {
    const planned = candidate.scheduleDiff?.replacementNode?.durationMinutes;
    push(
      planned
        ? `추천코스는 여러 지점을 잇는 경로입니다. 공식 소요시간은 ${courseDuration}이고, 이 계획의 ${planned}분은 코스 전체가 아니라 시작 지점 주변을 둘러보는 시간입니다.`
        : `추천코스는 여러 지점을 잇는 경로입니다. 공식 소요시간은 ${courseDuration}이며, 이 계획은 코스 전체를 마치는 시간을 포함하지 않습니다.`,
      planned
        ? `A travel course links several stops. The official course takes ${courseDuration}; the ${planned} minutes planned here cover the area around its starting point, not the whole route.`
        : `A travel course links several stops. The official course takes ${courseDuration}; this plan does not include finishing the whole route.`,
    );
    push(
      "이동 경로는 코스의 시작 지점 좌표로 계산했습니다. 코스를 따라 걷는 거리는 포함하지 않습니다.",
      "The route was calculated to the course's starting coordinate. It does not include walking the course itself.",
    );
  }

  const meters = Math.round(candidate.distanceMeters);
  if (candidate.routeEvidence.status === "routed") {
    /* 거리·소요시간·요금은 더 이상 여기에 문장으로 적지 않는다. 같은 값이 카드
       상단 타임라인과 `travelerFacts`에 이미 있어서, 불릿으로 한 번 더 적으면
       카드만 길어지고 읽는 사람은 같은 숫자를 세 번 만난다. 어느 공급자로
       계산했는지는 근거 상자가 이어서 밝힌다.

       남기는 것은 **숫자를 그대로 믿으면 안 되는 경우**뿐이다. */
    /* 배차를 모르는 값이므로 확정 도착 시각처럼 제시하지 않는다. 도보·자차와
       같은 등급으로 보여 주면 도착 시각을 보증하는 셈이 된다. */
    if (candidate.routeEvidence.scheduleDependent) {
      /* 미래 시각을 조회한 경우, 이 소요시간은 그 시각의 시각표가 아니라 조회
         시점의 시각표로 계산된 값이다. 카카오 대중교통은 좌표만 받고 미래
         시각표를 모른다. 그 차이를 적지 않으면 "그 시각 기준으로 검증했다"는
         이 화면의 다른 문장들과 조용히 어긋난다. */
      push(
        candidate.routeEvidence.assumesCurrentTimetable
          ? "대중교통 소요시간은 조회 시점의 시각표로 계산한 값입니다. 선택한 시각의 배차·막차는 다를 수 있으니 출발 전 실시간 도착 정보를 확인해 주세요."
          : "대중교통 소요시간은 배차 간격에 따라 달라질 수 있습니다. 출발 직전 실시간 도착 정보를 확인해 주세요.",
        candidate.routeEvidence.assumesCurrentTimetable
          ? "This transit duration uses the timetable at the time of the search, not the one for your selected time. Frequency and last services may differ — check live arrivals before you go."
          : "Transit time varies with service frequency. Check live arrivals before you set out.",
      );
    }
  } else {
    push(
      `한국관광공사 좌표 기준 직선거리 ${meters.toLocaleString("ko-KR")}m입니다.`,
      `${meters.toLocaleString("en-US")} m in a straight line from the official coordinates.`,
    );
  }

  /* 연락처는 `travelerFacts`의 "문의" 항목으로 옮겼다. 전화번호는 근거가 아니라
     장소 정보이고, 문장으로 감싸면("…로 문의할 수 있습니다") 눌러야 할 번호가
     문장 속에 묻힌다. */

  const appointment = candidate.scheduleDiff.nextFixedAppointment;
  if (appointment?.status === "preserved") {
    push(
      `다음 예약 '${appointment.title}'에 ${appointment.arrivalBufferMinutes}분 여유를 두고 도착합니다.`,
      `You arrive at '${appointment.title}' with ${appointment.arrivalBufferMinutes} min to spare.`,
    );
  }
  /* "한 곳만 바꾸고 나머지는 그대로 둡니다"를 뺐다. 이 앱이 하는 일이 그것
     하나뿐이므로 모든 카드에 똑같이 붙었고, 모든 카드에 같은 문장이 있으면
     카드를 고르는 데 아무 도움이 되지 않는다.

     운영시간을 읽지 못했다는 문장도 뺐다. 같은 사실을 근거 항목이 **원문과
     함께** 말하므로("공식 운영시간은 …입니다"), 여기서 한 번 더 적으면 원문
     없는 쪽이 먼저 눈에 들어와 오히려 불친절하다. */
  /* "문을 여는지 확인했습니다"와 "실내에서 지낼 수 있습니다"를 뺐다. 앞의 것은
     운영시간 원문이 카드에 그대로 있으면 여행자가 스스로 읽는 사실이고, 뒤의
     것은 `travelerFacts`의 "실내" 항목이 같은 말을 더 짧게 한다. 확인했다는
     선언이 확인된 값 자체보다 자리를 더 차지하고 있었다.

     반대로 **확인하지 못한 것**은 계속 문장으로 남는다. 그것은 값이 아니라
     경고이고, 짧게 줄이면 경고로 읽히지 않는다. */
  if (candidate.accessibility.status === "verified") {
    push(
      "요청한 이동 조건에 맞는 편의정보를 무장애여행정보에서 확인했습니다.",
      "Barrier-free data confirms the facilities you asked for.",
    );
  } else if (input.audience !== "general") {
    /* 접근성이 확인되지 않은 후보가 1순위이거나 유일 추천인데, 추천 이유 다섯
       문장에 그 사실이 한 줄도 없었다. `evidenceGaps`에는 "자동 복구안에서
       제외합니다"라고 적혀 있는데 화면은 그것을 추천으로 보여주는 상태였다.
       휠체어·유아차 이용자에게는 그 한 줄이 이 앱을 쓰는 이유다. */
    const missing = candidate.accessibility.requiredChecks
      .filter((check) => check.status === "missing")
      .map((check) => check.label);
    push(
      missing.length
        ? `요청한 이동 조건 중 ${missing.join("·")}을 공식 정보에서 확인하지 못했습니다. 출발 전에 직접 확인해 주세요.`
        : "요청한 이동 조건을 공식 무장애여행정보에서 확인하지 못했습니다. 출발 전에 직접 확인해 주세요.",
      missing.length
        ? `Official data does not confirm ${missing.join(", ")}. Please check before you set out.`
        : "Official barrier-free data does not confirm the conditions you asked for. Please check before you set out.",
    );
  }
  /* 체류 시간대의 날씨. 지금 하늘이 아니라 "내가 거기 있을 동안"을 말한다.
     실외 후보에만 붙인다 — 실내에 들어가 있는 동안의 강수는 결정을 바꾸지
     않으므로 카드 한 줄을 쓸 값어치가 없다. */
  const stay = candidate.stayWeather;
  if (stay && stay.status !== "unknown" && !candidate.indoor) {
    const startsAt = stay.precipitationStartsAt
      ? new Intl.DateTimeFormat("ko-KR", {
          timeZone: "Asia/Seoul",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(stay.precipitationStartsAt))
      : undefined;
    if (stay.status !== "dry") {
      push(
        [
          "머무는 시간대에",
          startsAt
            ? `${startsAt}부터 ${stay.precipitationKind ?? "강수"}가 예보돼 있습니다`
            : `강수확률이 최고 ${stay.maxPrecipitationProbabilityPercent}%입니다`,
          "(실외 장소입니다).",
          stay.status === "rain_likely"
            ? "우산이 필요할 가능성이 높습니다."
            : "예보가 확정은 아니니 출발 전에 다시 확인해 주세요.",
        ].join(" "),
        [
          "During your stay",
          startsAt
            ? `precipitation is forecast from ${startsAt}`
            : `the peak chance of precipitation is ${stay.maxPrecipitationProbabilityPercent}%`,
          "(this is an outdoor place).",
          stay.status === "rain_likely"
            ? "You will likely need an umbrella."
            : "A forecast is not a certainty — check again before you set out.",
        ].join(" "),
      );
    }
    const strain = outdoorTemperatureStrain(stay);
    if (strain) {
      /* 조건을 밝히지 않은 요청에도 문장은 보여 준다. 순위는 바꾸지 않되
         판단할 근거는 준다. */
      push(
        strain.kind === "heat"
          ? `머무는 시간대 기온이 최고 ${strain.celsius}℃로 예보됐습니다. 실외 장소이므로 그늘과 물을 확인해 주세요.`
          : `머무는 시간대 기온이 최저 ${strain.celsius}℃로 예보됐습니다. 실외 장소이므로 방한을 확인해 주세요.`,
        strain.kind === "heat"
          ? `The forecast high during your stay is ${strain.celsius}°C at this outdoor place — check for shade and water.`
          : `The forecast low during your stay is ${strain.celsius}°C at this outdoor place — dress for the cold.`,
      );
    }
  }
  /* 판정("원활한 편입니다")은 `travelerFacts`의 "붐빔 예측 · 원활" 칸으로
     옮겼다. 남는 것은 그 값을 잘못 읽지 않게 하는 단서 하나다.

     이 한 줄은 지우지 않는다. 실측에서 청와대(30일 평균 37.1)가 경운동
     민병옥가옥(81.5)보다 낮았다 — 좁은 곳은 적은 인원으로도 포화되므로 이
     수치를 인원수로 읽으면 정반대의 결론에 이른다. 판정과 붙여 놓았을 때는
     한 문장이 세 절이 되어 카드마다 세 줄을 먹었고, 그렇게 반복되는 단서는
     읽히지 않는다. 값과 떼어 짧게 두는 편이 실제로 더 잘 읽힌다. */
  if (candidate.crowdRate !== undefined) {
    push(
      "붐빔 예측은 사람 수가 아니라 일별 붐빔 정도 예측이며, 현장 실시간 인원수는 아닙니다.",
      "A crowding forecast, not a live headcount.",
    );
  }
  /* 붐빔 칸이 비어 이 순위가 그 자리로 올라간 경우에는 불릿에 다시 적지
     않는다. 같은 값을 한 카드에 두 번 적으면 카드만 길어진다. */
  if (candidate.relatedRank !== undefined && candidate.crowdRate !== undefined) {
    push(
      `원래 일정과 함께 방문된 순위 ${candidate.relatedRank}위 기록이 있습니다.`,
      `Ranked #${candidate.relatedRank} among places visited together with your original stop.`,
    );
  }
  if (input.incident === "less_walk") {
    /* 무엇을 기준으로 정렬했는지 밝힌다. 밝히지 않으면 "이동 부담 감소"를 골랐을
       때 결과가 왜 이렇게 나왔는지 알 수 없다. */
    push(
      "이동 부담을 가장 크게 반영해 정렬했습니다. 이동거리와 접근성 확인 여부를 먼저 봅니다.",
      "Ranked with travel burden weighted highest — distance and confirmed accessibility come first.",
    );
  }
  return { ko, en };
}

function sourcesFor(candidate: WorkingCandidate): KtoServiceName[] {
  const sources = new Set<KtoServiceName>(["KorService2"]);
  if (candidate.relatedRank !== undefined) sources.add("TarRlteTarService1");
  if (candidate.crowdRate !== undefined) sources.add("TatsCnctrRateService");
  if (candidate.accessibility.status === "verified") {
    sources.add("KorWithService2");
  }
  return [...sources];
}

function dataContributionsFor(
  candidate: WorkingCandidate,
): DataContribution[] {
  const contributions: DataContribution[] = [
    {
      source: "KorService2",
      fields: [
        "contentid",
        "contenttypeid",
        "title",
        "mapx",
        "mapy",
        "dist",
      ],
      decision: "실재 관광지와 위치·거리·콘텐츠 유형을 확인했습니다.",
      effect: "bounded",
      status: "applied",
    },
    {
      source: "KorService2",
      fields: ["usetime", "restdate", "eventstartdate", "eventenddate"],
      decision:
        candidate.availability.status === "confirmed_open"
          ? "대체 일정 도착 시각의 공식 운영 가능성을 확인했습니다."
          : "공식 운영정보의 확인 수준을 복구 증명에 반영했습니다.",
      effect:
        candidate.availability.status === "confirmed_open"
          ? "verified"
          : "bounded",
      status:
        candidate.availability.status === "unknown"
          ? "unavailable"
          : "applied",
    },
  ];

  if (candidate.routeEvidence.status === "routed") {
    /* 응답이 말한 제공자를 그대로 적는다. 고정 문자열이었을 때 TMAP으로 계산한
       결과에도 OpenStreetMap이라고 적혔다. */
    const routeProvider = candidate.routeEvidence.provider;
    contributions.push({
      source:
        routeProvider === "tmap_pedestrian"
          ? "TMAP 보행자 경로안내"
          : routeProvider === "tmap_car"
            ? "TMAP 자동차 경로안내"
            : routeProvider === "kakao_transit"
              ? "카카오맵 대중교통 길찾기"
              : routeProvider === "kakao_bicycle"
                ? "카카오맵 자전거 길찾기"
                : "OpenStreetMap Routing",
      fields: ["distance", "duration", "legs", "geometry"],
      decision: `현재 위치→대체 일정→다음 고정 일정의 실제 ${routeModeLabel(routeProvider)} 경로와 도착 버퍼를 계산했습니다.`,
      effect: "verified",
      status: "applied",
    });
  }
  if (candidate.relatedRank !== undefined) {
    contributions.push({
      source: "TarRlteTarService1",
      fields: ["tAtsNm", "rlteTatsNm", "rlteRank"],
      decision: "원래 여행 목적과 연결성이 높은 대안을 우선순위에 반영했습니다.",
      effect: "ranked",
      status: "applied",
    });
  }
  if (candidate.crowdRate !== undefined) {
    contributions.push({
      source: "TatsCnctrRateService",
      fields: ["tAtsNm", "cnctrRate", "baseYmd"],
      decision: "관광 집중률 예측을 혼잡 회피 판정과 순위에 반영했습니다.",
      effect: "ranked",
      status: "applied",
    });
  }
  if (candidate.accessibility.status === "verified") {
    contributions.push({
      source: "KorWithService2",
      fields: candidate.accessibility.confirmedFields.map(
        (entry) => entry.field,
      ),
      decision: `접근성 필수 동선 등급 ${candidate.accessibility.grade}를 확인했습니다.`,
      effect: "verified",
      status: "applied",
    });
  }
  const weather = candidate.continuityProof.weatherEvidence;
  if (weather) {
    contributions.push({
      /* 기상청으로 조회한 결과에 Open-Meteo라고 적으면, 국내 공식 기상자료를
         썼다는 주장과 원장이 서로 반대되는 말을 한다. */
      source:
        weather.provider === "kma_short_term"
          ? "기상청 단기예보"
          : "Open-Meteo",
      fields:
        weather.status === "available"
          ? [
              "precipitation",
              "precipitation_probability",
              "weather_code",
            ]
          : [],
      decision:
        weather.status === "available"
          ? "현재 기상 상태를 복구 상황 근거로 함께 기록했습니다."
          : "기상 공급자의 응답 실패를 복구 증명에 공개했습니다.",
      effect: "bounded",
      status: weather.status === "available" ? "applied" : "unavailable",
    });
  }
  return contributions;
}

function toOption(
  candidate: WorkingCandidate,
  strategy: RecoveryOption["strategy"],
  strategyLabel: { ko: string; en: string },
  requestId: string,
  input: RecoveryRequest,
): RecoveryOption {
  return {
    id: `${requestId}-${strategy}-${candidate.contentId}`,
    strategy,
    strategyLabel: strategyLabel.ko,
    /* 영어 화면에서 전략 배지가 한국어로 남지 않도록 두 벌을 함께 보낸다. */
    strategyLabelEn: strategyLabel.en,
    weatherGlance: candidate.weatherGlance?.length
      ? candidate.weatherGlance
      : undefined,
    /* Travels with the option so the traveller is told which conditions were
       not confirmed. An option with gaps is a suggestion to check, never a
       verified result. */
    evidenceGaps: candidate.evidenceGaps,
    /* 활동 유형이 바뀐 후보도 확인 대상이다. 관광·체험을 하려던 사람에게
       식사나 쇼핑을 제안하는 것은 정당한 선택지이지만, 바뀐 것을 알리지
       않고 그대로 적용 가능으로 내보내면 화면은 "관광 → 식사"라고 쓰면서
       확인 없이 적용을 권하는 셈이 된다. 배포본 8건 측정에서 실제로 그런
       후보가 나왔다. 근거 공백과 같은 등급으로 확인을 요구한다. */
    confirmationRequired:
      candidate.evidenceGaps.length > 0 ||
      candidate.purposePreservation.status === "changed_visit_category",
    contentId: candidate.contentId,
    title: candidate.title,
    address: candidate.address,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    imageUrl: candidate.imageUrl,
    thumbnailUrl: candidate.thumbnailUrl,
    contentTypeId: candidate.contentTypeId,
    tourismCategory: ktoTourismCategory(candidate.item),
    score: candidate.baseScore,
    distanceMeters: Math.round(candidate.distanceMeters),
    estimatedTravelMinutes: candidate.estimatedTravelMinutes,
    travelEstimate:
      candidate.routeEvidence.status === "routed"
        ? "routed"
        : "geodesic_conservative",
    routeGeometry:
      candidate.routeEvidence.status === "routed"
        ? candidate.routeEvidence.geometry
        : undefined,
    availability: candidate.availability,
    indoorSuitability:
      indoorRequirement(input)
        ? {
            status: "type_based",
            note: "한국관광공사 콘텐츠 유형으로 실내 여부를 판단했습니다. 건물 안 동선은 방문 전에 확인해 주세요.",
            noteEn:
              "Indoor fit is inferred from the official content type. Check the route inside the building before you go.",
          }
        : {
            status: "not_required",
            note: "이번 요청은 실내 여부를 필수 조건으로 쓰지 않았습니다.",
            noteEn: "This request did not require an indoor place.",
          },
    accessibility: candidate.accessibility,
    crowd:
      candidate.crowdRate === undefined
        ? candidate.relatedRank !== undefined
          ? {
              /* 붐빔은 못 구했지만 **다른 공사 API에 이 곳의 자리는 있다.**
                 연관 관광지 순위는 집중률이 못 덮는 유형을 정확히 덮는다 —
                 측정하면 음식점 16~35%, 쇼핑 17~60%, 축제행사 26%다.

                 다만 이것은 붐빔이 아니라 **인기**다. 월 단위 집계라 요일도
                 없다. 같은 단어로 부르면 없는 근거를 만드는 것이므로 축을
                 갈라 놓고, 임의의 등급을 매기지 않고 순위 자체를 적는다. */
              status: "popularity_rank",
              relatedRank: candidate.relatedRank,
              note: `인기 ${candidate.relatedRank}위`,
              noteEn: `Popularity #${candidate.relatedRank}`,
            }
          : {
              /* 세 축 어디에도 없다. 우리 판정 과정을 설명하는 대신 사실만
                 짧게 적는다. */
              status: "unavailable",
              note: "공식 정보 없음",
              noteEn: "No official data",
            }
        : {
            status: "available",
            relativeRate: candidate.crowdRate,
            baseDate: candidate.crowdBaseDate,
            percentileOfSeries: candidate.crowdPercentile,
            seriesDays: candidate.crowdSeriesDays,
            /* 카드에 쓰는 것은 세 단계뿐이다. `60번째 백분위`는 여행자가
               "붐비나?"의 답을 직접 계산하게 만든다. 원문 수치는 위 필드에
               그대로 남아 근거 확인에 쓸 수 있다. */
            level: crowdLevelOf(candidate),
            /* 빌려 온 값이면 반드시 밝힌다. 꼬리표 없이 내보내면 이 장소를
               직접 잰 것처럼 읽힌다. */
            basis: candidate.crowdBasis ?? "place",
            neighborCount: candidate.crowdNeighborCount,
            neighborMeters: candidate.crowdNeighborMeters,
            note: `${
              crowdLevelOf(candidate) === "easy"
                ? "원활"
                : crowdLevelOf(candidate) === "busy"
                  ? "혼잡"
                  : "보통"
            }${
              candidate.crowdBasis === "nearby"
                ? " (주변 기준)"
                : candidate.crowdBasis === "district"
                  ? " (지역 기준)"
                  : ""
            }`,
            noteEn: `${
              crowdLevelOf(candidate) === "easy"
                ? "Quiet"
                : crowdLevelOf(candidate) === "busy"
                  ? "Busy"
                  : "Average"
            }${
              candidate.crowdBasis === "nearby"
                ? " (nearby)"
                : candidate.crowdBasis === "district"
                  ? " (district)"
                  : ""
            }`,
          },
    relatedRank: candidate.relatedRank,
    purposePreservation: candidate.purposePreservation,
    travelerFacts: buildTravelerFacts(candidate, input),
    ...(() => {
      const reasons = buildWhy(candidate, input);
      return { why: reasons.ko, whyEn: reasons.en };
    })(),
    sources: sourcesFor(candidate),
    sourceModifiedAt: candidate.modifiedAt,
    scheduleDiff: candidate.scheduleDiff,
    continuityProof: candidate.continuityProof,
    dataContributions: dataContributionsFor(candidate),
  };
}

function pickOptions(
  candidates: WorkingCandidate[],
  requestId: string,
  input: RecoveryRequest,
): RecoveryOption[] {
  if (!candidates.length) return [];

  /* 활동 유형이 바뀐 후보는 마지막 수단이다. 점수에서 관광 콘텐츠를 앞세우고
     있지만 목적 점수는 총점의 18%뿐이라, 가까운 식당이 먼 박물관을 제치고
     첫 카드가 되는 일이 실제로 있었다. `minimum_change` 정렬은 이동시간과
     변경 일정 수만 보므로 목적을 아예 고려하지 않는다.

     그래서 순위가 아니라 후보 풀에서 가른다. 목적을 지키는 후보가 하나라도
     있으면 그 안에서만 고르고, 하나도 없을 때에만 바뀐 후보를 제시한다.
     "박물관이 있는데 간장게장이 올라오는 일"이 점수 배분과 무관하게
     사라지고, 대안이 0개가 되는 일도 없다. 두 시간 공백을 식사로 채우는
     것은 여전히 유효한 선택지이며, 그때는 바뀐 사실을 확인받는다. */
  const purposePreserving = candidates.filter(
    (candidate) =>
      candidate.purposePreservation.status !== "changed_visit_category",
  );
  const pool = purposePreserving.length ? purposePreserving : candidates;

  const selected: Array<{
    candidate: WorkingCandidate;
    strategy: RecoveryOption["strategy"];
    label: { ko: string; en: string };
  }> = [];
  const used = new Set<string>();

  /* 세 카드는 서로 다른 이유로 뽑혀야 한다. 예전 구현은 각 정렬의 1위만
     보고, 이미 쓴 후보면 그 전략을 통째로 건너뛰었다. 대체로 같은 후보가
     세 정렬에서 모두 1위였기 때문에 2·3번 카드가 "추가 검증 대안"이라는
     같은 이름으로 채워졌고, 사용자는 무엇이 다른지 알 수 없었다.
     여기서는 각 정렬에서 아직 쓰지 않은 첫 후보를 고른다. */
  const addFirstUnused = (
    sorted: WorkingCandidate[],
    strategy: RecoveryOption["strategy"],
    /* 라벨이 고른 후보에 따라 달라져야 하는 경우가 있다. 접근성 카드가 그렇다 —
       조건이 확인되지 않은 후보에 "조건이 가장 잘 맞는 곳"이라고 붙이면 같은
       카드 안의 미확인 경고와 정면으로 모순된다. */
    label:
      | { ko: string; en: string }
      | ((candidate: WorkingCandidate) => { ko: string; en: string }),
  ) => {
    const candidate = sorted.find((entry) => !used.has(entry.contentId));
    if (!candidate) return;
    used.add(candidate.contentId);
    selected.push({
      candidate,
      strategy,
      label: typeof label === "function" ? label(candidate) : label,
    });
  };

  const travelMinutes = (candidate: WorkingCandidate) =>
    candidate.routeEvidence.status === "routed"
      ? candidate.routeEvidence.durationMinutes
      : candidate.estimatedTravelMinutes;

  addFirstUnused(
    [...pool].sort((a, b) => {
      const changed =
        a.scheduleDiff.changedNodeCount - b.scheduleDiff.changedNodeCount;
      if (changed) return changed;
      return travelMinutes(a) - travelMinutes(b) || b.baseScore - a.baseScore;
    }),
    "minimum_change",
    input.itinerary
      ? { ko: "예약을 지키는 가장 가까운 곳", en: "Closest place that keeps your booking" }
      : { ko: "조회 기준 시각에 갈 수 있는 가장 가까운 곳", en: "Closest place you can reach at the selected time" },
  );

  /* 두 번째 카드는 상황별로 사용자가 실제로 궁금해하는 축을 쓴다. */
  if (input.incident === "crowd") {
    addFirstUnused(
      /* 점수와 같은 함수로 정렬한다. 따로 적어 두면 갈라지고, 실제로 갈려서
         라벨이 자기 카드의 수치와 반대가 됐다. 높을수록 덜 붐빈다. */
      [...pool].sort(
        (a, b) =>
          crowdComfortScore(b) - crowdComfortScore(a) ||
          b.baseScore - a.baseScore,
      ),
      "comfortable",
      /* 최저 집중률 후보가 앞 카드에 이미 쓰였으면 이 카드는 차순위를 물려받는데,
         라벨만 "덜 붐빌 것으로 예측된 곳"으로 남아 자기 카드의 수치와 정반대가
         됐다. 실측에서 이 카드의 예측지수가 63.77인데 위 카드가 14.01이었다.
         붐빔을 피하려 들어온 화면에서 가장 중요한 한 줄이 틀리면, 같은 카드의
         "경사로 있음"이나 "운영시간 확인" 같은 정직한 문장까지 함께 의심받는다.
         그래서 실제로 더 낮을 때만 그렇게 말한다. */
      (candidate) => {
        if (candidate.crowdRate === undefined) {
          return {
            ko: "집중률 예측을 확인하지 못한 곳",
            en: "No crowd forecast available",
          };
        }
        const score = crowdComfortScore(candidate);
        const lowerAlreadyShown = selected.some(
          (entry) =>
            entry.candidate.crowdRate !== undefined &&
            crowdComfortScore(entry.candidate) >= score,
        );
        return lowerAlreadyShown
          ? {
              ko: "집중률 예측을 확인한 곳",
              en: "Crowd forecast confirmed",
            }
          : {
              ko: "덜 붐빌 것으로 예측된 곳",
              en: "Forecast to be less crowded",
            };
      },
    );
  } else {
    addFirstUnused(
      [...pool].sort(
        (a, b) => b.comfortScore - a.comfortScore || b.baseScore - a.baseScore,
      ),
      "comfortable",
      /* 접근성이 확인되지 않은 후보에 "조건이 가장 잘 맞는 곳"이라고 붙이면,
         같은 카드 안의 "요청한 조건을 확인하지 못했습니다"와 정면으로 모순된다.
         확인된 경우에만 그렇게 말한다. */
      (candidate) =>
        input.audience === "general"
          ? { ko: "이동 부담이 가장 적은 곳", en: "Least walking and transfers" }
          : candidate.accessibility.status === "verified"
            ? {
                ko: "이동 편의 조건이 확인된 곳",
                en: "Mobility need confirmed by official data",
              }
            : {
                ko: "이동 부담이 가장 적은 곳 (편의 조건 미확인)",
                en: "Least travel burden (mobility need unconfirmed)",
              },
    );
  }

  /* 세 번째 카드는 기획의 `지역 발견`이다. 연계 방문 데이터가 있으면
     그 근거로, 없으면 여유 시간이 가장 넉넉한 후보로 채운다. 어느 쪽이든
     라벨이 이유를 말한다. */
  const relatedFirst = [...pool]
    .filter((entry) => entry.relatedRank !== undefined)
    .sort(
      (a, b) => (a.relatedRank ?? 999) - (b.relatedRank ?? 999) ||
        b.baseScore - a.baseScore,
    );
  if (relatedFirst.some((entry) => !used.has(entry.contentId))) {
    addFirstUnused(
      relatedFirst,
      "local_discovery",
      { ko: "함께 방문이 많은 인근 관광지", en: "Often visited together with your stop" },
    );
  } else {
    addFirstUnused(
      [...pool].sort((a, b) => {
        const aBuffer =
          a.scheduleDiff.nextFixedAppointment?.arrivalBufferMinutes ?? -1;
        const bBuffer =
          b.scheduleDiff.nextFixedAppointment?.arrivalBufferMinutes ?? -1;
        return bBuffer - aBuffer || b.baseScore - a.baseScore;
      }),
      "local_discovery",
      { ko: "약속까지 여유가 가장 많은 곳", en: "Most spare time before your booking" },
    );
  }

  /* 위 세 축이 같은 후보로 겹쳐 자리가 남는 경우에만 총점 순으로 채운다.
     이때도 "추가 검증 대안" 같은 무의미한 이름을 쓰지 않고, 그 후보가
     상대적으로 나은 점을 라벨에 적는다. */
  for (const candidate of [...pool].sort(
    (a, b) => b.baseScore - a.baseScore,
  )) {
    if (selected.length >= 3) break;
    if (used.has(candidate.contentId)) continue;
    used.add(candidate.contentId);
    const tier = candidatePurpose(candidate.contentTypeId).tier;
    selected.push({
      candidate,
      strategy: "local_discovery",
      label:
        tier === "sightseeing"
          ? {
              ko: "조건을 통과한 다른 관광 콘텐츠",
              en: "Another attraction that passed every condition",
            }
          : tier === "meal"
            ? {
                ko: "시간을 채울 수 있는 식사 장소",
                en: "A place to eat while you wait",
              }
            : tier === "shopping"
              ? {
                  ko: "실내에서 머물 수 있는 쇼핑 장소",
                  en: "An indoor shopping stop",
                }
              : {
                  ko: "조건을 통과한 다른 곳",
                  en: "Another place that passed every condition",
                },
    });
  }

  /* 전략 카드 세 장을 고른 뒤, **검증한 나머지 후보를 전부 점수순으로 아래에
     붙인다.** 예전에는 검증한 후보 중 세 장만 돌려주어 안전 조건을 통과한
     선택지를 숨겼다. 여행에 정답은 없으므로 위에는 조건을 가장 잘 맞춘 곳,
     아래에는 그 밖의 검증 완료 후보를 점수순으로 둔다. */
  const remaining = interleaveByCategory(
    [...pool]
      .filter((candidate) => !used.has(candidate.contentId))
      .sort((a, b) => b.baseScore - a.baseScore),
  );
  for (const candidate of remaining) {
    used.add(candidate.contentId);
    selected.push({
      candidate,
      strategy: "local_discovery",
      label: { ko: "근처의 다른 선택지", en: "Another nearby choice" },
    });
  }

  return selected.map(({ candidate, strategy, label }) =>
    toOption(candidate, strategy, label, requestId, input),
  );
}

/* Groups rejections by reason so an empty result can explain itself. */
function summariseRejections(
  rejected: RejectedCandidate[],
): Array<{ reasonCode: RejectionReasonCode; count: number }> {
  const counts = new Map<RejectionReasonCode, number>();
  for (const entry of rejected) {
    counts.set(entry.reasonCode, (counts.get(entry.reasonCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((a, b) => b.count - a.count);
}

/* 몇 곳까지 보여 줄까. 목록이 길어지면 "추천이 아니다"라는 구분이 흐려진다. */
const ALTERNATIVE_TIER_LIMIT = 6;

/* 탈락 후보를 **탈락한 상태로** 화면에 올릴 수 있게 정리한다.

   엔진은 이 정보를 이미 계산하고 있었다. 어느 조건이 얼마나 모자랐는지,
   무엇만 바꾸면 통과하는지까지 구해 놓고 `rejectedCount` 숫자 하나만 남기고
   버렸다. 실측에서 정선 요청의 1순위 탈락안은 "안전여유가 1분 부족, 체류
   60분→30분이면 통과"였는데, 여행자가 본 화면은 "찾지 못했습니다"였다.

   숨기는 것이 정직한 것이 아니다. 이 제품이 하지 않겠다고 약속한 것은
   **확인하지 않은 것을 확인한 척하는 것**이고, 탈락 사유를 붙여 탈락한 곳을
   보여 주는 것은 그 반대편에 있다. 실제로 코드 주석이 이미 같은 말을 하고
   있다 — "목록에서 지워 버리면 여행자는 그런 곳이 있었다는 사실조차 모른 채
   '갈 곳이 없다'는 화면을 본다." */
function summariseAlternatives(
  rejected: RejectedCandidate[],
): RecoveryResult["alternatives"] {
  /* 시간이 모자란 곳. 경로까지 확인한 탈락을 먼저, 그다음 조정량이 작은 순.
     사전 계산 단계에서 떨어진 곳도 함께 담지만 깊이를 밝혀 구분한다. */
  const nearMisses = rejected
    .filter(
      (candidate) =>
        candidate.contentId &&
        (candidate.reasonCode === "OPEN_WINDOW_OVERFLOW" ||
          candidate.reasonCode === "NEXT_FIXED_APPOINTMENT_AT_RISK" ||
          candidate.reasonCode === "CONTINUITY_WAYPOINT_AT_RISK" ||
          candidate.reasonCode === "TIME_LIMIT"),
    )
    .sort((a, b) => {
      const depth = (entry: RejectedCandidate) =>
        entry.verificationDepth === "route_verified" ? 0 : 1;
      const byDepth = depth(a) - depth(b);
      if (byDepth) return byDepth;
      /* 조정이 필요 없는 쪽이 먼저다. 그다음 조정량이 작은 순. */
      const amount = (entry: RejectedCandidate) =>
        entry.requiredRelaxation?.amount ?? Number.MAX_SAFE_INTEGER;
      return (
        amount(a) - amount(b) ||
        (a.distanceMeters ?? Number.POSITIVE_INFINITY) -
          (b.distanceMeters ?? Number.POSITIVE_INFINITY)
      );
    })
    .slice(0, ALTERNATIVE_TIER_LIMIT)
    .map((candidate) => ({
      contentId: candidate.contentId as string,
      title: candidate.title,
      distanceMeters: candidate.distanceMeters,
      reason: candidate.reason,
      reasonCode: candidate.reasonCode,
      requiredRelaxation: candidate.requiredRelaxation,
      verificationDepth: candidate.verificationDepth,
    }));

  /* 지금은 문을 닫은 곳. 밤 10시에 "찾지 못했습니다" 대신 실제 정보가 된다. */
  const closedNow = rejected
    .filter(
      (candidate) =>
        candidate.contentId && candidate.reasonCode === "OFFICIALLY_CLOSED",
    )
    .sort(
      (a, b) =>
        (a.distanceMeters ?? Number.POSITIVE_INFINITY) -
        (b.distanceMeters ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, ALTERNATIVE_TIER_LIMIT)
    .map((candidate) => ({
      contentId: candidate.contentId as string,
      title: candidate.title,
      distanceMeters: candidate.distanceMeters,
      reason: candidate.reason,
    }));

  if (!nearMisses.length && !closedNow.length) return undefined;
  return { nearMisses, closedNow };
}

function selectCounterfactual(
  rejected: RejectedCandidate[],
): RecoveryResult["counterfactual"] {
  const eligible = rejected
    .filter(
      (
        candidate,
      ): candidate is RejectedCandidate & {
        requiredRelaxation: NonNullable<
          RejectedCandidate["requiredRelaxation"]
        >;
      } => Boolean(candidate.requiredRelaxation),
    )
    .sort((a, b) => {
      /* 경로까지 검증한 탈락안이 먼저다. 같은 "조건 하나만 풀면 된다"라도
         예약 보존을 확인한 쪽이 사용자에게 더 확실한 정보이기 때문이다.
         사전 걸러내기 단계 탈락안은 그것이 없을 때만 올라온다. */
      const depthRank = (entry: RejectedCandidate) =>
        entry.verificationDepth === "route_verified" ? 0 : 1;
      const depth = depthRank(a) - depthRank(b);
      if (depth) return depth;
      /* 단위를 비교 가능한 축으로 환산한다. 조건 해제는 숫자 완화와 견줄 수
         없으므로 가장 뒤로 보낸다 — "5분만 더"가 있으면 그것이 더 가깝다. */
      const normalize = (
        relaxation: NonNullable<RejectedCandidate["requiredRelaxation"]>,
      ) =>
        relaxation.unit === "meters"
          ? relaxation.amount / 100
          : relaxation.unit === "condition"
            ? Number.MAX_SAFE_INTEGER
            : relaxation.amount;
      return (
        normalize(a.requiredRelaxation) - normalize(b.requiredRelaxation) ||
        (a.distanceMeters ?? Number.POSITIVE_INFINITY) -
          (b.distanceMeters ?? Number.POSITIVE_INFINITY)
      );
    });
  const best = eligible[0];
  if (!best) return undefined;
  return {
    ...best,
    proofType: "single_constraint_minimum_relaxation",
    verificationDepth: best.verificationDepth ?? "pre_filter",
  };
}

export async function recoverTrip(
  input: RecoveryRequest,
  requestId = crypto.randomUUID(),
  execution: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<RecoveryResult> {
  const referenceTime = recoveryReferenceTime(input);
  const referenceAt = new Date(referenceTime.at);
  const context = recoveryContext(input);
  const recoveryMode: RecoveryMode =
    context?.mode ?? "proximity_fallback";
  const warnings = context
    ? [
        "운영시간·경로·날씨는 선택한 조회 기준 시각에 맞춰 검증합니다. 공식 데이터는 요청할 때 조회한 정보이므로 예약 자체와 현장 안전을 보증하지 않으며, 출발 직전 운영기관 안내를 확인하세요.",
        /* 예전에는 여기에 "…별도로 조회했으며, 목적 유지 여부는 판단하지
           않았습니다"까지 적었다. 우리가 무엇을 했고 무엇을 하지 않았는지의
           기록이지, 결과를 읽는 사람이 쓸 정보가 아니다. 여행자가 알아야 할
           것은 이 시간 계산에 **복귀 시간이 들어 있다**는 사실 하나다. */
        ...(context.changeKind === "insert"
          ? [
              /* 라벨이 아니라 **실제로 마감으로 쓴 노드**를 보고 적는다. 예전에는
                 라벨만 보고 "다음 장소 도착까지 계산했습니다"라고 적었는데,
                 약속 시각 없이 이름만 알려 준 경우에도 같은 문장이 나갔다. */
              context.nextFixed
                ? `다음 장소 도착까지 실제 ${travelModeLabel(input.travelMode)} 경로로 계산했습니다.`
                : `돌아오는 ${travelModeLabel(input.travelMode)} 시간까지 포함해 계산했습니다.`,
              ...(context.openWindow?.nextPlaceIsDirectionHint
                ? [
                    `${context.openWindow.nextPlaceLabel} 도착 시각을 알려 주지 않으셨으므로 그 도착 시각은 검증하지 않았습니다. 남은 시간 안에 다녀와서 출발지로 돌아올 수 있는 곳만 확인했으며, ${context.openWindow.nextPlaceLabel} 방향에 가까운 곳을 먼저 보여 드립니다. 약속 시각을 입력하면 그 시각까지 도착할 수 있는지 함께 검증합니다.`,
                  ]
                : []),
            ]
          : []),
      ]
    : [
        "등록된 원래 일정이 없어 주변 조건충족 대안으로 계산했습니다. 최소변경과 다음 예약 보존을 검증하려면 최초 일정과 잠금 일정을 등록하세요.",
        "이동시간은 직선거리 기반 보수 추정이며 실제 도로·대중교통 경로가 아닙니다.",
      ];
  const sourceLedger: KtoAudit[] = [];
  const rejected: RejectedCandidate[] = [];
  /* 이번 요청이 실시간으로 받아 온 운영정보 원문. 응답을 다 만든 뒤 한 번에
     저장한다 — 추가 외부 호출이 없으므로 예산에 영향이 없다. */
  const snapshotWrites: HoursSnapshotWrite[] = [];
  /* 사본으로 처리한 후보 수. 검증 단계 안에서 늘어나지만 경고문은 그 밖에서
     쓰므로 여기에 둔다. */
  const snapshotUsage = { count: 0 };
  const routeSnapshotWrites: RouteSnapshotWrite[] = [];
  const routeSnapshotUsage = { count: 0 };

  /* 후보를 보기 **전에** 여행자가 준 조건끼리 모순이 없는지 확인한다.

     이 판정은 외부 조회를 한 건도 쓰지 않는다. 직선거리를 그 수단의 최고속도로
     나누므로 어떤 실제 경로도 이보다 빠를 수 없고, 삼각부등식상 `현재 → 후보 →
     다음 장소`는 `현재 → 다음 장소`보다 짧을 수 없다. 그래서 여기서 부족이 나오면
     한국의 어느 관광지를 넣어도 통과할 수 없다.

     예전에는 이 계산을 아무도 하지 않았다. 대신 후보 200곳을 가져와 45번을 조회한
     뒤 "이 시간 안에 다녀올 수 있는 곳을 찾지 못했습니다"라고 답했다. 여행자는
     원인이 자기 입력이라는 것도, 무엇을 바꾸면 되는지도 알 수 없었다. */
  const feasibility = assessInputFeasibility(input, context);
  if (feasibility) {
    return {
      requestId,
      referenceTime,
      status: "input_infeasible",
      recoveryMode,
      itinerarySummary: summariseItinerary(context),
      openWindowSummary: summariseOpenWindow(context),
      scope: {
        coverage: "nationwide",
        regionCode: input.origin.areaCode,
        districtCode: input.origin.sigunguCode,
        originLabel: input.origin.label,
      },
      options: [],
      rejectedCount: 0,
      rejectionSummary: [],
      inputFeasibility: feasibility,
      dataContributions: [],
      /* 원장이 비어 있는 것이 이 응답의 요점이다 — 확인하지 않았다는 사실을
         숨기지 않으면서, 확인할 필요가 없었다는 것도 함께 말한다. */
      sourceLedger,
      warnings: [
        ...warnings,
        feasibilityStatement(feasibility),
        "요청한 조건으로는 어떤 장소도 들어갈 수 없어 공식 관광정보를 조회하지 않았습니다. 아래 조정 중 하나를 적용하면 바로 다시 찾습니다.",
      ],
      generatedAt: new Date().toISOString(),
      ruleVersion: RECOVERY_RULE_VERSION,
    };
  }

  /* 이 요청이 실제로 도달할 수 있는 범위. 후보 탐색·무장애 목록이 모두 이 값을
     쓴다 — 세 곳이 다른 반경을 쓰면 어떤 후보는 접근성 정보만 있고 어떤 후보는
     그 반대가 된다. */
  const candidateRadiusMeters = discoveryRadiusMeters(input, context);

  let nearby: KtoCallResult;
  try {
    nearby = await getNearbyTourism({
      longitude: input.origin.longitude,
      latitude: input.origin.latitude,
      radius: candidateRadiusMeters,
      pageNo: 1,
      numOfRows: KTO_CANDIDATE_PAGE_SIZE,
      /* Candidate discovery is the one call the whole recovery depends on:
         without it there is nothing to filter and the request ends with no
         options at all. Its latency upstream is bimodal — measured at roughly
         0.2s for most calls with an occasional ten-second outlier — so a lone
         four-second attempt turns that tail straight into a failed recovery.
         The adapter hedges this call, which changes what the timeout is for.
         A short timeout would cut off the slow path — those calls do finish,
         around six seconds — while the hedge already covers the common case in
         well under two. So the budget is set wide enough to let a slow call
         land rather than abandoning work that was nearly done, and the hedge,
         not the timeout, is what keeps the usual request fast. */
    }, { signal: execution.signal, timeoutMs: 9_000, retry: false });
  } catch (error) {
    sourceLedger.push(
      auditFromFailure("KorService2", "locationBasedList2", error),
    );
    return {
      requestId,
      referenceTime,
      status: "upstream_unavailable",
      recoveryMode,
      itinerarySummary: summariseItinerary(context),
      openWindowSummary: summariseOpenWindow(context),
      scope: {
        coverage: "nationwide",
        regionCode: input.origin.areaCode,
        districtCode: input.origin.sigunguCode,
        originLabel: input.origin.label,
      },
      options: [],
      rejectedCount: 0,
      rejectionSummary: [],
      dataContributions: [],
      sourceLedger,
      warnings: [
        ...warnings,
        "핵심 관광정보를 확인하지 못해 실제 장소를 임의로 만들어 추천하지 않았습니다.",
      ],
      generatedAt: new Date().toISOString(),
      ruleVersion: RECOVERY_RULE_VERSION,
    };
  }

  sourceLedger.push(nearby.audit);
  const discoveredItems: KtoItem[] = [];
  const discoveredKeys = new Set<string>();
  const appendDiscoveryPage = (items: KtoItem[]) => {
    for (const item of items) {
      const key = candidateDiscoveryKey(item);
      if (discoveredKeys.has(key)) continue;
      discoveredKeys.add(key);
      discoveredItems.push(item);
    }
  };
  /* 행사·공연·축제는 위치 기반 목록으로는 제대로 찾을 수 없다.

     `locationBasedList2` 응답에는 `eventstartdate`/`eventenddate`가 **없다.**
     행사 기간은 상세조회에만 있으므로, 이미 끝난 행사인지 알아내려면 후보 하나마다
     외부 조회를 한 건씩 써야 한다. 2026-08-19 실측: 대전역 반경 20km에서 행사
     10건이 돌아왔고 표본 6건이 전부 작년에 끝난 것이었다(20250829~20250831 등).
     프로덕션에서 이 분류만 고르면 `OFFICIALLY_CLOSED: 3`, 후보 0곳이었다.
     끝난 행사를 추천하지는 않았지만 예산을 전부 탈락에 쓰고 화면은 백지였다.

     `searchFestival2`는 조회 기준 날짜 이후에 열리는 행사만 주고, 기간과 좌표가
     같은 응답에 실려 온다. 외부 조회 한 건으로 날짜가 유효한 후보만 받는다.
     실측: 대전 3건·서울 32건 모두 이미 끝난 행사 0건, 좌표 누락 0건.

     **위치 목록보다 먼저** 담는 이유. 중복 제거는 먼저 들어온 것을 남기는데,
     같은 행사가 두 응답에 모두 있으면 나중에 담은 쪽이 버려진다. 위치 목록을
     먼저 담으면 날짜가 **없는** 사본이 남아, 공짜로 얻은 기간 증거를 그대로
     버리게 된다. 순서가 곧 정확도다. */
  const festivalWanted =
    !input.tourismCategories?.length ||
    input.tourismCategories.includes("EVENT");
  let festivalNotRunning = 0;
  let festivalOutOfRange = 0;
  let festivalSourceUsed = false;
  if (festivalWanted && !execution.signal?.aborted) {
    try {
      const festivals = await getFestivals(
        {
          eventStartDate: koreaCompactDateString(referenceAt),
          /* 지역 코드가 없으면 전국 검색이 되어 반경 밖 행사로 한 페이지가
             채워진다. 나머지 파이프라인과 같은 대체 경로를 쓴다 — 출발지에
             코드가 없으면 첫 후보가 알려 준 행정코드를 쓴다. */
          regionCode:
            input.origin.areaCode ??
            normalizeAnalysisCodes(nearby.items[0] ?? {}).regionCode,
          numOfRows: FESTIVAL_PAGE_SIZE,
        },
        { signal: execution.signal, timeoutMs: 7_000, retry: false },
      );
      sourceLedger.push(festivals.audit);
      festivalSourceUsed = true;
      const running: KtoItem[] = [];
      for (const item of festivals.items) {
        const latitude = numberInRange(item.mapy, 33, 39);
        const longitude = numberInRange(item.mapx, 124, 132);
        if (latitude === undefined || longitude === undefined) continue;
        /* 반경은 우리가 판정한다 — 이 조회는 지역 단위라 도달할 수 없는
           행사까지 함께 온다. */
        if (
          haversineMeters(input.origin, { latitude, longitude }) >
          candidateRadiusMeters
        ) {
          festivalOutOfRange += 1;
          continue;
        }
        /* 조회 기준 날짜에 열리지 않는 행사는 여기서 떨어진다. 목록에 기간이
           실려 있으므로 상세조회를 쓰지 않는다. `eventStartDate` 이후만 왔으니
           남는 것은 "아직 시작하지 않은" 행사다. */
        const window = eventRunsOnDate(item, referenceAt);
        if (window && !window.runs) {
          festivalNotRunning += 1;
          rejected.push({
            contentId: stringValue(item.contentid),
            title: stringValue(item.title) || "이름 미확인 행사",
            reasonCode: "EVENT_NOT_RUNNING",
            reason: `조회 기준 날짜에 열리지 않는 행사입니다 (${readableCompactDate(window.start)} ~ ${readableCompactDate(window.end)}).`,
            verificationDepth: "pre_filter",
          });
          continue;
        }
        running.push(item);
      }
      appendDiscoveryPage(running);
      if (running.length) {
        warnings.push(
          `행사·공연·축제는 기간이 있는 콘텐츠라 위치 목록 대신 행사 전용 조회를 썼습니다. 조회 기준 날짜에 열리는 ${running.length.toLocaleString("ko-KR")}건만 후보에 넣었습니다.`,
        );
      } else if (festivalNotRunning || festivalOutOfRange) {
        warnings.push(
          `조회 기준 날짜에 이 지역에서 열리는 행사를 공식 정보에서 찾지 못했습니다. 기간이 맞지 않는 행사 ${festivalNotRunning}건, 다녀올 수 없는 거리의 행사 ${festivalOutOfRange}건은 후보에 넣지 않았습니다.`,
        );
      }
      /* 집중률 조회에서 겪은 것과 같은 잘림이다 — 가나다순 한 페이지로 자르면
         뒤 글자의 행사가 통째로 사라진다. 잘렸다면 그 사실을 밝힌다. */
      if (festivals.totalCount > festivals.items.length) {
        warnings.push(
          `이 지역의 행사 ${festivals.totalCount.toLocaleString("ko-KR")}건 중 가나다순 ${festivals.items.length.toLocaleString("ko-KR")}건만 확인했습니다.`,
        );
      }
    } catch (error) {
      /* 행사 조회 실패가 전체 조회를 무너뜨리지는 않는다. 다른 분류 후보는
         이미 손에 있다. */
      sourceLedger.push(
        auditFromFailure("KorService2", "searchFestival2", error),
      );
      warnings.push(
        "행사 전용 조회를 불러오지 못해 이번에는 행사 후보를 확인하지 못했습니다.",
      );
    }
  }

  /* 행사 전용 조회가 성공했다면 위치 목록의 행사는 버린다. 그쪽 사본에는 기간이
     없어서, 남겨 두면 후보 하나마다 상세조회를 한 건씩 써서 "작년에 끝났다"를
     알아내는 데 예산을 쓴다 — 방금 같은 사실을 공짜로 확인해 놓고서. 조회가
     실패했을 때만 예전처럼 남겨 두어, 상세조회 단계에서 날짜를 본다. */
  appendDiscoveryPage(
    festivalSourceUsed
      ? nearby.items.filter(
          (item) => stringValue(item.contenttypeid) !== FESTIVAL_CONTENT_TYPE_ID,
        )
      : nearby.items,
  );

  const reportedTotal = Math.max(nearby.totalCount, nearby.items.length);
  const reportedPages = Math.max(
    1,
    Math.ceil(reportedTotal / KTO_CANDIDATE_PAGE_SIZE),
  );
  const pageLimit = Math.min(reportedPages, CANDIDATE_DISCOVERY_MAX_PAGES);
  let pagesFetched = 1;
  let expansionStoppedByDeadline = false;

  /* Page 1 is mandatory; pages 2+ are opportunistic. A later-page failure
     never erases the valid first page. No user-entered radius participates:
     20 km is the provider's documented endpoint maximum, not a rejection
     rule imposed by this product. */
  for (let pageNo = 2; pageNo <= pageLimit; pageNo += 1) {
    const deadlineAt = execution.deadlineAt ?? Date.now() + 23_000;
    const remainingMs = deadlineAt - Date.now();
    if (
      execution.signal?.aborted ||
      remainingMs <= CANDIDATE_DISCOVERY_RESERVE_MS
    ) {
      expansionStoppedByDeadline = true;
      break;
    }

    try {
      const page = await getNearbyTourism(
        {
          longitude: input.origin.longitude,
          latitude: input.origin.latitude,
          radius: candidateRadiusMeters,
          pageNo,
          numOfRows: KTO_CANDIDATE_PAGE_SIZE,
        },
        {
          signal: execution.signal,
          timeoutMs: Math.min(
            CANDIDATE_EXPANSION_TIMEOUT_MS,
            remainingMs - CANDIDATE_DISCOVERY_RESERVE_MS,
          ),
          retry: false,
        },
      );
      sourceLedger.push(page.audit);
      pagesFetched = pageNo;
      appendDiscoveryPage(
        festivalSourceUsed
          ? page.items.filter(
              (item) =>
                stringValue(item.contenttypeid) !== FESTIVAL_CONTENT_TYPE_ID,
            )
          : page.items,
      );
      if (page.items.length < KTO_CANDIDATE_PAGE_SIZE) break;
    } catch (error) {
      sourceLedger.push(
        auditFromFailure("KorService2", "locationBasedList2", error),
      );
      warnings.push(
        "후보 추가 페이지를 불러오지 못해 이미 확인한 관광지만 검증했습니다.",
      );
      break;
    }
  }

  nearby = {
    ...nearby,
    items: discoveredItems,
    totalCount: reportedTotal,
  };
  warnings.push(
    candidateRadiusMeters >= KTO_CANDIDATE_RADIUS_METERS
      ? "후보 탐색은 한국관광공사가 제공하는 관광정보의 최대 검색 범위 20km 안에서 수행합니다."
      : `${withParticle(travelModeLabel(input.travelMode), "으로/로")} 남은 시간 안에 다녀올 수 있는 범위인 반경 ${(candidateRadiusMeters / 1000).toFixed(1)}km 안에서 후보를 찾았습니다. 그보다 먼 곳은 어떤 경로로도 이 시간 안에 다녀올 수 없어 조회하지 않았습니다.`,
  );
  if (
    expansionStoppedByDeadline ||
    reportedPages > CANDIDATE_DISCOVERY_MAX_PAGES ||
    pagesFetched < pageLimit
  ) {
    warnings.push(
      `공사 API가 알린 ${reportedTotal.toLocaleString("ko-KR")}건 중 중복을 제외한 ${discoveredItems.length.toLocaleString("ko-KR")}건을 응답 시간·호출량 예산 안에서 탐색했습니다.`,
    );
  }

  const firstCodes = nearby.items[0]
    ? normalizeAnalysisCodes(nearby.items[0])
    : {};
  const regionCode = input.origin.areaCode ?? firstCodes.regionCode;
  const districtCode = input.origin.sigunguCode ?? firstCodes.districtCode;

  /* 제거실험으로 끈 서비스는 호출하지 않는다. 호출해 놓고 결과만 버리면
     "API가 없으면 무엇이 깨지는가"를 보여 주는 것이 아니라 같은 호출량으로
     같은 답을 내는 것이 된다. */
  const disabled = new Set(input.disabledSources ?? []);
  const relatedPromise =
    regionCode && districtCode && !disabled.has("TarRlteTarService1")
      ? /* 기준월은 어댑터가 정한다. 여기서 직전 달을 못박으면 아직 발행되지
           않은 달로 고정되어, 어댑터의 하강 폴백이 "호출자가 지정한 달"로
           읽고 그 달만 조회한다. 실제로 그래서 연관 관광지가 계속 0건이었다. */
        getRelatedTourism(
          { regionCode, districtCode },
          { signal: execution.signal, timeoutMs: 4_000, retry: false },
        )
      : Promise.resolve(undefined);
  /* 집중률은 후보가 실제로 속한 시군구들로 조회한다.
     출발지 시군구 하나로만 조회하고 있었는데, 반경 8km 후보는 시군구 경계를
     넘나든다 — 서울시청 기준 실측에서 후보 100건이 중구 71 / 종로 29로 갈렸다.
     즉 어느 쪽을 출발지로 잡아도 약 30%의 후보는 조회 대상조차 아니었고,
     그 후보들은 실제 혼잡도와 무관하게 중립값을 받았다.

     후보 수가 많은 시군구부터 최대 3곳까지만 부른다. 25초 예산 안에서 병렬로
     돌리되 무한정 늘릴 수는 없고, 자른 사실은 아래에서 밝힌다. */
  const candidateDistricts = (() => {
    const counts = new Map<
      string,
      { regionCode: string; districtCode: string; count: number }
    >();
    for (const item of nearby.items) {
      const codes = normalizeAnalysisCodes(item);
      if (!codes.regionCode || !codes.districtCode) continue;
      const key = `${codes.regionCode}:${codes.districtCode}`;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else
        counts.set(key, {
          regionCode: codes.regionCode,
          districtCode: codes.districtCode,
          count: 1,
        });
    }
    /* 출발지 시군구는 후보가 적어도 포함한다 — 사용자가 서 있는 곳이다. */
    if (regionCode && districtCode) {
      const key = `${regionCode}:${districtCode}`;
      if (!counts.has(key)) {
        counts.set(key, { regionCode, districtCode, count: 0 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  })();
  const CROWD_DISTRICT_LIMIT = 2;
  const crowdDistricts = disabled.has("TatsCnctrRateService")
    ? []
    : candidateDistricts.slice(0, CROWD_DISTRICT_LIMIT);
  const crowdDistrictsSkipped = disabled.has("TatsCnctrRateService")
    ? 0
    : Math.max(candidateDistricts.length - crowdDistricts.length, 0);
  const crowdPromise = crowdDistricts.length
    ? Promise.allSettled(
        crowdDistricts.map((scope) =>
          getConcentrationForecast(scope, {
            signal: execution.signal,
            timeoutMs: 4_000,
            retry: false,
          }),
        ),
      )
    : Promise.resolve(undefined);
  const accessiblePromise =
    input.audience === "general" || disabled.has("KorWithService2")
      ? Promise.resolve(undefined)
      : getNearbyAccessibleTourism({
          longitude: input.origin.longitude,
          latitude: input.origin.latitude,
          radius: candidateRadiusMeters,
        }, { signal: execution.signal, timeoutMs: 4_000, retry: false });
  const weatherPromise = context
      ? getWeatherEvidence(
          input.origin.latitude,
          input.origin.longitude,
          { signal: execution.signal },
        )
    : Promise.resolve(undefined);

  const [
    relatedSettled,
    crowdSettled,
    accessibleSettled,
    weatherSettled,
  ] = await Promise.allSettled([
    relatedPromise,
    crowdPromise,
    accessiblePromise,
    weatherPromise,
  ]);

  let relatedItems: KtoItem[] = [];
  if (relatedSettled.status === "fulfilled" && relatedSettled.value) {
    relatedItems = relatedSettled.value.items;
    sourceLedger.push(relatedSettled.value.audit);
  } else if (disabled.has("TarRlteTarService1")) {
    /* 제거실험으로 끈 호출을 오류로 적으면 안 된다. 실제로 그렇게 기록돼
       원장에 `error`로 남았고, 그 상태는 "공사 데이터 공백" 판정의 근거로도
       쓰이는 값이다. 요구되지 않았음을 사유와 함께 남긴다. */
    sourceLedger.push(
      notRequiredAudit(
        "TarRlteTarService1",
        "areaBasedList1",
        "DISABLED_FOR_ABLATION",
      ),
    );
  } else if (regionCode && districtCode) {
    sourceLedger.push(
      auditFromFailure(
        "TarRlteTarService1",
        "areaBasedList1",
        relatedSettled.status === "rejected"
          ? relatedSettled.reason
          : undefined,
      ),
    );
    warnings.push(
      "연계 관광지 데이터가 없어 여행 목적 유사성은 거리와 조건 중심으로 계산했습니다.",
    );
  } else {
    sourceLedger.push(
      notRequiredAudit("TarRlteTarService1", "areaBasedList1"),
    );
  }

  let crowdItems: KtoItem[] = [];
  /* 시군구별 호출 결과를 합친다. 일부 시군구만 실패해도 나머지는 살린다 —
     하나가 실패하면 전부 버리는 편이 코드는 짧지만, 그러면 후보 대부분이
     이유 없이 중립값을 받는다. */
  const crowdOutcomes =
    crowdSettled.status === "fulfilled" && crowdSettled.value
      ? crowdSettled.value
      : [];
  const crowdSucceeded = crowdOutcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<KtoCallResult> =>
      outcome.status === "fulfilled",
  );
  const crowdFailedCount = crowdOutcomes.length - crowdSucceeded.length;
  if (crowdSucceeded.length) {
    crowdItems = crowdSucceeded.flatMap((outcome) => outcome.value.items);
    for (const outcome of crowdSucceeded) {
      sourceLedger.push(outcome.value.audit);
    }
    /* 상한을 넘어 잘렸으면 밝힌다. 조용히 잘리는 것이 원래 결함이었으므로
       같은 실패를 반복하지 않도록 사용자가 볼 수 있는 자리에 남긴다. */
    const truncatedScopes = crowdSucceeded.filter(
      (outcome) =>
        outcome.value.audit.totalCount > outcome.value.audit.resultCount,
    );
    if (truncatedScopes.length) {
      warnings.push(
        `관광 집중률 예측을 시군구 ${truncatedScopes.length}곳에서 일부만 받았습니다(응답 상한 ${CONCENTRATION_PAGE_SIZE.toLocaleString("ko-KR")}행). 받지 못한 관광지는 혼잡 근거 없이 중립으로 처리했습니다.`,
      );
    }
    if (crowdFailedCount) {
      warnings.push(
        `관광 집중률 예측을 시군구 ${crowdFailedCount}곳에서 조회하지 못했습니다. 그 지역 후보는 혼잡 근거 없이 중립으로 처리했습니다.`,
      );
      for (const outcome of crowdOutcomes) {
        if (outcome.status === "rejected") {
          sourceLedger.push(
            auditFromFailure(
              "TatsCnctrRateService",
              "tatsCnctrRatedList",
              outcome.reason,
            ),
          );
        }
      }
    }
    if (crowdDistrictsSkipped) {
      warnings.push(
        `후보가 시군구 ${candidateDistricts.length}곳에 걸쳐 있어 후보가 많은 ${crowdDistricts.length}곳만 집중률을 조회했습니다. 나머지 ${crowdDistrictsSkipped}곳 후보는 혼잡 근거 없이 중립으로 처리했습니다.`,
      );
    }
  } else if (disabled.has("TatsCnctrRateService")) {
    sourceLedger.push(
      notRequiredAudit(
        "TatsCnctrRateService",
        "tatsCnctrRatedList",
        "DISABLED_FOR_ABLATION",
      ),
    );
  } else if (regionCode && districtCode) {
    sourceLedger.push(
      auditFromFailure(
        "TatsCnctrRateService",
        "tatsCnctrRatedList",
        crowdSettled.status === "rejected"
          ? crowdSettled.reason
          : undefined,
      ),
    );
    warnings.push(
      "관광 집중률 예측을 확인하지 못한 후보에는 혼잡 근거를 표시하지 않습니다.",
    );
  } else {
    sourceLedger.push(
      notRequiredAudit("TatsCnctrRateService", "tatsCnctrRatedList"),
    );
  }

  let accessibleItems: KtoItem[] = [];
  if (accessibleSettled.status === "fulfilled" && accessibleSettled.value) {
    accessibleItems = accessibleSettled.value.items;
    sourceLedger.push(accessibleSettled.value.audit);
  } else if (disabled.has("KorWithService2")) {
    sourceLedger.push(
      notRequiredAudit(
        "KorWithService2",
        "locationBasedList2",
        "DISABLED_FOR_ABLATION",
      ),
    );
    warnings.push(
      "제거실험으로 무장애여행정보를 끈 요청입니다. 접근성 조건은 검증하지 않았습니다.",
    );
  } else if (input.audience !== "general") {
    sourceLedger.push(
      auditFromFailure(
        "KorWithService2",
        "locationBasedList2",
        accessibleSettled.status === "rejected"
          ? accessibleSettled.reason
          : undefined,
      ),
    );
    warnings.push(
      "무장애여행정보를 검증하지 못해 접근성 조건 후보를 자동 통과시키지 않았습니다.",
    );
  } else {
    sourceLedger.push(
      notRequiredAudit("KorWithService2", "locationBasedList2"),
    );
  }

  const weatherEvidence =
    weatherSettled.status === "fulfilled"
      ? weatherSettled.value
      : undefined;
  const referenceWeather = weatherGlance(weatherEvidence, referenceAt, {
    preferForecast: referenceTime.mode === "assumed",
  })[0];
  const referenceWeatherShowsRain =
    (referenceWeather?.precipitationType !== undefined &&
      referenceWeather.precipitationType > 0) ||
    (referenceWeather?.precipitationProbabilityPercent ?? 0) >= 50;
  if (
    context &&
    input.incident === "rain" &&
    weatherEvidence?.status === "available" &&
    referenceWeather &&
    !referenceWeatherShowsRain
  ) {
    warnings.push(
      "조회 기준 시각의 자동 기상 확인에서는 강수가 감지되지 않았지만 사용자가 선택한 우천 상황을 우선 적용했습니다.",
    );
  }

  /* 연관 관광지의 기준점. 일정 복구는 문제가 생긴 장소를 기준으로 삼고, 빈 시간
     추천은 알려 준 다음 장소를 기준으로 삼는다. 다음 장소도 없으면 기준점이
     없으므로 연관 순위를 계산하지 않는다. */
  const relatedAnchorTitle =
    context?.disrupted?.title ??
    context?.openWindow?.nextPlaceLabel ??
    (context?.changeKind === "insert" ? undefined : input.origin.label);
  const relatedRanks = relatedAnchorTitle
    ? relatedRankByTitle(relatedItems, relatedAnchorTitle)
    : new Map<string, RelatedMatch>();
  const forecasts = currentForecastByTitle(crowdItems, referenceAt);
  const accessibleIds = new Set(
    accessibleItems.map((item) => stringValue(item.contentid)).filter(Boolean),
  );
  const indoorRequired = indoorRequirement(input);
  const travelGeoMode = geoTravelMode(input.travelMode);
  /* 여행자가 고른 분류. 비어 있으면 전체를 본다. */
  const selectedCategories = input.tourismCategories?.length
    ? new Set<string>(input.tourismCategories)
    : undefined;
  let categoryFilteredOut = 0;
  const travelBudgetMinutes = travelTimeBudgetMinutes(input, context);

  const preliminary: WorkingCandidate[] = [];
  for (const item of nearby.items) {
    const contentId = stringValue(item.contentid);
    const contentTypeId = stringValue(item.contenttypeid);
    const title = stringValue(item.title) || "이름 미확인 관광지";
    const latitude = numberInRange(item.mapy, 32, 39.8);
    const longitude = numberInRange(item.mapx, 124, 132);
    if (!contentId || latitude === undefined || longitude === undefined) {
      rejected.push({
        contentId: contentId || undefined,
        title,
        reasonCode: "INVALID_COORDINATE",
        reason: "공식 위치 좌표를 확인하지 못했습니다.",
      });
      continue;
    }

    /* 일정 복구에서는 문제가 생긴 장소를, 빈 시간 추천에서는 알려 준 다음
       장소를 후보에서 뺀다. 지금 가려는 곳을 "지금 대신 갈 곳"으로 다시
       제시하면 안 된다. */
    const excludedTitle =
      context?.disrupted?.title ?? context?.openWindow?.nextPlaceLabel;
    if (
      excludedTitle &&
      normalizeName(title) === normalizeName(excludedTitle)
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "SAME_AS_DISRUPTED_PLACE",
        reason: context?.disrupted
          ? "문제가 생긴 원래 장소와 같은 장소이므로 대체 일정에서 제외했습니다."
          : "이미 가려고 하는 다음 장소와 같은 곳이므로 제외했습니다.",
      });
      continue;
    }

    /* 여행자가 분류를 미리 골랐으면 **운영시간·경로를 부르기 전에** 걸러낸다.

       화면에도 분류 필터가 있지만 그것은 응답을 받은 뒤 걸러내므로, 원하지 않는
       분류에도 조회를 다 쓴 뒤 지우는 것이 된다. 요청당 외부 조회 50건과 공사
       인증키의 일일 한도를 함께 생각하면 그 낭비는 곧 "원하는 분류에서 볼 수 있는
       곳의 수"를 깎는다. 여기서 걸러내면 같은 예산이 고른 분류에만 쓰인다.

       탈락으로 세지 않는다 — 여행자가 스스로 범위를 정한 것이고, 조건을 못 맞춘
       것이 아니다. 대신 몇 곳이 범위 밖이었는지는 아래에서 밝힌다. */
    if (selectedCategories) {
      const categoryCode = ktoTourismCategory(item).code;
      if (!selectedCategories.has(categoryCode)) {
        categoryFilteredOut += 1;
        continue;
      }
    }

    const relatedRank = findRelatedMatch(relatedRanks, title, contentTypeId);
    if (
      !preservesTravelPurpose({
        input,
        contentTypeId,
        relatedRank,
      })
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "TRAVEL_PURPOSE_MISMATCH",
        reason:
          "원래 일정에서 하려던 여행 활동과 다른 유형이라 복구 후보에서 제외했습니다.",
      });
      continue;
    }

    const apiDistance = numberInRange(item.dist, 0, 100_000);
    const distanceMeters =
      apiDistance ??
      haversineMeters(input.origin, {
        latitude,
        longitude,
      });
    /* 사전 걸러내기의 보수 추정. 자차는 직선거리를 도보 속도로 환산하면
       실제로 10분이면 닿는 후보가 "가용시간 초과"로 떨어진다. 수단별 속도로
       나눈다. 이 값은 걸러내기 전용이고, 살아남은 후보의 이동시간은 아래에서
       실제 경로로 다시 계산해 덮어쓴다. */
    const estimatedTravelMinutes = conservativeMinutesFor(
      input.travelMode,
      distanceMeters,
    );
    if (!context && estimatedTravelMinutes > input.availableMinutes) {
      rejected.push({
        contentId,
        title,
        reasonCode: "TIME_LIMIT",
        reason: `${travelModeLabel(input.travelMode)} 보수 추정 이동시간이 가용시간 ${input.availableMinutes}분을 초과합니다.`,
        distanceMeters,
        requiredRelaxation: {
          constraint: "available_time",
          amount: Math.ceil(estimatedTravelMinutes - input.availableMinutes),
          unit: "minutes",
          currentLimit: input.availableMinutes,
          requiredLimit: Math.ceil(estimatedTravelMinutes),
          description: `사용 가능한 시간 ${input.availableMinutes}분 → ${Math.ceil(estimatedTravelMinutes)}분`,
          preservesLockedNodes: false,
          preservesNextFixedAppointment: false,
        },
        verificationDepth: "pre_filter",
      });
      continue;
    }

    /* 빈 시간 추천의 사전 걸러내기.

       예전에는 이 자리에 `!context &&` 조건이 붙어 있어서, 빈 시간 경로에는 시간
       사전 필터가 **하나도 걸리지 않았다.** 그래서 도보로 왕복 4시간이 걸리는
       후보가 검증 풀에 들어와 운영시간·경로 조회를 각각 소비하고 나서야 "창 초과"로
       떨어졌다. 실측에서 짧은 창은 탈락 13건 중 10건, 정선은 13건 중 12건이 이
       사유였다 — 애초에 넣지 말아야 했던 후보들이다.

       거부는 반드시 **하한**으로 한다. 여기서 쓰는 값은 그 수단의 최고속도로
       직선을 달렸을 때의 시간이므로, 어떤 실제 경로도 이보다 빠를 수 없다. 즉
       이 검사를 통과하지 못한 후보는 "우리가 못 찾은 것"이 아니라 "존재할 수 없는
       것"이다. 반대로 이 검사를 통과한 후보는 아래에서 실제 경로로 다시 판정한다. */
    if (context) {
      const nextLocation = context.nextFixed?.location;
      const optimisticCircuitMinutes = nextLocation
        ? optimisticTravelMinutes(distanceMeters, travelGeoMode) +
          optimisticTravelMinutes(
            haversineMeters(
              { latitude, longitude },
              {
                latitude: nextLocation.latitude,
                longitude: nextLocation.longitude,
              },
            ),
            travelGeoMode,
          )
        : optimisticTravelMinutes(distanceMeters, travelGeoMode) * 2;
      if (optimisticCircuitMinutes > travelBudgetMinutes) {
        const shortfall = Math.ceil(
          optimisticCircuitMinutes - travelBudgetMinutes,
        );
        /* 사유 코드는 **실패한 조건**을 가리켜야 한다. 어느 단계에서 알아챘는지가
           아니다. 빈 시간 추천에서 회로가 창을 넘긴 것은 경로 검증 뒤에 알든
           그 전에 알든 같은 사실이고, 화면의 안내문과 반사실도 그 사실에 붙어
           있다. 단계 차이는 `verificationDepth`가 따로 말한다. */
        const appliedStay = input.minimumStayMinutes ?? 30;
        const reducedStay = Math.floor((appliedStay - shortfall) / 30) * 30;
        rejected.push({
          contentId,
          title,
          reasonCode: context.openWindow
            ? "OPEN_WINDOW_OVERFLOW"
            : "TIME_LIMIT",
          reason: nextLocation
            ? `${withParticle(travelModeLabel(input.travelMode), "으로/로")} 가장 빠르게 가도 이곳을 거쳐 ${nextLocation.label ?? "다음 장소"}까지 ${Math.ceil(optimisticCircuitMinutes)}분이 필요해, 이동에 쓸 수 있는 ${travelBudgetMinutes}분을 ${shortfall}분 넘습니다.`
            : `${withParticle(travelModeLabel(input.travelMode), "으로/로")} 가장 빠르게 왕복해도 ${Math.ceil(optimisticCircuitMinutes)}분이 필요해, 이동에 쓸 수 있는 ${travelBudgetMinutes}분을 ${shortfall}분 넘습니다.`,
          distanceMeters,
          changedNodeCount: context.changeKind === "insert" ? 0 : 1,
          /* 여행자가 실제로 할 수 있는 조정을 제안한다. 머무는 시간을 30분 격자로
             줄여서 들어가면 그것을, 그래도 안 되면 남은 시간 자체를 늘리는 쪽을
             제안한다. 안전여유는 어느 쪽에서도 건드리지 않는다. */
          requiredRelaxation:
            context.openWindow && reducedStay >= 30
              ? {
                  constraint: "minimum_stay",
                  amount: appliedStay - reducedStay,
                  unit: "minutes",
                  currentLimit: appliedStay,
                  requiredLimit: reducedStay,
                  description: `머무는 시간 ${appliedStay}분 → ${reducedStay}분`,
                  preservesLockedNodes: true,
                  preservesNextFixedAppointment: true,
                }
              : {
                  constraint: "available_time",
                  amount: shortfall,
                  unit: "minutes",
                  currentLimit: travelBudgetMinutes,
                  requiredLimit: Math.ceil(optimisticCircuitMinutes),
                  description: `이동에 쓸 수 있는 시간 ${travelBudgetMinutes}분 → ${Math.ceil(optimisticCircuitMinutes)}분`,
                  preservesLockedNodes: true,
                  preservesNextFixedAppointment: false,
                },
          verificationDepth: "pre_filter",
        });
        continue;
      }
    }

    /* Rain/indoor is a safety-critical hard constraint. A candidate whose
       official content classification does not support indoor use is rejected
       rather than offered with a caveat. Accessibility and crowd coverage can
       remain partial, but those gaps stay explicit and force the overall
       response out of the verified state below. */
    const indoor = hasVerifiedIndoorEvidence(item);
    if (indoorRequired && !indoor) {
      rejected.push({
        contentId,
        title,
        reasonCode: "INDOOR_UNVERIFIED",
        reason:
          "공식 관광 콘텐츠 분류에서 실내 이용 가능성을 확인할 수 없어 실내 필수 후보에서 제외했습니다.",
        distanceMeters,
        /* 실측에서 가장 많은 탈락 사유였다. 숫자 한도가 아니라 켜고 끄는
           조건이므로 완화량은 "조건 1건 해제"다. 실내를 요구하지 않으면
           검토 대상이 된다는 사실 자체가 사용자에게 가장 실행 가능한
           정보인데, 예전에는 이것이 반사실 설명에 전혀 나타나지 않았다. */
        requiredRelaxation: {
          constraint: "indoor_requirement",
          amount: 1,
          unit: "condition",
          currentLimit: 1,
          requiredLimit: 0,
          description: "실내 필수 조건을 해제",
          preservesLockedNodes: false,
          preservesNextFixedAppointment: false,
        },
        verificationDepth: "pre_filter",
      });
      continue;
    }
    const evidenceGaps: EvidenceGap[] = [];

    if (input.audience !== "general" && !accessibleIds.has(contentId)) {
      evidenceGaps.push({
        code: "ACCESSIBILITY_UNVERIFIED",
        note: "무장애여행정보 목록에서 이 곳을 찾지 못했습니다.",
        noteEn: "This place is not in the barrier-free travel dataset.",
      });
    }

    const forecast = findForecastMatch(forecasts, title);
    if (input.incident === "crowd" && !forecast) {
      evidenceGaps.push({
        code: "CONCENTRATION_UNVERIFIED",
        note: "이 곳의 집중률 예측을 확인하지 못했습니다.",
        noteEn: "No concentration forecast is available for this place.",
      });
    }
    if (
      input.incident === "crowd" &&
      forecast &&
      forecast.rate >= 80
    ) {
      rejected.push({
        contentId,
        title,
        reasonCode: "CONCENTRATION_HIGH",
        reason: `향후 집중률 예측값이 ${forecast.rate.toFixed(2)}/100으로 높습니다.`,
        distanceMeters,
      });
      continue;
    }

    const availability = unknownAvailability();
    const scheduleDiff = fallbackScheduleDiff({
      contentId,
      title,
      estimatedTravelMinutes,
    }, referenceAt);
    const routeEvidence = geodesicEvidence(
      distanceMeters,
      estimatedTravelMinutes,
    );
    const continuityProof = fallbackContinuityProof({
      candidate: { distanceMeters, estimatedTravelMinutes },
      availability,
    });
    const candidateWithoutScores = {
      item,
      contentId,
      contentTypeId,
      title,
      address: stringValue(item.addr1) || "주소 정보 미확인",
      latitude,
      longitude,
      distanceMeters,
      estimatedTravelMinutes,
      /* 순위용 회로 추정. 사전 걸러내기와 같은 기하를 쓰되, 걸러내기는 하한으로
         하고 순위는 보수 추정으로 한다 — 거부는 하한, 비교는 상한이다. */
      estimatedCircuitMinutes: context
        ? (() => {
            const nextLocation = context.nextFixed?.location;
            if (!nextLocation) return estimatedTravelMinutes * 2;
            const toNextMeters = haversineMeters(
              { latitude, longitude },
              {
                latitude: nextLocation.latitude,
                longitude: nextLocation.longitude,
              },
            );
            return (
              estimatedTravelMinutes +
              conservativeMinutesFor(input.travelMode, toNextMeters)
            );
          })()
        : undefined,
      imageUrl: normalizedImage(item.firstimage),
      thumbnailUrl: normalizedImage(item.firstimage2),
      modifiedAt: stringValue(item.modifiedtime) || undefined,
      evidenceGaps,
      indoor,
      relatedRank,
      purposePreservation: buildTravelPurposeProof({
        input,
        replacementTitle: title,
        contentTypeId,
        relatedRank,
      }),
      crowdRate: forecast?.rate,
      crowdBasis: forecast ? ("place" as const) : undefined,
      crowdBaseDate: forecast?.baseDate,
      crowdPercentile: forecast?.percentileOfSeries,
      crowdSeriesDays: forecast?.seriesDays,
      accessibility: evaluateAccessibility(input.audience),
      availability,
      routeEvidence,
      scheduleDiff,
      continuityProof,
    };
    preliminary.push({
      ...candidateWithoutScores,
      ...scoreCandidate(candidateWithoutScores, input),
    });
  }

  /* 이웃 대체는 후보가 **모두 모인 뒤에** 해야 한다. 한 곳씩 처리하는
     동안에는 주변에 무엇이 있는지 알 수 없다. 값이 바뀌었으므로 점수도 다시
     매긴다 — 옛 점수로 정렬하면 대체값이 순위에 반영되지 않는다. */
  /* 지역 바닥값은 **원본 행**에서 뽑는다. `forecasts`는 오늘 값이 있는 곳만
     담는데, 부산 해운대구는 570행을 정상으로 받고도 그 맵이 비어 8건 모두
     빈칸이었다 — 시계열 창이 지역마다 다르다. 응답에 가장 최근으로 들어 있는
     날짜를 쓰면 한 줄이라도 온 지역은 반드시 값을 얻는다. */
  const withNeighbors = withNeighborCrowd(
    preliminary,
    districtRatesFrom(crowdItems),
  ).map((candidate) => ({
    ...candidate,
    ...scoreCandidate(candidate, input),
  }));
  preliminary.length = 0;
  preliminary.push(...withNeighbors);

  preliminary.sort(
    (a, b) => b.baseScore - a.baseScore || a.distanceMeters - b.distanceMeters,
  );

  /* 체류가 시작될 시각이 밤이면 분류 순회 순서를 야간 운영 가능성 순으로 놓는다.
     후보를 버리지 않고 정렬만 바꾸므로, 최악의 경우도 오늘과 같은 결과다. */
  const nightFirst = isNightWindow(referenceAt);
  const verificationPool = diversifyCandidatesByCategory(preliminary, {
    nightFirst,
  }).slice(0, CONTINUITY_VERIFICATION_HARD_LIMIT);

  /* 예산 계량기를 **여기서** 만든다. 예전에는 무장애 상세 조회가 끝난 뒤에
     만들었고, 그 조회는 계량기를 모른 채 검증 풀 36곳 전부에 1건씩 호출했다.
     원장에 36건이 쌓인 뒤 계량기가 그것을 읽으면 45건 중 42~44건이 이미 쓴
     것으로 계산되어, 실제 검증은 한 곳도 하지 못했다. 실측에서 휠체어·유아차
     대상은 명동·대전·제주에서 예외 없이 추천 0곳·탈락 0건이었다 — 화면이 이유
     조차 말할 수 없는 상태다. */
  const meter: SubrequestMeter = {
    spent: upstreamCallsSpent(sourceLedger) + ORIGIN_WEATHER_CALLS,
    budget: subrequestBudget(),
    exhausted: false,
    routeCost: perCandidateRouteCost(input, context),
  };

  /* 접근성 상세를 **검증할 수 있는 만큼만** 조회한다. 검증하지 못할 후보의
     접근성을 확인해 두는 것은 그 자체로 낭비이고, 그 낭비가 검증 예산을 먹는다.
     후보 한 곳을 끝까지 보는 비용은 접근성 1 + 운영시간 1 + 경로 routeCost다. */
  const perCandidateFullCost =
    (input.audience === "general" || disabled.has("KorWithService2") ? 0 : 1) +
    1 +
    meter.routeCost;
  const affordableCandidates = Math.max(
    0,
    Math.floor((meter.budget - meter.spent) / perCandidateFullCost),
  );

  /* 제거실험으로 무장애 정보를 끈 경우에는 상세 조회도 하지 않는다. 목록만
     끄고 상세는 호출하면 "무장애 정보 없이도 검증된다"는 잘못된 비교가 된다. */
  const { details, audits: detailAudits } = await accessibilityDetails(
    verificationPool.slice(0, affordableCandidates),
    disabled.has("KorWithService2") ? "general" : input.audience,
    execution.signal,
    execution.deadlineAt,
    meter,
  );
  sourceLedger.push(...detailAudits);
  if (
    input.audience !== "general" &&
    !disabled.has("KorWithService2") &&
    affordableCandidates < verificationPool.length
  ) {
    warnings.push(
      `한 요청에 허용된 외부 조회 횟수 안에서 접근성을 확인할 수 있는 ${affordableCandidates.toLocaleString("ko-KR")}곳만 조회했습니다. 나머지 후보는 접근성을 확인하지 않았으므로 결과에 넣지 않았습니다.`,
    );
  }

  const accessibilityVerified = verificationPool
    .map((candidate) => {
      const accessibility = evaluateAccessibility(
        input.audience,
        disabled.has("KorWithService2")
          ? undefined
          : details.get(candidate.contentId),
      );
      const withAccessibility = { ...candidate, accessibility };
      return {
        ...withAccessibility,
        ...scoreCandidate(withAccessibility, input),
      };
    })
    .flatMap((candidate) => {
      if (input.audience === "general") return [candidate];

      /* 앞 단계는 "주변 무장애 목록에 이 곳이 있는가"만 보고 공백을 붙인다.
         그 목록에 없더라도 `detailWithTour2`가 필수 동선을 확인해 주는 경우가
         있는데, 예전 구현은 공백을 지우지 않아 확인된 곳도 영구히 미확인으로
         남았다. 그러면 유아차·휠체어·고령자를 고른 여행자는 접근성이 실제로
         확인된 후보조차 적용할 수 없다. 상세 조회 결과가 최종 판정이다. */
      if (candidate.accessibility.status === "verified") {
        return [
          {
            ...candidate,
            evidenceGaps: candidate.evidenceGaps.filter(
              (gap) => gap.code !== "ACCESSIBILITY_UNVERIFIED",
            ),
          },
        ];
      }

      /* Same three-tier rule as the earlier checks: a detail lookup that came
         back without accessibility fields records a gap, it does not delete
         the candidate. 확인하지 못한 사실을 숨기지 않고 그대로 보여 준 뒤,
         적용만 막는다 — 화면에서 지워 버리면 여행자는 그런 곳이 있었다는 것도,
         왜 쓸 수 없는지도 알지 못한다. */
      if (
        !candidate.evidenceGaps.some(
          (gap) => gap.code === "ACCESSIBILITY_UNVERIFIED",
        )
      ) {
        return [
          {
            ...candidate,
            evidenceGaps: [
              ...candidate.evidenceGaps,
              {
                code: "ACCESSIBILITY_UNVERIFIED" as const,
                note: candidate.accessibility.note,
                noteEn: candidate.accessibility.noteEn,
              },
            ],
          },
        ];
      }
      return [candidate];
    })
    /* Fully confirmed candidates are verified and offered first; those with a
       gap are only reached when there are not enough confirmed ones. */
    .sort((a, b) => a.evidenceGaps.length - b.evidenceGaps.length);

  const continuityDeadlineAt =
    execution.deadlineAt ?? Date.now() + 23_000;

  /* Verifying the shortlist in sequence made the response time the sum of
     three candidates rather than roughly one. Each candidate waits on a
     walking route and an opening-hours lookup that do not depend on each
     other, so they are verified together. The routing provider's own pacing
     still orders those requests; what this removes is the idle time where one
     candidate's opening-hours call sat waiting for another candidate's route.
     Failures stay per-candidate — one that cannot be verified drops out
     without taking the others with it. */
  const continuityCandidates: WorkingCandidate[] = [];
  /* 공식 분류를 순환해 최대 24곳을 검증한다. 각 후보는 실제 경로와 운영시간을
     모두 통과해야 하며, 25초 요청 신호가 끝나면 미검증 후보는 결과에 넣지 않는다. */
  const shortlist = diversifyCandidatesByCategory(accessibilityVerified, {
    nightFirst,
  });
  if (Date.now() >= continuityDeadlineAt || execution.signal?.aborted) {
    warnings.push(
      "위기 순간 응답시간을 지키기 위해 상위 후보 검증을 중단했습니다. 확인하지 않은 후보를 결과처럼 표시하지 않았습니다.",
    );
  } else {
    /* 후보 지점의 예보를 따로 가져온다. 출발지 한 점의 예보를 모든 후보에
       재사용하면 시간상 도달 가능한 먼 후보의 실제 날씨가 달라도 놓친다.
       격자가 같은 후보는 한 번만 조회하며, 실패하면 출발지 예보로 물러서고
       그 사실을 밝힌다 — 다른 지점의 예보를 이 곳의 예보인 것처럼 쓰면 안 된다. */
    const gridWeather = new Map<
      string,
      Awaited<ReturnType<typeof getWeatherEvidence>>
    >();
    let candidateForecastFallbacks = 0;
    const gridKey = (candidate: WorkingCandidate) => {
      const { nx, ny } = toKmaGrid(candidate.latitude, candidate.longitude);
      return `${nx},${ny}`;
    };
    const originGrid = toKmaGrid(input.origin.latitude, input.origin.longitude);
    const distinctGrids = new Map<string, WorkingCandidate>();
    for (const candidate of shortlist) {
      const key = gridKey(candidate);
      if (key === `${originGrid.nx},${originGrid.ny}`) continue;
      if (!distinctGrids.has(key)) distinctGrids.set(key, candidate);
    }
    /* 후보 지점 예보는 정확도를 높이는 값이지, 갈 수 있는지를 가르는 값이
       아니다. 예산이 빠듯하면 여기에 격자마다 두 건씩 쓰는 대신 그 몫으로 후보를
       더 검증한다 — 출발지 예보로 물러서는 길은 이미 있고, 물러섰다는 사실도
       아래에서 밝힌다. 검증 몫을 먼저 떼어 두고 남는 것으로만 부른다.

       예약은 같은 계량기에서 한다. 예전에는 여기만 별도 계산을 했고, 그 계산은
       원장 항목 수를 세는 옛 방식이었다. 두 곳이 다른 숫자를 보면 어느 쪽도
       실제 호출량을 알지 못한다. */
    const forecastCost = distinctGrids.size * CANDIDATE_GRID_WEATHER_CALLS;
    const verificationReserve =
      MIN_RESERVED_VERIFICATION_CANDIDATES * (1 + meter.routeCost);
    const affordCandidateForecast =
      meter.spent + forecastCost + verificationReserve <= meter.budget;
    if (!affordCandidateForecast && distinctGrids.size) {
      candidateForecastFallbacks += distinctGrids.size;
      distinctGrids.clear();
    } else if (distinctGrids.size) {
      reserveSubrequests(meter, forecastCost);
    }
    if (distinctGrids.size) {
      const fetched = await Promise.allSettled(
        [...distinctGrids.entries()].map(async ([key, candidate]) => {
          const evidence = await getWeatherEvidence(
            candidate.latitude,
            candidate.longitude,
            { signal: execution.signal },
          );
          return [key, evidence] as const;
        }),
      );
      for (const entry of fetched) {
        if (entry.status === "fulfilled") {
          gridWeather.set(entry.value[0], entry.value[1]);
        } else {
          candidateForecastFallbacks += 1;
        }
      }
    }
    if (candidateForecastFallbacks) {
      warnings.push(
        `후보 ${candidateForecastFallbacks}곳의 기상 예보를 따로 확인하지 못해 출발지 예보로 판단했습니다. 거리가 멀면 실제 날씨가 다를 수 있습니다.`,
      );
    }

    /* 검증할 후보들의 운영정보 사본을 **한 번의 질의로** 읽는다. 후보마다 따로
       읽으면 D1 왕복이 응답 시간에 쌓이고 무료 플랜의 CPU 상한에서도 불리하다.

       D1은 내부 서비스이므로 이 질의는 외부 50건 예산이 아니라 내부 1,000건
       예산을 쓴다. 그것이 이 구조 전체의 요점이다. */
    const hoursSnapshots = await readHoursSnapshots(
      shortlist.map((candidate) => ({
        contentId: candidate.contentId,
        contentTypeId: candidate.contentTypeId,
        sourceModifiedAt: candidate.modifiedAt,
      })),
    );
    /* 경로 사본도 한 번의 질의로 읽는다. 키는 후보 지점까지 확정되므로 검증
       목록이 정해진 이 자리에서 미리 만들 수 있다. */
    const requiresOriginReturnForAll = Boolean(
      context?.openWindow && !context.nextFixed,
    );
    const routeKeyByContentId = new Map<
      string,
      ReturnType<typeof routeSnapshotKey>
    >();
    if (
      context &&
      isCacheableRouteMode(input.travelMode) &&
      !requiresOriginReturnForAll
    ) {
      for (const candidate of shortlist) {
        routeKeyByContentId.set(
          candidate.contentId,
          routeSnapshotKey(
            [
              input.origin,
              { latitude: candidate.latitude, longitude: candidate.longitude },
              ...context.continuityNodes.map((node) => ({
                latitude: node.location!.latitude,
                longitude: node.location!.longitude,
              })),
            ],
            input.travelMode as RouteSnapshotMode,
          ),
        );
      }
    }
    const routeSnapshotCache = await readRouteSnapshots(
      [...routeKeyByContentId.values()]
        .map((parts) => parts?.id)
        .filter((id): id is string => Boolean(id)),
    );

    let attemptedCandidates = 0;
    /* 예산이 부족해 **아무 호출도 하지 못하고** 물러난 후보. 탈락이 아니므로
       `rejected`에 넣지 않지만, 세어서 밝힌다.

       예전에는 이 부류가 어디에도 남지 않았다. 배치 6곳이 운영정보 예산을 각자
       선점한 뒤 경로 예산을 못 얻어 전부 `null`로 빠지면, 실제 조회 6건을 쓰고
       결과는 0곳인데 `rejected`·`rejectionSummary`·경고문 어디에도 그 6곳이
       없었다. 화면은 "추천 0곳, 탈락 0건"이라는, 아무 근거도 없는 상태가 된다. */
    let unexaminedCandidates = 0;
    let offset = 0;
    while (
      offset < shortlist.length &&
      continuityCandidates.length < CONTINUITY_RESULT_LIMIT
    ) {
      if (
        execution.signal?.aborted ||
        continuityDeadlineAt - Date.now() <=
          CONTINUITY_VERIFICATION_RESERVE_MS
      ) {
        break;
      }

      /* **먼저 몇 곳을 감당할 수 있는지 계산하고 그만큼만 시작한다.**
         `batch.map`은 비동기 함수를 동기적으로 매핑하므로, 첫 `await`가 풀리기
         전에 배치의 모든 후보가 운영정보 예산을 선점한다. 남은 예산이 경로 한
         건뿐인데 여섯 곳을 시작하면, 여섯 곳 모두 운영정보를 실제로 조회한 뒤
         경로를 얻지 못해 버려진다 — 조회는 나갔고 결과는 없다. */
      /* 사본이 있는 후보는 운영정보 호출을 쓰지 않는다. 다음 묶음에서 사본이
         있는 비율을 그대로 반영해 수용량을 계산한다 — 1을 항상 더하면 사본이
         더워진 지역에서 실제로 감당할 수 있는 후보를 스스로 줄이게 된다. */
      const lookahead = shortlist.slice(
        offset,
        offset + CONTINUITY_VERIFICATION_BATCH_SIZE,
      );
      const cachedHours = lookahead.filter((candidate) =>
        hoursSnapshots.has(candidate.contentId),
      ).length;
      const cachedRoutes = lookahead.filter((candidate) => {
        const key = routeKeyByContentId.get(candidate.contentId);
        return key ? routeSnapshotCache.has(key.id) : false;
      }).length;
      const averageAvailabilityCost =
        lookahead.length > 0
          ? (lookahead.length - cachedHours) / lookahead.length
          : 1;
      const averageRouteCost =
        lookahead.length > 0
          ? (meter.routeCost * (lookahead.length - cachedRoutes)) /
            lookahead.length
          : meter.routeCost;
      /* 사본이 전부 있으면 이 후보들은 외부 호출을 하나도 쓰지 않는다. 그래도
         1로 내림해 수용량이 무한이 되지 않게 한다 — 시간 예산과 결과 상한이
         여전히 작동해야 한다. */
      const perCandidate = Math.max(
        1,
        Math.ceil(averageAvailabilityCost + averageRouteCost),
      );
      const affordable = Math.floor(
        (meter.budget - meter.spent) / perCandidate,
      );
      if (affordable <= 0) {
        meter.exhausted = true;
        break;
      }
      const batchSize = Math.min(
        CONTINUITY_VERIFICATION_BATCH_SIZE,
        affordable,
        CONTINUITY_RESULT_LIMIT - continuityCandidates.length,
      );
      const batch = shortlist.slice(offset, offset + batchSize);
      if (!batch.length) break;
      offset += batch.length;
      attemptedCandidates += batch.length;
      const settled = await Promise.allSettled(
        batch.map((candidate) =>
          enrichForContinuity({
            candidate,
            input,
            context,
            sourceLedger,
            rejected,
            weatherEvidence:
              gridWeather.get(gridKey(candidate)) ?? weatherEvidence,
            signal: execution.signal,
            meter,
            hoursSnapshots,
            snapshotWrites,
            snapshotHits: snapshotUsage,
            routeSnapshots: routeSnapshotCache,
            routeSnapshotWrites,
            routeSnapshotHits: routeSnapshotUsage,
          }),
        ),
      );
      for (const entry of settled) {
        if (entry.status === "fulfilled" && entry.value) {
          continuityCandidates.push(entry.value);
        }
      }
    }

    /* 예산·시간 때문에 아예 보지 못한 후보. 위 수용 제어가 시작 자체를 막으므로
       이 값은 "시작했다가 조용히 사라진 수"가 아니라 "시작하지 않은 수"다. */
    unexaminedCandidates = shortlist.length - attemptedCandidates;

    if (
      unexaminedCandidates > 0 &&
      continuityCandidates.length < CONTINUITY_RESULT_LIMIT
    ) {
      /* 왜 멈췄는지를 갈라 적는다. 두 한도는 사용자가 할 수 있는 일이 다르다 —
         시간이면 다시 시도하면 되고, 호출 한도면 다시 시도해도 같다.

         그리고 **시도한 수를 "검증했다"고 적지 않는다.** 예전 문구는
         `attemptedCandidates`를 그대로 넣어서 "6곳을 실제 경로·운영시간으로
         검증했습니다"라고 말하면서 추천은 0곳인 응답을 만들었다. 검증 정직성이
         이 제품의 약속인데 그 약속을 말하는 문장 자체가 과장돼 있었다. */
      const verified = continuityCandidates.length;
      warnings.push(
        meter.exhausted
          ? `한 요청에 허용된 외부 조회 횟수 안에서 ${attemptedCandidates}곳을 조회해 ${verified}곳이 실제 경로·운영시간을 통과했습니다. 나머지 ${unexaminedCandidates}곳은 조회하지 않았으므로 결과처럼 표시하지 않았습니다.`
          : `응답 시간 예산 안에서 ${attemptedCandidates}곳을 조회해 ${verified}곳이 실제 경로·운영시간을 통과했습니다. 조회하지 못한 ${unexaminedCandidates}곳은 결과처럼 표시하지 않았습니다.`,
      );
    }
  }

  /* 이번에 실시간으로 받아 온 원문을 사본으로 남긴다. 추가 외부 호출이 없고,
     실패해도 이 응답은 이미 실시간 근거로 완성되어 있다. */
  await writeHoursSnapshots(snapshotWrites);
  await writeRouteSnapshots(routeSnapshotWrites);

  const options = pickOptions(continuityCandidates, requestId, input).slice(
    0,
    CONTINUITY_RESULT_LIMIT,
  );
  /* 사본을 쓴 사실을 밝힌다. 몇 곳이 사본이었고 그 사본이 어떤 기준으로 최신인지
     말하지 않으면, 화면은 모든 판정이 방금 조회한 것이라고 읽히게 된다. */
  /* 분류를 좁혀 조회를 아꼈다는 사실을 밝힌다. 몇 곳이 범위 밖이었는지 말하지
     않으면 여행자는 그 지역에 그만큼밖에 없다고 읽는다. */
  if (categoryFilteredOut > 0) {
    warnings.push(
      `고른 관광 분류에 맞지 않는 ${categoryFilteredOut.toLocaleString("ko-KR")}곳은 운영시간·경로를 조회하지 않고 제외했습니다. 그만큼 아낀 조회를 고른 분류의 후보를 더 확인하는 데 썼습니다. 분류 선택을 넓히면 다른 곳도 함께 봅니다.`,
    );
  }
  if (routeSnapshotUsage.count > 0) {
    warnings.push(
      `후보 ${routeSnapshotUsage.count.toLocaleString("ko-KR")}곳의 이동 경로는 같은 출발 구역에서 이미 측정해 둔 실제 ${travelModeLabel(input.travelMode)} 경로를 사용했습니다. ${travelModeLabel(input.travelMode)} 경로는 시각에 따라 달라지지 않으며, 각 카드의 근거에 그 경로를 측정한 시각이 그대로 적혀 있습니다.`,
    );
  }
  if (snapshotUsage.count > 0) {
    warnings.push(
      `후보 ${snapshotUsage.count.toLocaleString("ko-KR")}곳의 운영시간은 이미 받아 둔 공식 원문으로 판정했습니다. 공사가 알린 콘텐츠 수정 시각이 지금과 같은 경우에만 사용하므로 지금 다시 조회해도 같은 내용이며, 판정 자체는 이번 요청의 체류 시간에 다시 대조했습니다. 그렇게 아낀 조회로 더 많은 후보를 확인했습니다.`,
    );
  }
  const hasSourceFailure = sourceLedger.some(
    (audit) => audit.status === "error",
  );
  const hasConditionalEvidence = options.some(
    (option) =>
      option.confirmationRequired ||
      option.availability.status !== "confirmed_open" ||
      (context &&
        option.continuityProof.routeEvidence.status !== "routed") ||
      (input.incident === "rain" &&
        option.continuityProof.weatherEvidence?.status !== "available"),
  );
  const availabilityProviderBlocked = rejected.some(
    (candidate) =>
      candidate.reasonCode ===
      "OPERATING_STATUS_UPSTREAM_UNAVAILABLE",
  );
  /* A single failed detail lookup must not turn an otherwise completed
     recovery into a service-wide 503. The incident that exposed this had
     four successful discovery pages and six successful operating-detail
     responses; one transient NETWORK_ERROR nevertheless promoted all 202
     rejections to `upstream_unavailable`. Keep every unverified candidate
     fail-closed, but reserve 503 for the case where the operating-information
     provider did not answer any of the detail checks needed by this run. */
  const availabilityAudits = sourceLedger.filter(
    (audit) =>
      audit.apiName === "KorService2" &&
      audit.operation === "detailIntro2",
  );
  const availabilityProviderUnavailable =
    availabilityProviderBlocked &&
    availabilityAudits.some((audit) => audit.status === "error") &&
    !availabilityAudits.some(
      (audit) => audit.status === "live" || audit.status === "empty",
    );
  const availabilityPartiallyUnavailable =
    availabilityProviderBlocked && !availabilityProviderUnavailable;
  const status =
    options.length === 0
      ? availabilityProviderUnavailable
        ? "upstream_unavailable"
        : "no_valid_candidate"
      : hasSourceFailure || hasConditionalEvidence
        ? "degraded"
        : "verified";

  if (!options.length) {
    warnings.push(
      availabilityProviderUnavailable
        ? "공식 운영정보 제공자 장애로 후보의 실제 운영 여부를 확인하지 못했습니다. 데이터가 없다고 간주하지 않았으며, 검증 없이 장소를 추천하지 않습니다. 잠시 후 다시 시도해 주세요."
        : availabilityPartiallyUnavailable
          ? "일부 후보의 공식 운영정보를 일시적으로 확인하지 못해 해당 후보만 제외했습니다. 확인된 다른 후보는 계속 검증했으며, 검증 없이 장소를 추천하지 않습니다."
        : context?.nextFixed
          ? "다음 고정 일정의 도착 안전여유와 모든 필수 조건을 함께 만족하는 복구안을 찾지 못했습니다. 잠금 일정을 임의로 변경하지 않았습니다."
          : "현재 조건을 모두 만족하는 공식 관광지 후보를 찾지 못했습니다. 존재하지 않는 장소를 만들어 추천하지 않았습니다.",
    );
  }

  const dataContributions = options
    .flatMap((option) => option.dataContributions)
    .filter(
      (contribution, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.source === contribution.source &&
            candidate.decision === contribution.decision,
        ) === index,
    );

  return {
    requestId,
    referenceTime,
    status,
    recoveryMode,
    itinerarySummary: summariseItinerary(context),
    /* 비교 기준 지점의 시점별 날씨. 일정 복구는 문제가 생긴 장소, 빈 시간
       추천은 현재 위치가 기준이다. 대안 카드의 같은 시점과 나란히 놓여야
       "여기가 나은가"를 판단할 수 있다. */
    originWeatherGlance: (() => {
      const glance = weatherGlance(weatherEvidence, referenceAt, {
        preferForecast: referenceTime.mode === "assumed",
      });
      return glance.length ? glance : undefined;
    })(),
    originWeatherLabel:
      context?.disrupted?.title ?? input.origin.label ?? "현재 위치",
    openWindowSummary: summariseOpenWindow(context),
    ablation: summariseAblation(input, options),
    scope: {
      coverage: "nationwide",
      regionCode,
      districtCode,
      originLabel: input.origin.label,
    },
    options,
    rejectedCount: rejected.length,
    /* Which constraint actually removed the candidates. Without this a run
       that returns nothing is indistinguishable from a broken one — for the
       traveller, who cannot tell "no room in your schedule" from "the service
       failed", and for the operator, who cannot tell which filter is doing
       the work. Counts only; no place names, so it stays safe to log. */
    rejectionSummary: summariseRejections(rejected),
    counterfactual: selectCounterfactual(rejected),
    /* 조건을 바꾸면 갈 수 있는 곳과 지금은 닫은 곳. `options`와 분리된 배열이라
       기존 적용·저장 경로는 이 값을 보지 않는다 — 검증된 추천만 적용된다. */
    alternatives: summariseAlternatives(rejected),
    dataContributions,
    sourceLedger,
    warnings,
    generatedAt: new Date().toISOString(),
    ruleVersion: RECOVERY_RULE_VERSION,
  };
}
