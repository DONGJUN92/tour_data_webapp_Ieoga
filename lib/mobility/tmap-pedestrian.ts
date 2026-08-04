import { TMAP_PEDESTRIAN_URL } from "@/lib/external-providers";
import { getRuntimeSecret } from "@/lib/runtime-env";

/**
 * TMAP 보행자 경로안내.
 *
 * OSRM 공용 서버는 한국의 지하상가·역사 내부 연결과 횡단보도를 제대로 반영하지
 * 못해 도착 시각이 실제보다 낙관적으로 나오는 구간이 있다. 이어가는 그 도착
 * 시각으로 "다음 예약을 지킬 수 있다"를 판정하므로, 경로 품질이 곧 판정 품질이다.
 *
 * TMAP은 국내 보행 경로 품질이 가장 좋고 서버 호출을 허용한다. 키가 설정되어
 * 있으면 먼저 쓰고, 실패하면 기존 OSRM 경로로 내려간다. 어느 쪽을 썼는지는
 * 화면 출처 표기에 그대로 드러난다.
 */

export type TmapRoute = {
  distanceMeters: number;
  durationMinutes: number;
  legs: Array<{ distanceMeters: number; durationMinutes: number }>;
  geometry: Array<{ latitude: number; longitude: number }>;
};

type TmapFeature = {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: {
    totalDistance?: number;
    totalTime?: number;
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
  /* 한반도 범위를 벗어난 좌표는 좌표계 혼동의 신호이므로 버린다. */
  if (latitude < 32 || latitude > 39.8) return;
  if (longitude < 124 || longitude > 132) return;
  into.push({ latitude, longitude });
}

/* 한 번의 호출이 감당하는 구간 수. 이어가의 복구 경로는 보통
   `현재 → 대안 → 다음 예약`이라 2구간이고, 사이의 원래 일정이 많아도 이
   범위를 넘지 않는다. 넘으면 호출하지 않고 상위에서 다른 공급자를 쓰게 한다. */
const MAX_SEGMENTS = 8;

type Segment = { distanceMeters: number; durationSeconds: number; geometry: Array<{ latitude: number; longitude: number }> };

async function fetchSegment(
  appKey: string,
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  signal: AbortSignal,
): Promise<Segment> {
  const response = await fetch(`${TMAP_PEDESTRIAN_URL}?version=1`, {
    method: "POST",
    headers: {
      appKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      startX: from.longitude,
      startY: from.latitude,
      endX: to.longitude,
      endY: to.latitude,
      reqCoordType: "WGS84GEO",
      resCoordType: "WGS84GEO",
      startName: "출발",
      endName: "도착",
      searchOption: "0",
    }),
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`TMAP_HTTP_${response.status}`);
  const payload = (await response.json()) as {
    features?: TmapFeature[];
    error?: unknown;
  };
  if (payload.error) throw new Error("TMAP_ERROR");

  let distanceMeters: number | undefined;
  let durationSeconds: number | undefined;
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
    throw new Error("TMAP_EMPTY");
  }
  return {
    distanceMeters: distanceMeters as number,
    durationSeconds: durationSeconds as number,
    geometry,
  };
}

/**
 * 보행자 경로를 구간별로 조회한다.
 *
 * 경유지는 `passList`로 한 번에 보낼 수도 있지만, 그렇게 하면 응답이 전체
 * 합계만 주고 구간별 거리·시간을 주지 않는다. 이어가는 경유지마다 도착을
 * 검증해 "한 경유지라도 보존을 확인하지 못한 후보는 제외"하므로, 구간이
 * 없으면 그 후보는 통째로 탈락한다. 실제로 그렇게 동작했다. 배포본 실측에서
 * 라우팅까지 도달한 후보가 매번 전부 `ROUTE_UNAVAILABLE`로 떨어져 대안이
 * 하나도 제시되지 않았다.
 *
 * 그래서 구간을 나눠 병렬로 호출하고 구간별 결과를 그대로 돌려준다. 지점이
 * 셋이면 두 번 호출하며, 병렬이라 지연은 한 번과 비슷하다.
 */
export async function getTmapPedestrianRoute(
  points: Array<{ latitude: number; longitude: number }>,
  options: { signal?: AbortSignal } = {},
): Promise<TmapRoute | undefined> {
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
    const segments = await Promise.all(
      points.slice(0, -1).map((from, index) =>
        fetchSegment(appKey, from, points[index + 1], signal),
      ),
    );

    /* TMAP은 안내점을 Point로, 같은 좌표를 LineString에도 담아 보내고 구간
       경계에서도 같은 좌표가 반복된다. 연속 중복을 한 번만 남겨 경로선이
       제자리를 오가는 것처럼 보이지 않게 한다. */
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

    return {
      distanceMeters: Math.round(
        segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
      ),
      durationMinutes: Math.max(
        1,
        Math.ceil(
          segments.reduce((sum, segment) => sum + segment.durationSeconds, 0) /
            60,
        ),
      ),
      legs: segments.map((segment) => ({
        distanceMeters: Math.round(segment.distanceMeters),
        durationMinutes: Math.max(1, Math.ceil(segment.durationSeconds / 60)),
      })),
      geometry,
    };
  } finally {
    clearTimeout(timeout);
  }
}
