import { getDb } from "@/db";
import { routeSnapshots } from "@/db/schema";
import { inArray, lt } from "drizzle-orm";
import type { WalkingRouteEvidence } from "./routing";

/**
 * 실제 경로 조회 결과의 로컬 사본.
 *
 * `lib/mobility/routing.ts`에도 캐시가 있지만 그것은 격리 로컬 `Map`이고 TTL이
 * 5분이며 키가 좌표 완전 일치다. GPS가 1m만 흔들려도 못 쓰고, 다른 격리로
 * 들어온 요청과도 공유되지 않는다. 이 표는 그 위에 얹는 내구 계층이다.
 *
 * **도보와 자전거만 저장한다.** 그 근거는 우리가 새로 만든 것이 아니라 이미
 * `routing.ts`가 내려 둔 판단이다 — 그 캐시 키가 두 수단에 대해
 * `${mode}:static:`인 것은 "이 결과는 시각과 무관하다"는 뜻이다. 반대로 자동차와
 * 대중교통은 교통 상황과 시간표에 달려 있어 같은 좌표쌍이라도 시각에 따라 값이
 * 달라지므로, 그 두 수단은 저장하지 않고 매번 조회한다. 호출을 아끼려고 "다녀올
 * 수 있다"는 판정을 흔들 수는 없다.
 *
 * 출발지는 약 150m 격자로 양자화해 키에 넣는다. 그 정도 거리에서 같은 목적지까지의
 * 보행 시간 차이는 경로 제공자가 표시하는 단위(분)보다 작다. 목적지는 공사
 * 콘텐츠의 좌표라 흔들리지 않으므로 그대로 쓴다.
 *
 * 저장한 근거에는 원래의 `calculatedAt`이 그대로 남아 화면의 출처 표기까지
 * 전달된다. 여행자는 이 숫자가 언제 측정된 것인지 볼 수 있다.
 */

/* 위도 0.00135° ≈ 150m. 경도는 위도에 따라 실제 거리가 달라지지만, 한반도
   범위(북위 33~39도)에서 0.00170°는 약 145~160m로 같은 자리에 있다. */
const ORIGIN_CELL_LATITUDE_STEP = 0.00135;
const ORIGIN_CELL_LONGITUDE_STEP = 0.0017;

/* 도보·자전거는 시각과 무관하므로 길게 잡는다. 상한을 두는 이유는 경로망 자체가
   바뀌기 때문이다 — 길이 새로 나거나 막히면 값이 달라진다. */
const STATIC_ROUTE_TTL_DAYS = 7;

export type RouteSnapshotMode = "walk" | "bicycle";

export function isCacheableRouteMode(
  mode: string,
): mode is RouteSnapshotMode {
  return mode === "walk" || mode === "bicycle";
}

function cell(value: number, step: number): number {
  return Math.round(value / step);
}

/**
 * 사본 키. 출발지만 격자로 양자화하고 나머지 지점은 그대로 쓴다.
 *
 * 경유지가 있으면(다음 장소가 마감으로 들어온 경우) 그 좌표까지 키에 들어간다 —
 * 같은 후보라도 그 뒤에 어디를 가느냐에 따라 조회한 경로가 다르기 때문이다.
 */
export function routeSnapshotKey(
  points: Array<{ latitude: number; longitude: number }>,
  mode: RouteSnapshotMode,
): { id: string; originCell: string; destinationKey: string } | undefined {
  if (points.length < 2) return undefined;
  const [origin, ...rest] = points;
  const originCell = `${cell(origin.latitude, ORIGIN_CELL_LATITUDE_STEP)},${cell(
    origin.longitude,
    ORIGIN_CELL_LONGITUDE_STEP,
  )}`;
  const destinationKey = rest
    .map(
      (point) =>
        `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`,
    )
    .join(">");
  return {
    id: `${mode}:${originCell}:${destinationKey}`,
    originCell,
    destinationKey,
  };
}

function available(): boolean {
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

/**
 * 여러 후보의 경로 사본을 **한 번의 질의로** 읽는다.
 *
 * 후보마다 따로 읽으면 D1 왕복이 응답 시간에 그대로 쌓인다. 내부 예산은 넉넉해도
 * 무료 플랜의 CPU 상한(10ms)이 있으므로 왕복 수를 줄이는 것이 맞다.
 */
export async function readRouteSnapshots(
  ids: string[],
): Promise<Map<string, WalkingRouteEvidence>> {
  const hits = new Map<string, WalkingRouteEvidence>();
  const unique = [...new Set(ids)];
  if (!unique.length || !available()) return hits;
  const nowIso = new Date().toISOString();
  try {
    const rows = await getDb()
      .select({
        id: routeSnapshots.id,
        payload: routeSnapshots.payload,
        expiresAt: routeSnapshots.expiresAt,
      })
      .from(routeSnapshots)
      .where(inArray(routeSnapshots.id, unique));
    for (const row of rows) {
      if (row.expiresAt <= nowIso) continue;
      try {
        const value = JSON.parse(row.payload) as WalkingRouteEvidence;
        /* 실패한 조회는 저장하지 않지만, 저장된 값이 어떤 이유로든 `routed`가
           아니면 쓰지 않는다. 확인하지 못한 것을 확인한 것으로 만들 수 없다. */
        if (value?.status === "routed") hits.set(row.id, value);
      } catch {
        continue;
      }
    }
  } catch {
    /* 사본을 읽지 못하면 실시간 조회로 돌아간다. */
    return new Map();
  }
  return hits;
}

export type RouteSnapshotWrite = {
  id: string;
  originCell: string;
  destinationKey: string;
  mode: RouteSnapshotMode;
  value: Extract<WalkingRouteEvidence, { status: "routed" }>;
};

export async function writeRouteSnapshots(
  writes: RouteSnapshotWrite[],
): Promise<number> {
  if (!writes.length || !available()) return 0;
  const expiresAt = new Date(
    Date.now() + STATIC_ROUTE_TTL_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  /* 같은 키가 한 요청 안에 두 번 들어오면 마지막 것만 남긴다 — SQLite는 한
     문장에서 같은 기본키를 두 번 upsert하면 오류를 낸다. */
  const byId = new Map(writes.map((write) => [write.id, write]));
  try {
    await getDb()
      .insert(routeSnapshots)
      .values(
        [...byId.values()].map((write) => ({
          id: write.id,
          mode: write.mode,
          originCell: write.originCell,
          destinationKey: write.destinationKey,
          payload: JSON.stringify(write.value),
          calculatedAt: write.value.calculatedAt,
          expiresAt,
        })),
      )
      .onConflictDoNothing({ target: routeSnapshots.id });
    return byId.size;
  } catch {
    return 0;
  }
}

/** 만료된 사본 정리. 시간당 크론에서 부른다. */
export async function purgeExpiredRouteSnapshots(): Promise<number> {
  if (!available()) return 0;
  try {
    const result = await getDb()
      .delete(routeSnapshots)
      .where(lt(routeSnapshots.expiresAt, new Date().toISOString()));
    return (result as unknown as { meta?: { changes?: number } }).meta
      ?.changes ?? 0;
  } catch {
    return 0;
  }
}
