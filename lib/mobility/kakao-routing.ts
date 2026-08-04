import {
  KAKAO_BICYCLE_ROUTE_URL,
  KAKAO_TRANSIT_ROUTE_URL,
} from "@/lib/external-providers";
import { getRuntimeSecret } from "@/lib/runtime-env";

/**
 * 카카오 대중교통·자전거 경로.
 *
 * 2026-08-04 실호출로 확인한 사실만 반영한다. 서울시청→강남 기준:
 * - `/v2/routing/publictraffic` 14개 경로, 1순위 지하철 11,737m/2,640s, 환승 1회,
 *   요금 1,650원. 단계마다 `type`(BUS·SUBWAY·WALKING)과 소요시간·정류장·차량이 온다.
 * - `/v2/routing/bicycle` 17,759m/4,222s. `via_x`/`via_y`로 경유지를 최대 5개까지
 *   받고, 응답의 `legs`가 경유지 기준으로 갈린다(실측 1,725s + 16,543s).
 *
 * 대중교통은 경유지 파라미터가 없다. 이어가는 경유지마다 도착을 검증하므로 구간을
 * 나눠 개별 호출하고 결과를 합친다. 자전거는 `via`로 한 번에 받아 leg을 그대로 쓴다.
 *
 * 대중교통 소요시간은 배차에 따라 달라진다. 그 불확실성을 숨기지 않기 위해 호출부가
 * 화면에 "배차에 따라 달라질 수 있다"를 표시할 수 있도록 `scheduleDependent`를 함께
 * 돌려준다.
 */

export type KakaoRoute = {
  distanceMeters: number;
  durationMinutes: number;
  legs: Array<{ distanceMeters: number; durationMinutes: number }>;
  geometry: Array<{ latitude: number; longitude: number }>;
  /* 대중교통에서만 채워진다. */
  fareKrw?: number;
  transfers?: number;
  /* 각 구간의 이동 방식. "지하철 12분 + 도보 5분"처럼 사람이 읽을 수 있게. */
  transitSteps?: Array<{
    type: "BUS" | "SUBWAY" | "WALKING";
    durationMinutes: number;
    guidance?: string;
  }>;
  scheduleDependent: boolean;
};

const MAX_SEGMENTS = 6;
const MAX_BICYCLE_WAYPOINTS = 5;

function pushPoint(
  into: Array<{ latitude: number; longitude: number }>,
  pair: unknown,
): void {
  if (!Array.isArray(pair) || pair.length < 2) return;
  const longitude = Number(pair[0]);
  const latitude = Number(pair[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  if (latitude < 32 || latitude > 39.8) return;
  if (longitude < 124 || longitude > 132) return;
  into.push({ latitude, longitude });
}

function minutes(seconds: unknown): number {
  const value = Number(seconds);
  return Number.isFinite(value) ? Math.max(1, Math.ceil(value / 60)) : 1;
}

async function kakaoGet(
  url: string,
  params: Record<string, string>,
  restKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  const response = await fetch(target, {
    headers: {
      Authorization: `KakaoAK ${restKey}`,
      Accept: "application/json",
    },
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`KAKAO_HTTP_${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/* 카카오는 실패를 HTTP 200 본문의 `status`로 알린다. `OK`가 아니면 경로가 없는
   것이므로, 후보를 통과시키지 않도록 예외로 올린다. */
function requireOkStatus(payload: Record<string, unknown>): void {
  const status = String(payload.status ?? "");
  if (status !== "OK") throw new Error(`KAKAO_STATUS_${status || "UNKNOWN"}`);
}

type WalkOrBicyclePayload = {
  status?: string;
  route?: {
    properties?: { totalDistance?: number; totalTime?: number };
    legs?: Array<{
      properties?: { distance?: number; time?: number };
      steps?: Array<{ path?: { points?: unknown } }>;
    }>;
  };
};

export async function getKakaoBicycleRoute(
  points: Array<{ latitude: number; longitude: number }>,
  options: { signal?: AbortSignal } = {},
): Promise<KakaoRoute | undefined> {
  const restKey = getRuntimeSecret("KAKAO_REST_API_KEY");
  if (!restKey) return undefined;
  if (points.length < 2) return undefined;
  const waypoints = points.slice(1, -1);
  if (waypoints.length > MAX_BICYCLE_WAYPOINTS) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const start = points[0];
    const end = points[points.length - 1];
    const params: Record<string, string> = {
      start_x: String(start.longitude),
      start_y: String(start.latitude),
      end_x: String(end.longitude),
      end_y: String(end.latitude),
      input_coord: "WGS84",
      output_coord: "WGS84",
      route_mode: "BIKE_ONLY",
    };
    if (waypoints.length) {
      params.via_x = waypoints.map((point) => point.longitude).join(",");
      params.via_y = waypoints.map((point) => point.latitude).join(",");
    }
    const payload = (await kakaoGet(
      KAKAO_BICYCLE_ROUTE_URL,
      params,
      restKey,
      signal,
    )) as WalkOrBicyclePayload;
    requireOkStatus(payload as Record<string, unknown>);
    const route = payload.route;
    const legs = route?.legs ?? [];
    if (!route || !legs.length) throw new Error("KAKAO_EMPTY");

    const geometry: Array<{ latitude: number; longitude: number }> = [];
    for (const leg of legs) {
      for (const step of leg.steps ?? []) {
        const points_ = step.path?.points;
        if (Array.isArray(points_)) {
          for (const pair of points_) pushPoint(geometry, pair);
        }
      }
    }
    if (!geometry.length) throw new Error("KAKAO_EMPTY");

    /* 경유지를 보냈으면 leg 수가 구간 수와 같아야 한다. 다르면 어느 구간이
       어느 것인지 알 수 없고, 경유지 도착 검증이 무의미해진다. */
    const expectedLegs = points.length - 1;
    if (waypoints.length && legs.length !== expectedLegs) {
      throw new Error("KAKAO_LEG_MISMATCH");
    }

    return {
      distanceMeters: Math.round(
        Number(route.properties?.totalDistance ?? 0),
      ),
      durationMinutes: minutes(route.properties?.totalTime),
      legs: legs.map((leg) => ({
        distanceMeters: Math.round(Number(leg.properties?.distance ?? 0)),
        durationMinutes: minutes(leg.properties?.time),
      })),
      geometry,
      scheduleDependent: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

type TransitPayload = {
  status?: string;
  routes?: Array<{
    properties?: {
      type?: string;
      totalDistance?: number;
      totalTime?: number;
      transfers?: number;
      fare?: { value?: number };
    };
    steps?: Array<{
      properties?: { type?: string; time?: number; guidance?: string };
      path?: { points?: unknown };
    }>;
  }>;
};

async function fetchTransitSegment(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  restKey: string,
  signal: AbortSignal,
) {
  const payload = (await kakaoGet(
    KAKAO_TRANSIT_ROUTE_URL,
    {
      start_x: String(from.longitude),
      start_y: String(from.latitude),
      end_x: String(to.longitude),
      end_y: String(to.latitude),
      input_coord: "WGS84",
      output_coord: "WGS84",
    },
    restKey,
    signal,
  )) as TransitPayload;
  requireOkStatus(payload as Record<string, unknown>);
  /* 카카오는 여러 경로를 소요시간 순이 아니라 유형별로 돌려준다. 도착 시각이
     판정 근거이므로 가장 빠른 경로를 고른다. */
  const fastest = [...(payload.routes ?? [])].sort(
    (a, b) =>
      Number(a.properties?.totalTime ?? Number.POSITIVE_INFINITY) -
      Number(b.properties?.totalTime ?? Number.POSITIVE_INFINITY),
  )[0];
  if (!fastest) throw new Error("KAKAO_EMPTY");
  const geometry: Array<{ latitude: number; longitude: number }> = [];
  const steps: NonNullable<KakaoRoute["transitSteps"]> = [];
  for (const step of fastest.steps ?? []) {
    const points_ = step.path?.points;
    if (Array.isArray(points_)) {
      for (const pair of points_) pushPoint(geometry, pair);
    }
    const type = String(step.properties?.type ?? "");
    if (type === "BUS" || type === "SUBWAY" || type === "WALKING") {
      steps.push({
        type,
        durationMinutes: minutes(step.properties?.time),
        guidance: step.properties?.guidance
          ? String(step.properties.guidance)
          : undefined,
      });
    }
  }
  if (!geometry.length) throw new Error("KAKAO_EMPTY");
  return {
    distanceMeters: Math.round(
      Number(fastest.properties?.totalDistance ?? 0),
    ),
    durationSeconds: Number(fastest.properties?.totalTime ?? 0),
    fareKrw: Number.isFinite(fastest.properties?.fare?.value)
      ? Number(fastest.properties?.fare?.value)
      : undefined,
    transfers: Number.isFinite(fastest.properties?.transfers)
      ? Number(fastest.properties?.transfers)
      : undefined,
    steps,
    geometry,
  };
}

export async function getKakaoTransitRoute(
  points: Array<{ latitude: number; longitude: number }>,
  options: { signal?: AbortSignal } = {},
): Promise<KakaoRoute | undefined> {
  const restKey = getRuntimeSecret("KAKAO_REST_API_KEY");
  if (!restKey) return undefined;
  if (points.length < 2) return undefined;
  if (points.length - 1 > MAX_SEGMENTS) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    /* 대중교통은 경유지 파라미터가 없으므로 구간별로 병렬 호출한다. */
    const segments = await Promise.all(
      points
        .slice(0, -1)
        .map((from, index) =>
          fetchTransitSegment(from, points[index + 1], restKey, signal),
        ),
    );

    const geometry: Array<{ latitude: number; longitude: number }> = [];
    for (const segment of segments) {
      for (const point of segment.geometry) {
        const previous = geometry[geometry.length - 1];
        if (
          previous &&
          previous.latitude === point.latitude &&
          previous.longitude === point.longitude
        ) {
          continue;
        }
        geometry.push(point);
      }
    }

    /* 요금은 모든 구간에서 확인된 경우에만 합계를 낸다. 일부만 있으면 전체
       요금인 척할 수 없다. 환승 횟수도 구간별 합으로만 의미가 있다. */
    const allFares = segments.every((segment) => segment.fareKrw !== undefined);
    return {
      distanceMeters: segments.reduce(
        (sum, segment) => sum + segment.distanceMeters,
        0,
      ),
      durationMinutes: Math.max(
        1,
        Math.ceil(
          segments.reduce(
            (sum, segment) => sum + segment.durationSeconds,
            0,
          ) / 60,
        ),
      ),
      legs: segments.map((segment) => ({
        distanceMeters: segment.distanceMeters,
        durationMinutes: minutes(segment.durationSeconds),
      })),
      geometry,
      fareKrw: allFares
        ? segments.reduce((sum, segment) => sum + (segment.fareKrw ?? 0), 0)
        : undefined,
      transfers: segments.every((segment) => segment.transfers !== undefined)
        ? segments.reduce((sum, segment) => sum + (segment.transfers ?? 0), 0)
        : undefined,
      transitSteps: segments.flatMap((segment) => segment.steps),
      /* 대중교통 소요시간은 배차 간격에 따라 달라진다. 도보·자차와 같은 확정
         값처럼 제시하면 도착 시각을 보증하는 셈이 된다. */
      scheduleDependent: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}
