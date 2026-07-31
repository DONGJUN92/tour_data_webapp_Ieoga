import {
  routingEndpoints,
  routingProviderConfig,
} from "@/lib/external-providers";

export type RoutePoint = {
  latitude: number;
  longitude: number;
};

export type RouteLeg = {
  distanceMeters: number;
  durationMinutes: number;
};

export type WalkingRouteEvidence =
  | {
      status: "routed";
      provider: "openstreetmap_osrm";
      distanceMeters: number;
      durationMinutes: number;
      legs: RouteLeg[];
      geometry: Array<{ latitude: number; longitude: number }>;
      calculatedAt: string;
      attribution: string;
    }
  | {
      status: "unavailable";
      provider: "openstreetmap_osrm";
      reason: string;
      calculatedAt: string;
      attribution: string;
    };

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<
  string,
  { expiresAt: number; value: WalkingRouteEvidence }
>();
let nextPublicRequestAt = 0;

function routeKey(points: RoutePoint[]) {
  return points
    .map((point) => `${point.longitude.toFixed(5)},${point.latitude.toFixed(5)}`)
    .join(";");
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
  options: { signal?: AbortSignal } = {},
): Promise<WalkingRouteEvidence> {
  const calculatedAt = new Date().toISOString();
  const attribution = "© OpenStreetMap contributors";
  if (points.length < 2 || points.length > 32) {
    return {
      status: "unavailable",
      provider: "openstreetmap_osrm",
      reason: "경로 계산에는 2~32개 지점이 필요합니다.",
      calculatedAt,
      attribution,
    };
  }

  const key = routeKey(points);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

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
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${key}`;
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
          "User-Agent": "IEOGA/1.0 (+https://ieoga.kr)",
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
