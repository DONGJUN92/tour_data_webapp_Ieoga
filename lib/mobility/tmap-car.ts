import {
  TMAP_CAR_PREDICTION_URL,
  TMAP_CAR_URL,
} from "@/lib/external-providers";
import { getRuntimeSecret } from "@/lib/runtime-env";

/**
 * TMAP 자동차 경로안내.
 *
 * 보행 어댑터와 같은 키(`TMAP_APP_KEY`)로 동작하며 별도 발급이 필요하지 않다.
 * 2026-08-04 실호출로 확인: 시청→광화문 4,759m / 1,213초 / 예상 택시요금 8,420원.
 *
 * 경유지를 `passList`로 한 번에 보내는 방식은 쓰지 않는다. 실측에서 응답이
 * 경유지 지점을 `PP*`로 표시하지 않고 `B1`로 섞어 보내, 구간 경계를 응답만 보고
 * 신뢰성 있게 되짚을 수 없었다. 이어가는 경유지마다 도착을 검증하므로 구간이
 * 흐려지면 후보가 통째로 탈락한다. 그래서 보행 어댑터와 동일하게 구간을 나눠
 * 병렬 호출하고 구간별 결과를 그대로 돌려준다.
 */

export type TmapCarRoute = {
  distanceMeters: number;
  durationMinutes: number;
  legs: Array<{ distanceMeters: number; durationMinutes: number }>;
  geometry: Array<{ latitude: number; longitude: number }>;
  /* 응답이 주는 예상 요금. 자차와 택시의 비용 감각이 다르므로 화면에서 참고값으로
     쓸 수 있게 그대로 전달한다. 요금을 계산해 만들어내지는 않는다. */
  taxiFareKrw?: number;
  tollFareKrw?: number;
};

type TmapFeature = {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: {
    totalDistance?: number;
    totalTime?: number;
    taxiFare?: number;
    tollFare?: number;
  };
};

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

const MAX_SEGMENTS = 8;

/* TMAP 예측 경로는 `predictionTime`을 `yyyy-MM-ddTHH:mm:ss+0900`으로만 받는다.
   `Date.prototype.toISOString()`이 주는 `2026-08-14T03:24:54.667Z`를 보내면 좌표가
   멀쩡해도 `code 1100 요청 데이터 오류`로 400이 돌아온다. 예전 구현이 그 값을
   그대로 보냈고, 엔진은 자차 조회에 항상 출발시각을 넘기므로 **자차 경로가 한 번도
   성공한 적이 없었다** — 모든 후보가 ROUTE_UNAVAILABLE로 떨어져 자차·택시를 고르면
   결과가 늘 0건이었다. 2026-08-14 실호출로 두 형식의 차이를 확인했다. */
function tmapPredictionTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+0900`;
}

type Segment = {
  distanceMeters: number;
  durationSeconds: number;
  taxiFareKrw?: number;
  tollFareKrw?: number;
  geometry: Array<{ latitude: number; longitude: number }>;
};

function positiveOrUndefined(value: unknown): number | undefined {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : undefined;
}

async function fetchSegment(
  appKey: string,
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  signal: AbortSignal,
  departureAt?: string,
): Promise<Segment> {
  const target = departureAt ? TMAP_CAR_PREDICTION_URL : TMAP_CAR_URL;
  const response = await fetch(`${target}?version=1`, {
    method: "POST",
    headers: {
      appKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(departureAt ? {
      routesInfo: {
        departure: {
          name: "origin",
          lon: from.longitude,
          lat: from.latitude,
          depSearchFlag: "03",
        },
        destination: {
          name: "destination",
          lon: to.longitude,
          lat: to.latitude,
          destSearchFlag: "03",
        },
        /* TMAP's prediction enum is counter-intuitive: `arrival` means the
           supplied predictionTime is the departure time. 2026-08-14 실측으로
           확인 — `arrival`로 12:24를 보내면 응답의 `departure`가 12:24이고,
           `departure`로 보내면 응답의 `arrival`이 12:24다. */
        predictionType: "arrival",
        predictionTime: tmapPredictionTime(departureAt),
        searchOption: "00",
        trafficInfo: "Y",
        tollgateCarType: "car",
      },
    } : {
      startX: from.longitude,
      startY: from.latitude,
      endX: to.longitude,
      endY: to.latitude,
      reqCoordType: "WGS84GEO",
      resCoordType: "WGS84GEO",
      /* 0은 교통최적 추천이다. 도착 시각이 판정 근거이므로 최단거리보다
         실제 소요시간이 짧은 경로를 쓴다. */
      searchOption: "0",
      trafficInfo: "Y",
    }),
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`TMAP_CAR_HTTP_${response.status}`);
  const payload = (await response.json()) as {
    features?: TmapFeature[];
    error?: unknown;
  };
  if (payload.error) throw new Error("TMAP_CAR_ERROR");

  let distanceMeters: number | undefined;
  let durationSeconds: number | undefined;
  let taxiFareKrw: number | undefined;
  let tollFareKrw: number | undefined;
  const geometry: Array<{ latitude: number; longitude: number }> = [];
  for (const feature of payload.features ?? []) {
    const total = feature.properties?.totalDistance;
    const time = feature.properties?.totalTime;
    if (distanceMeters === undefined && Number.isFinite(total)) {
      distanceMeters = Number(total);
    }
    if (durationSeconds === undefined && Number.isFinite(time)) {
      durationSeconds = Number(time);
    }
    taxiFareKrw ??= positiveOrUndefined(feature.properties?.taxiFare);
    tollFareKrw ??= positiveOrUndefined(feature.properties?.tollFare);
    const type = feature.geometry?.type;
    const coordinates = feature.geometry?.coordinates;
    if (type === "LineString" && Array.isArray(coordinates)) {
      for (const pair of coordinates) pushPoint(geometry, pair);
    } else if (type === "Point") {
      pushPoint(geometry, coordinates);
    }
  }
  if (
    !Number.isFinite(distanceMeters) ||
    !Number.isFinite(durationSeconds) ||
    !geometry.length
  ) {
    throw new Error("TMAP_CAR_EMPTY");
  }
  return {
    distanceMeters: distanceMeters as number,
    durationSeconds: durationSeconds as number,
    taxiFareKrw,
    tollFareKrw,
    geometry,
  };
}

export async function getTmapCarRoute(
  points: Array<{ latitude: number; longitude: number }>,
  options: { signal?: AbortSignal; departureAt?: string } = {},
): Promise<TmapCarRoute | undefined> {
  const appKey = getRuntimeSecret("TMAP_APP_KEY");
  if (!appKey) return undefined;
  if (points.length < 2) return undefined;
  if (points.length - 1 > MAX_SEGMENTS) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const segments: Segment[] = [];
    let segmentDepartureAt = options.departureAt;
    /* Each later segment begins after the previous one. Reusing one timestamp
       for every prediction leg would understate schedule-dependent traffic. */
    for (const [index, from] of points.slice(0, -1).entries()) {
      const segment = await fetchSegment(
        appKey,
        from,
        points[index + 1],
        signal,
        segmentDepartureAt,
      );
      segments.push(segment);
      if (segmentDepartureAt) {
        segmentDepartureAt = new Date(
          Date.parse(segmentDepartureAt) + segment.durationSeconds * 1_000,
        ).toISOString();
      }
    }

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

    const sumFare = (
      pick: (segment: Segment) => number | undefined,
    ): number | undefined => {
      /* 구간마다 요금이 오는 경우에만 합계를 낸다. 일부 구간에만 값이 있으면
         전체 요금인 척할 수 없으므로 표기하지 않는다. */
      const values = segments.map(pick);
      return values.every((value) => value !== undefined)
        ? values.reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0)
        : undefined;
    };

    return {
      distanceMeters: Math.round(
        segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
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
        distanceMeters: Math.round(segment.distanceMeters),
        durationMinutes: Math.max(1, Math.ceil(segment.durationSeconds / 60)),
      })),
      geometry,
      taxiFareKrw: sumFare((segment) => segment.taxiFareKrw),
      tollFareKrw: sumFare((segment) => segment.tollFareKrw),
    };
  } finally {
    clearTimeout(timeout);
  }
}
