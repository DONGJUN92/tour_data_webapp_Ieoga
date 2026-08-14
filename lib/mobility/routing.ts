import {
  kakaoRoutingConfigured,
  routingEndpoints,
  routingProviderConfig,
  tmapCarConfigured,
  tmapPedestrianConfigured,
} from "@/lib/external-providers";
import {
  getKakaoBicycleRoute,
  getKakaoTransitRoute,
} from "@/lib/mobility/kakao-routing";
import { getTmapCarRoute } from "@/lib/mobility/tmap-car";
import { getTmapPedestrianRoute } from "@/lib/mobility/tmap-pedestrian";

export type RoutePoint = {
  latitude: number;
  longitude: number;
};

export type RouteLeg = {
  distanceMeters: number;
  durationMinutes: number;
};

export type RouteTimeBasis =
  | "time_independent"
  | "provider_departure_prediction"
  | "provider_current_schedule";

/* 여행자가 고르는 이동수단. 도착 시각이 "다음 약속을 지킬 수 있는가"의 판정
   근거이므로, 어느 수단으로 계산했는지는 결과와 함께 반드시 드러나야 한다. */
export type TravelMode = "walk" | "car" | "transit" | "bicycle";

export type RouteRequestOptions = {
  signal?: AbortSignal;
  mode?: TravelMode;
  departureAt?: string;
  arriveBy?: string;
};

export type WalkingRouteProvider =
  | "tmap_pedestrian"
  | "tmap_car"
  | "kakao_transit"
  | "kakao_bicycle"
  | "openstreetmap_osrm";

export type WalkingRouteEvidence =
  | {
      status: "routed";
      provider: WalkingRouteProvider;
      distanceMeters: number;
      durationMinutes: number;
      legs: RouteLeg[];
      geometry: Array<{ latitude: number; longitude: number }>;
      calculatedAt: string;
      attribution: string;
      /* 자동차 경로에서 제공자가 준 예상 요금. 계산해 만들지 않는다. */
      taxiFareKrw?: number;
      tollFareKrw?: number;
      /* 대중교통에서 제공자가 준 요금·환승·구간 구성. */
      fareKrw?: number;
      transfers?: number;
      transitSteps?: Array<{
        type: "BUS" | "SUBWAY" | "WALKING";
        durationMinutes: number;
        guidance?: string;
      }>;
      /* 배차에 따라 달라지는 소요시간인가. 참이면 도착 시각을 확정값처럼
         제시해서는 안 된다. */
      scheduleDependent?: boolean;
      /* 요청한 시각과 제공자가 실제로 평가한 시각이 다른가. 카카오 대중교통은
         좌표만 받고 미래 시각표를 모르므로, 미래 출발이나 도착 마감을 요청해도
         돌아오는 값은 **조회 시점 시각표** 기준이다. 예전에는 그 사실 때문에
         후보를 통째로 탈락시켰는데, 그러면 대중교통을 고른 여행자는 언제나
         0건을 받았다. 값을 쓰되 이 표식을 함께 올려 화면이 "조회 시점 시각표
         기준"이라고 말할 수 있게 한다. 조용히 확정값인 척하지 않는다. */
      assumesCurrentTimetable?: boolean;
      /* Whether the provider actually evaluated a requested clock time. */
      timeBasis: RouteTimeBasis;
      requestedDepartureAt?: string;
      requestedArriveBy?: string;
    }
  | {
      status: "unavailable";
      provider: WalkingRouteProvider;
      reason: string;
      calculatedAt: string;
      attribution: string;
    };

const ATTRIBUTION: Record<WalkingRouteProvider, string> = {
  tmap_pedestrian: "보행 경로 · TMAP 보행자 경로안내 (SK텔레콤)",
  tmap_car: "자동차 경로 · TMAP 자동차 경로안내 (SK텔레콤)",
  kakao_transit: "대중교통 경로 · 카카오맵 대중교통 길찾기 (카카오)",
  kakao_bicycle: "자전거 경로 · 카카오맵 자전거 길찾기 (카카오)",
  openstreetmap_osrm: "© OpenStreetMap contributors",
};

const MODE_PROVIDER: Record<TravelMode, WalkingRouteProvider> = {
  walk: "tmap_pedestrian",
  car: "tmap_car",
  transit: "kakao_transit",
  bicycle: "kakao_bicycle",
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<
  string,
  { expiresAt: number; value: WalkingRouteEvidence }
>();
let nextPublicRequestAt = 0;

/* 카카오 경로 API는 한도를 초과해도 429가 아니라 **HTTP 400**에
   `{"code":-10,"message":"API limit has been exceeded."}`를 담아 돌려준다.
   400은 보통 "요청이 잘못됐다"는 뜻이라 재시도할 이유가 없는 실패로 읽히고,
   실제로 그렇게 읽혀 왔다 — 한도에 걸린 후보가 "이 좌표로는 경로가 없다"와
   구분되지 않은 채 조용히 탈락했다.

   실측(2026-08-14, 자전거 44건): 동시 실행 수는 아무 영향이 없었다. 동시 12,
   6, 3 모두 정확히 20건만 통과했고 나머지는 한도 초과였다. 반면 초당 약 11건으로
   흘려보내면 44건 전부 통과했다. 즉 이것은 동시성 제한이 아니라 **속도 제한**
   이며, 20건쯤의 버킷이 있고 그 뒤로는 보충 속도를 따라야 한다.

   그래서 동시성 대신 간격을 둔다. 125ms는 초당 8건으로, 실측에서 전부 통과한
   11건/초보다 여유를 둔 값이다. 36곳 검증에 필요한 72건이면 약 9초인데,
   대부분은 캐시와 조기 종료로 그보다 훨씬 적게 부른다. */
const KAKAO_MIN_REQUEST_SPACING_MS = 125;
/* 실측에서 한도에 걸리기 전까지 스무 건 남짓이 즉시 통과했다. 즉 버킷에는
   여유분이 있고, 조용하다가 들어온 요청까지 간격을 지킬 이유는 없다. 열여섯 건
   까지는 밀린 시간을 미리 쓸 수 있게 해 두면, 후보가 적거나 경로가 캐시에 있는
   보통의 요청은 전혀 느려지지 않고 긴 요청의 꼬리만 고르게 퍼진다. */
const KAKAO_BURST_CREDIT = 16;
const KAKAO_RATE_LIMIT_RETRIES = 2;
let nextKakaoRequestAt = 0;

function isKakaoRateLimit(error: unknown): boolean {
  return (
    error instanceof Error && error.message === "KAKAO_RATE_LIMITED"
  );
}

async function respectKakaoRoutingLimit(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  /* 슬롯을 동기적으로 예약한다. 앞 호출의 프라미스에 사슬로 매다는 방식은
     호출이 중도 포기되면 그 자리에서 영영 멈춘다 — 공개 라우터 쪽에서 이미
     겪은 실패 방식이라 같은 실수를 반복하지 않는다. */
  /* 예약 시각이 현재보다 뒤처져 있으면 그만큼이 쓰지 않은 여유분이다. 다만
     아무리 오래 조용했어도 한 번에 몰아 쓸 수 있는 양은 버킷 크기까지다. */
  const earliestSlot =
    now - KAKAO_BURST_CREDIT * KAKAO_MIN_REQUEST_SPACING_MS;
  const slotAt = Math.max(earliestSlot, nextKakaoRequestAt);
  nextKakaoRequestAt = slotAt + KAKAO_MIN_REQUEST_SPACING_MS;
  const waitMs = slotAt - now;
  if (waitMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function routeKey(points: RoutePoint[]) {
  return points
    .map((point) => `${point.longitude.toFixed(5)},${point.latitude.toFixed(5)}`)
    .join(";");
}

/* 캐시 키에 이동수단을 포함한다. 빠뜨리면 같은 좌표쌍에서 도보로 52분인 결과가
   자차 조회에 그대로 반환되고, 그 값으로 도착 가능 판정이 내려진다. */
function normalizedInstant(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function cacheKey(
  points: RoutePoint[],
  mode: TravelMode,
  departureAt?: string,
  arriveBy?: string,
  transitAssumesCurrentTimetable = false,
) {
  /* Walking and bicycle providers expose geometry/pace, not a traffic or
     timetable prediction. Their result is explicitly time-independent. */
  if (mode === "walk" || mode === "bicycle") {
    return `${mode}:static:${routeKey(points)}`;
  }
  /* Kakao transit reads coordinates only, so two requests for the same pair
     return the same duration whatever clock time was asked for. Keying by the
     requested instant would re-fetch an identical answer for every candidate.
     What must not be shared is the disclosure: a result computed for a future
     departure carries the "current timetable" caveat and a live one does not,
     so that distinction — and only that — stays in the key. */
  if (mode === "transit") {
    return `transit:${transitAssumesCurrentTimetable ? "assumed" : "live"}:${routeKey(points)}`;
  }
  return `${mode}:${departureAt ?? "provider-now"}:${arriveBy ?? "no-deadline"}:${routeKey(points)}`;
}

/* Paces calls to the shared public router, which asks for no more than one
   request per second.

   This used to chain each caller onto a promise the previous caller resolved.
   That deadlocks: when a request is abandoned — the recovery deadline fires,
   the client disconnects — its call stays suspended at the await and never
   resolves the promise the next caller is chained to, so every routing call
   afterwards blocks forever and the process serves nothing. It survived
   review because sequential callers rarely overlapped; verifying candidates
   concurrently made it reproducible on the first timeout.

   Reserving a timestamp instead has no such failure mode. The slot is claimed
   synchronously, so concurrent callers get distinct slots in arrival order,
   and a caller that goes away simply leaves an unused gap. There is nothing to
   release and therefore nothing to leak. */
async function respectPublicRoutingLimit(signal?: AbortSignal): Promise<void> {
  if (routingProviderConfig().mode !== "public_shared") return;
  const now = Date.now();
  const slotAt = Math.max(now, nextPublicRequestAt);
  nextPublicRequestAt = slotAt + 1_050;
  const waitMs = slotAt - now;
  if (waitMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function getWalkingRoute(
  points: RoutePoint[],
  options: Omit<RouteRequestOptions, "mode"> = {},
): Promise<WalkingRouteEvidence> {
  return getRoute(points, { ...options, mode: "walk" });
}

export async function getRoute(
  points: RoutePoint[],
  options: RouteRequestOptions = {},
): Promise<WalkingRouteEvidence> {
  const mode: TravelMode = options.mode ?? "walk";
  const requestedDepartureAt = normalizedInstant(options.departureAt);
  const requestedArriveBy = normalizedInstant(options.arriveBy);
  const calculatedAt = new Date().toISOString();
  const attribution =
    mode === "walk"
      ? ATTRIBUTION.openstreetmap_osrm
      : ATTRIBUTION[MODE_PROVIDER[mode]];
  const unavailableProvider: WalkingRouteProvider =
    mode === "walk" ? "openstreetmap_osrm" : MODE_PROVIDER[mode];
  if (points.length < 2 || points.length > 32) {
    return {
      status: "unavailable",
      provider: unavailableProvider,
      reason: "경로 계산에는 2~32개 지점이 필요합니다.",
      calculatedAt,
      attribution,
    };
  }

  /* Kakao transit accepts only coordinates and cannot prove a future
     timetable. This used to fail closed — any future departure or arrive-by
     deadline returned `unavailable` before the provider was even called.

     The open-window flow always supplies an arrive-by deadline for the return
     leg, so that guard rejected **every** transit candidate on every request:
     picking 대중교통 could not produce a single result, while 자전거 with the
     same inputs worked. Failing closed did not make the product more honest —
     it made one travel mode permanently empty.

     So the route is fetched and the assumption is disclosed instead. The
     duration reflects the timetable at the moment of the query; the flag below
     travels with the evidence so the card can say exactly that, and
     `scheduleDependent` still keeps the arrival from being shown as fixed. */
  const transitAssumesCurrentTimetable =
    mode === "transit" &&
    ((requestedDepartureAt &&
      Date.parse(requestedDepartureAt) > Date.now() + 60_000) ||
      Boolean(requestedArriveBy));

  const key = cacheKey(
    points,
    mode,
    requestedDepartureAt,
    requestedArriveBy,
    transitAssumesCurrentTimetable,
  );
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  /* 자동차는 TMAP만 쓴다. 공개 OSRM에는 자동차 프로파일이 없으므로 실패하면
     확인하지 못한 채 탈락시킨다. 잘못된 단위로 통과시키지 않는 것이 우선이다. */
  if (mode === "car") {
    if (!tmapCarConfigured()) {
      return {
        status: "unavailable",
        provider: "tmap_car",
        reason:
          "자동차 경로 제공자가 설정되지 않아 이동시간을 확인하지 못했습니다.",
        calculatedAt,
        attribution,
      };
    }
    try {
      const car = await getTmapCarRoute(points, {
        signal: options.signal,
        departureAt: requestedDepartureAt,
      });
      if (car) {
        const routed: WalkingRouteEvidence = {
          status: "routed",
          provider: "tmap_car",
          distanceMeters: car.distanceMeters,
          durationMinutes: car.durationMinutes,
          legs: car.legs,
          geometry: car.geometry,
          calculatedAt,
          attribution: ATTRIBUTION.tmap_car,
          taxiFareKrw: car.taxiFareKrw,
          tollFareKrw: car.tollFareKrw,
          timeBasis: requestedDepartureAt
            ? "provider_departure_prediction"
            : "provider_current_schedule",
          requestedDepartureAt,
          requestedArriveBy,
        };
        cache.set(key, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          value: routed,
        });
        return routed;
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DOMException("Routing request cancelled", "AbortError");
      }
      void error;
    }
    return {
      status: "unavailable",
      provider: "tmap_car",
      reason: "자동차 경로 공급자가 현재 응답하지 않습니다.",
      calculatedAt,
      attribution,
    };
  }

  /* 대중교통·자전거는 카카오만 쓴다. 공개 OSRM에는 두 프로파일이 없으므로
     실패하면 확인하지 못한 채 탈락시킨다. 자동차와 같은 규칙이다. */
  if (mode === "transit" || mode === "bicycle") {
    const provider = MODE_PROVIDER[mode];
    if (!kakaoRoutingConfigured()) {
      return {
        status: "unavailable",
        provider,
        reason:
          mode === "transit"
            ? "대중교통 경로 제공자가 설정되지 않아 이동시간을 확인하지 못했습니다."
            : "자전거 경로 제공자가 설정되지 않아 이동시간을 확인하지 못했습니다.",
        calculatedAt,
        attribution,
      };
    }
    let kakao:
      | Awaited<ReturnType<typeof getKakaoTransitRoute>>
      | undefined;
    let rateLimited = false;
    try {
      /* 한도에 걸리면 잠시 물러났다가 다시 묻는다. 간격을 두어도 다른 요청이
         같은 앱키의 버킷을 함께 쓰므로 완전히 피할 수는 없는데, 그때 후보를
         버리면 "경로가 없어서"가 아니라 "우리가 너무 빨리 물어서" 사라진다. */
      for (let attempt = 0; attempt <= KAKAO_RATE_LIMIT_RETRIES; attempt += 1) {
        try {
          await respectKakaoRoutingLimit(options.signal);
          kakao =
            mode === "transit"
              ? await getKakaoTransitRoute(points, { signal: options.signal })
              : await getKakaoBicycleRoute(points, { signal: options.signal });
          rateLimited = false;
          break;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (!isKakaoRateLimit(error)) throw error;
          rateLimited = true;
          if (attempt === KAKAO_RATE_LIMIT_RETRIES) break;
          /* 버킷이 다시 차기를 기다린다. 실측 보충 속도가 초당 10건 안팎이라
             400ms면 몇 건은 회복된다. 시도마다 늘려 함께 밀린 호출들이 같은
             순간에 다시 몰리지 않게 한다. */
          nextKakaoRequestAt = Math.max(
            nextKakaoRequestAt,
            Date.now() + 400 * (attempt + 1),
          );
        }
      }
      if (kakao) {
        const routed: WalkingRouteEvidence = {
          status: "routed",
          provider,
          distanceMeters: kakao.distanceMeters,
          durationMinutes: kakao.durationMinutes,
          legs: kakao.legs,
          geometry: kakao.geometry,
          calculatedAt,
          attribution: ATTRIBUTION[provider],
          fareKrw: kakao.fareKrw,
          transfers: kakao.transfers,
          transitSteps: kakao.transitSteps,
          scheduleDependent: kakao.scheduleDependent,
          assumesCurrentTimetable: transitAssumesCurrentTimetable || undefined,
          timeBasis:
            mode === "transit"
              ? "provider_current_schedule"
              : "time_independent",
          requestedDepartureAt,
          requestedArriveBy,
        };
        cache.set(key, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          value: routed,
        });
        return routed;
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DOMException("Routing request cancelled", "AbortError");
      }
      void error;
    }
    /* 재시도까지 한도에 걸렸다면 "경로가 없다"가 아니라 "지금은 물어볼 수
       없었다"이다. 사유를 갈라 적어야 다시 시도하면 되는 상황인지 알 수 있다. */
    return {
      status: "unavailable",
      provider,
      reason: rateLimited
        ? mode === "transit"
          ? "대중교통 경로 조회 한도를 넘어 이번 요청에서는 확인하지 못했습니다. 잠시 후 다시 시도하면 확인할 수 있습니다."
          : "자전거 경로 조회 한도를 넘어 이번 요청에서는 확인하지 못했습니다. 잠시 후 다시 시도하면 확인할 수 있습니다."
        : mode === "transit"
          ? "대중교통 경로 공급자가 현재 응답하지 않습니다."
          : "자전거 경로 공급자가 현재 응답하지 않습니다.",
      calculatedAt,
      attribution,
    };
  }

  /* 국내 보행 경로는 TMAP이 지하상가·횡단보도를 더 정확히 반영한다. 도착
     시각이 "다음 예약을 지킬 수 있는가"의 판정 근거이므로 품질이 좋은 쪽을
     먼저 쓴다. 키가 없거나 실패하면 아래 OSRM 경로로 그대로 내려간다. */
  if (tmapPedestrianConfigured()) {
    try {
      const tmap = await getTmapPedestrianRoute(points, {
        signal: options.signal,
      });
      if (tmap) {
        const routed: WalkingRouteEvidence = {
          status: "routed",
          provider: "tmap_pedestrian",
          distanceMeters: tmap.distanceMeters,
          durationMinutes: tmap.durationMinutes,
          /* 구간별 결과를 그대로 전달한다. 엔진이 경유지마다 도착을 검증하므로
             합계 하나로 뭉치면 경유지가 있는 후보는 전부 탈락한다. */
          legs: tmap.legs,
          geometry: tmap.geometry,
          calculatedAt,
          attribution: ATTRIBUTION.tmap_pedestrian,
          timeBasis: "time_independent",
          requestedDepartureAt,
          requestedArriveBy,
        };
        cache.set(key, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          value: routed,
        });
        return routed;
      }
    } catch {
      if (options.signal?.aborted) {
        throw new DOMException("Routing request cancelled", "AbortError");
      }
      /* TMAP 실패는 결과가 아니다. 조용히 다음 공급자로 넘어간다. */
    }
  }

  /* Try each configured router in turn. A rejected candidate is a real
     product outcome here, so it must mean "no route exists", never "the one
     router we asked happened to be down". */
  const endpoints = routingEndpoints();
  let lastReason = "도보 경로 공급자가 현재 응답하지 않습니다.";
  let result: WalkingRouteEvidence | undefined;

  for (const baseUrl of endpoints) {
    if (options.signal?.aborted) {
      throw new DOMException("Routing request cancelled", "AbortError");
    }
    /* Keep any query the endpoint was configured with. Managed OSRM-compatible
       providers (Mapbox Directions and similar) authenticate with a query
       parameter, so appending the coordinates by string concatenation would
       land them after the query and break the request. Parsing first means a
       keyed provider works from configuration alone, with no per-provider
       code here. */
    const url = new URL(baseUrl);
    /* `key` also carries the cache namespace (`walk:`/`car:`). Sending that
       prefix to an OSRM-compatible endpoint makes the first longitude
       invalid. Only the coordinate portion belongs in the provider URL. */
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${routeKey(points)}`;
    url.searchParams.set("overview", "simplified");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "false");
    url.searchParams.set("alternatives", "false");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_500);
    try {
      await respectPublicRoutingLimit(options.signal);
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "IEOGA/1.0 (+https://github.com/DONGJUN92/tour_data_webapp_Ieoga/issues)",
        },
        signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      });
      if (!response.ok) {
        throw new Error(`ROUTING_HTTP_${response.status}`);
      }
      const payload = (await response.json()) as {
        code?: string;
        routes?: Array<{
          distance?: number;
          duration?: number;
          legs?: Array<{ distance?: number; duration?: number }>;
          geometry?: {
            coordinates?: Array<[number, number]>;
          };
        }>;
      };
      const route = payload.routes?.[0];
      if (
        payload.code !== "Ok" ||
        !route ||
        !Number.isFinite(route.distance) ||
        !Number.isFinite(route.duration)
      ) {
        throw new Error("ROUTING_EMPTY");
      }
      result = {
        status: "routed",
        provider: "openstreetmap_osrm",
        distanceMeters: Math.round(route.distance ?? 0),
        durationMinutes: Math.max(1, Math.ceil((route.duration ?? 0) / 60)),
        legs: (route.legs ?? []).map((leg) => ({
          distanceMeters: Math.round(leg.distance ?? 0),
          durationMinutes: Math.max(1, Math.ceil((leg.duration ?? 0) / 60)),
        })),
        geometry: (route.geometry?.coordinates ?? []).map(
          ([longitude, latitude]) => ({ latitude, longitude }),
        ),
        calculatedAt,
        attribution,
        timeBasis: "time_independent",
        requestedDepartureAt,
        requestedArriveBy,
      };
      break;
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DOMException("Routing request cancelled", "AbortError");
      }
      lastReason =
        error instanceof Error && error.name === "AbortError"
          ? "도보 경로 계산 시간이 초과되었습니다."
          : "도보 경로 공급자가 현재 응답하지 않습니다.";
    } finally {
      clearTimeout(timeout);
    }
  }

  const settled: WalkingRouteEvidence = result ?? {
    status: "unavailable",
    provider: "openstreetmap_osrm",
    reason: lastReason,
    calculatedAt,
    attribution,
  };

  /* Only successful routes are cached. Caching a transient outage would keep
     rejecting valid candidates for the whole TTL. */
  if (settled.status === "routed") {
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: settled });
  }
  return settled;
}
