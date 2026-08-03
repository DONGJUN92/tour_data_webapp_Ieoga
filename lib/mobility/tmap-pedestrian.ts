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
  geometry: Array<{ latitude: number; longitude: number }>;
};

export function tmapPedestrianConfigured(): boolean {
  return Boolean(getRuntimeSecret("TMAP_APP_KEY"));
}

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

/**
 * 보행자 경로를 조회한다.
 *
 * TMAP은 경유지를 최대 5개까지 별도 파라미터로 받는다. 이어가는
 * `현재 → 대안 → 다음 예약`처럼 3~4개 지점을 쓰므로 그 범위에서 처리하고,
 * 그보다 많으면 호출하지 않고 undefined를 돌려 상위에서 OSRM을 쓰게 한다.
 */
export async function getTmapPedestrianRoute(
  points: Array<{ latitude: number; longitude: number }>,
  options: { signal?: AbortSignal } = {},
): Promise<TmapRoute | undefined> {
  const appKey = getRuntimeSecret("TMAP_APP_KEY");
  if (!appKey) return undefined;
  if (points.length < 2 || points.length > 7) return undefined;

  const start = points[0];
  const end = points[points.length - 1];
  const via = points.slice(1, -1);

  const body: Record<string, unknown> = {
    startX: start.longitude,
    startY: start.latitude,
    endX: end.longitude,
    endY: end.latitude,
    reqCoordType: "WGS84GEO",
    resCoordType: "WGS84GEO",
    startName: "출발",
    endName: "도착",
    searchOption: "0",
  };
  if (via.length) {
    body.passList = via
      .map((point) => `${point.longitude},${point.latitude}`)
      .join("_");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_500);
  try {
    const response = await fetch(
      "https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1",
      {
        method: "POST",
        headers: {
          appKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new Error(`TMAP_HTTP_${response.status}`);
    }
    const payload = (await response.json()) as {
      features?: TmapFeature[];
      error?: unknown;
    };
    if (payload.error) throw new Error("TMAP_ERROR");

    const features = payload.features ?? [];
    /* 총거리·총시간은 첫 Point feature의 properties에 담겨 온다. */
    let distanceMeters: number | undefined;
    let durationSeconds: number | undefined;
    const geometry: Array<{ latitude: number; longitude: number }> = [];

    for (const feature of features) {
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
      distanceMeters: Math.round(distanceMeters as number),
      durationMinutes: Math.max(
        1,
        Math.ceil((durationSeconds as number) / 60),
      ),
      geometry,
    };
  } finally {
    clearTimeout(timeout);
  }
}
