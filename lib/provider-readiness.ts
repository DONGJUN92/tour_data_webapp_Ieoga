import { getDb } from "@/db";
import { providerProbeSnapshots } from "@/db/schema";
import {
  forwardGeocodeProviderConfig,
  PUBLIC_NOMINATIM_REVERSE_URL,
  PUBLIC_NOMINATIM_SEARCH_URL,
  PUBLIC_OPEN_METEO_URL,
  PUBLIC_OSRM_WALKING_URL,
  reverseGeocodeProviderConfig,
  routingEndpoints,
  routingProviderConfig,
  weatherProviderConfig,
  type ProviderMode,
} from "@/lib/external-providers";

export const PROVIDER_PROBE_REFRESH_INTERVAL_MS = 3 * 3_600_000;
export const PROVIDER_PROBE_STALE_AFTER_MS = 6 * 3_600_000;
export const PROVIDER_PROBE_TIMEOUT_MS = 4_000;

export const PROVIDER_NAMES = [
  "reverseGeocoding",
  "forwardGeocoding",
  "walkingRouting",
  "weather",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type ProviderProbeStatus = "success" | "error" | "blocked";

export type ProviderConfiguration = {
  provider: ProviderName;
  mode: ProviderMode;
  endpoints: string[];
};

export type ProviderProbeSnapshot = {
  provider: ProviderName;
  mode: ProviderMode;
  configurationFingerprint: string;
  endpointCount: number;
  status: ProviderProbeStatus;
  latencyMs: number;
  checkedAt: string;
  errorCode?: string;
};

export type ProviderReadinessItem = {
  provider: ProviderName;
  mode: ProviderMode;
  ready: boolean;
  status: ProviderProbeStatus | "missing" | "stale" | "configuration_changed";
  latencyMs?: number;
  checkedAt?: string;
  stale: boolean;
  errorCode?: string;
};

export type ProviderReadinessReport = {
  allReady: boolean;
  staleAfterMs: number;
  providers: Record<ProviderName, ProviderReadinessItem>;
};

export function describeProviderCapabilities(params: {
  providers: Record<ProviderName, ProviderMode>;
  kakaoConfigured: boolean;
  kmaConfigured: boolean;
}): {
  routeMethod: string;
  weatherMethod: string;
  reverseMethod: string;
  currentOriginFallback: string;
  savedStopFallback: string;
} {
  const reverseFallback =
    params.providers.reverseGeocoding === "managed"
      ? "configured_reverse"
      : "shared_public_nominatim";
  const forwardFallback =
    params.providers.forwardGeocoding === "managed"
      ? "configured_forward"
      : "shared_public_nominatim";
  const weatherFallback =
    params.providers.weather === "managed"
      ? "configured_weather"
      : "shared_public_open_meteo";
  return {
    routeMethod:
      params.providers.walkingRouting === "managed"
        ? "configured_osrm_compatible"
        : "shared_public_osrm_compatible",
    weatherMethod: params.kmaConfigured
      ? `kma_when_configured_then_${weatherFallback}`
      : weatherFallback,
    reverseMethod: params.kakaoConfigured
      ? `kakao_when_configured_then_${reverseFallback}_then_kto_nearest`
      : `${reverseFallback}_then_kto_nearest`,
    currentOriginFallback: params.kakaoConfigured
      ? `kakao_when_configured_then_${forwardFallback}`
      : forwardFallback,
    savedStopFallback: forwardFallback,
  };
}

type FetchLike = typeof fetch;

const TEST_LATITUDE = 37.5796;
const TEST_LONGITUDE = 126.977;
const ROUTE_DESTINATION_LATITUDE = 37.5759;
const ROUTE_DESTINATION_LONGITUDE = 126.9768;
const TEST_QUERY = "경복궁";
const MAX_ROUTING_ENDPOINTS = 4;

function canonicalOrigin(value: string | URL): string {
  const url = value instanceof URL ? value : new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  const port =
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
      ? ""
      : url.port;
  return `${url.protocol}//${hostname}${port ? `:${port}` : ""}`;
}

const SHARED_PUBLIC_ORIGINS = new Set(
  [
    PUBLIC_NOMINATIM_REVERSE_URL,
    PUBLIC_NOMINATIM_SEARCH_URL,
    PUBLIC_OSRM_WALKING_URL,
    PUBLIC_OPEN_METEO_URL,
  ].map(canonicalOrigin),
);

function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

export function currentProviderConfigurations(): ProviderConfiguration[] {
  const reverse = reverseGeocodeProviderConfig();
  const forward = forwardGeocodeProviderConfig();
  const routing = routingProviderConfig();
  const weather = weatherProviderConfig();
  return [
    {
      provider: "reverseGeocoding",
      mode: reverse.mode,
      endpoints: [reverse.url],
    },
    {
      provider: "forwardGeocoding",
      mode: forward.mode,
      endpoints: [forward.url],
    },
    {
      provider: "walkingRouting",
      mode: routing.mode,
      endpoints: routingEndpoints(),
    },
    {
      provider: "weather",
      mode: weather.mode,
      endpoints: [weather.url],
    },
  ];
}

export async function providerConfigurationFingerprint(
  configuration: ProviderConfiguration,
): Promise<string> {
  let endpoints: string[];
  try {
    endpoints = configuration.endpoints.map(normalizedEndpoint);
  } catch {
    endpoints = configuration.endpoints.map((endpoint) => endpoint.trim());
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      provider: configuration.provider,
      mode: configuration.mode,
      endpoints,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function finiteCoordinate(value: unknown, min: number, max: number): boolean {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function validReverseContract(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const row = payload as {
    display_name?: unknown;
    address?: unknown;
    lat?: unknown;
    lon?: unknown;
  };
  const address = row.address;
  const hasAddress =
    address !== null &&
    typeof address === "object" &&
    !Array.isArray(address) &&
    Object.values(address).some(nonEmptyString);
  const coordinatesValid =
    (row.lat === undefined && row.lon === undefined) ||
    (finiteCoordinate(row.lat, 32, 39.8) &&
      finiteCoordinate(row.lon, 124, 132));
  return (nonEmptyString(row.display_name) || hasAddress) && coordinatesValid;
}

function validForwardContract(payload: unknown): boolean {
  if (!Array.isArray(payload) || payload.length === 0) return false;
  return payload.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const row = entry as {
      display_name?: unknown;
      name?: unknown;
      lat?: unknown;
      lon?: unknown;
    };
    return (
      (nonEmptyString(row.display_name) || nonEmptyString(row.name)) &&
      finiteCoordinate(row.lat, 32, 39.8) &&
      finiteCoordinate(row.lon, 124, 132)
    );
  });
}

function validRoutingContract(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const row = payload as {
    code?: unknown;
    routes?: Array<{
      distance?: unknown;
      duration?: unknown;
      geometry?: { coordinates?: unknown };
    }>;
  };
  const route = Array.isArray(row.routes) ? row.routes[0] : undefined;
  const coordinates = route?.geometry?.coordinates;
  return (
    row.code === "Ok" &&
    typeof route?.distance === "number" &&
    Number.isFinite(route.distance) &&
    route.distance > 0 &&
    typeof route.duration === "number" &&
    Number.isFinite(route.duration) &&
    route.duration > 0 &&
    Array.isArray(coordinates) &&
    coordinates.length >= 2 &&
    coordinates.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        finiteCoordinate(point[0], 124, 132) &&
        finiteCoordinate(point[1], 32, 39.8),
    )
  );
}

function validWeatherContract(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const current = (payload as { current?: unknown }).current;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return false;
  }
  const row = current as {
    time?: unknown;
    temperature_2m?: unknown;
    weather_code?: unknown;
  };
  return (
    nonEmptyString(row.time) &&
    typeof row.temperature_2m === "number" &&
    Number.isFinite(row.temperature_2m) &&
    typeof row.weather_code === "number" &&
    Number.isFinite(row.weather_code)
  );
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.message === "PROVIDER_PROBE_TIMEOUT") {
      return "TIMEOUT";
    }
    if (/^HTTP_\d{3}$/.test(error.message)) return error.message;
    if (error.message === "INVALID_RESPONSE_CONTRACT") {
      return "INVALID_RESPONSE_CONTRACT";
    }
    if (error.message === "INSECURE_ENDPOINT") return "INSECURE_ENDPOINT";
    if (error.message === "INSECURE_REDIRECT") return "INSECURE_REDIRECT";
    if (error.message === "MISSING_RESPONSE_URL") {
      return "MISSING_RESPONSE_URL";
    }
    if (error.message === "PUBLIC_SHARED_REDIRECT_BLOCKED") {
      return "PUBLIC_SHARED_REDIRECT_BLOCKED";
    }
    if (error.message === "PUBLIC_SHARED_ENDPOINT_BLOCKED") {
      return "PUBLIC_SHARED_ENDPOINT_BLOCKED";
    }
    if (error.message === "CROSS_ORIGIN_REDIRECT") {
      return "CROSS_ORIGIN_REDIRECT";
    }
    if (error.message === "RESERVED_INVALID_ENDPOINT") {
      return "RESERVED_INVALID_ENDPOINT";
    }
    if (error.message === "TOO_MANY_ENDPOINTS") return "TOO_MANY_ENDPOINTS";
    if (error instanceof TypeError) return "NETWORK_ERROR";
  }
  return "PROBE_FAILED";
}

async function fetchJsonWithTimeout(
  url: URL,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  if (url.protocol !== "https:") throw new Error("INSECURE_ENDPOINT");
  if (SHARED_PUBLIC_ORIGINS.has(canonicalOrigin(url))) {
    throw new Error("PUBLIC_SHARED_ENDPOINT_BLOCKED");
  }
  if (url.hostname === "invalid" || url.hostname.endsWith(".invalid")) {
    throw new Error("RESERVED_INVALID_ENDPOINT");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("PROVIDER_PROBE_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "IEOGA/1.0 (+https://github.com/DONGJUN92/tour_data_webapp_Ieoga)",
        },
        signal: controller.signal,
        cache: "no-store",
        redirect: "follow",
      }),
      timeoutPromise,
    ]);
    if (!response.url) throw new Error("MISSING_RESPONSE_URL");
    const responseUrl = new URL(response.url);
    if (responseUrl.protocol !== "https:") {
      throw new Error("INSECURE_REDIRECT");
    }
    if (
      responseUrl.hostname === "invalid" ||
      responseUrl.hostname.endsWith(".invalid")
    ) {
      throw new Error("RESERVED_INVALID_ENDPOINT");
    }
    if (canonicalOrigin(responseUrl) !== canonicalOrigin(url)) {
      throw new Error(
        SHARED_PUBLIC_ORIGINS.has(canonicalOrigin(responseUrl))
          ? "PUBLIC_SHARED_REDIRECT_BLOCKED"
          : "CROSS_ORIGIN_REDIRECT",
      );
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await Promise.race([response.json(), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function probeUrl(configuration: ProviderConfiguration, endpoint: string): URL {
  const url = new URL(endpoint);
  switch (configuration.provider) {
    case "reverseGeocoding":
      url.searchParams.set("lat", String(TEST_LATITUDE));
      url.searchParams.set("lon", String(TEST_LONGITUDE));
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("accept-language", "ko");
      break;
    case "forwardGeocoding":
      url.searchParams.set("q", TEST_QUERY);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("countrycodes", "kr");
      url.searchParams.set("accept-language", "ko");
      url.searchParams.set("limit", "3");
      break;
    case "walkingRouting": {
      const coordinates = [
        `${TEST_LONGITUDE},${TEST_LATITUDE}`,
        `${ROUTE_DESTINATION_LONGITUDE},${ROUTE_DESTINATION_LATITUDE}`,
      ].join(";");
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${coordinates}`;
      url.searchParams.set("overview", "simplified");
      url.searchParams.set("geometries", "geojson");
      url.searchParams.set("steps", "false");
      url.searchParams.set("alternatives", "false");
      break;
    }
    case "weather":
      url.searchParams.set("latitude", String(TEST_LATITUDE));
      url.searchParams.set("longitude", String(TEST_LONGITUDE));
      url.searchParams.set("current", "temperature_2m,weather_code");
      url.searchParams.set("forecast_days", "1");
      url.searchParams.set("timezone", "Asia/Seoul");
      break;
  }
  return url;
}

function contractValid(provider: ProviderName, payload: unknown): boolean {
  switch (provider) {
    case "reverseGeocoding":
      return validReverseContract(payload);
    case "forwardGeocoding":
      return validForwardContract(payload);
    case "walkingRouting":
      return validRoutingContract(payload);
    case "weather":
      return validWeatherContract(payload);
  }
}

export async function probeProviderConfiguration(
  configuration: ProviderConfiguration,
  options: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: Date;
  } = {},
): Promise<ProviderProbeSnapshot> {
  const checkedAt = (options.now ?? new Date()).toISOString();
  const configurationFingerprint =
    await providerConfigurationFingerprint(configuration);
  if (configuration.mode !== "managed") {
    return {
      provider: configuration.provider,
      mode: configuration.mode,
      configurationFingerprint,
      endpointCount: configuration.endpoints.length,
      status: "blocked",
      latencyMs: 0,
      checkedAt,
      errorCode: "PUBLIC_SHARED_BLOCKED",
    };
  }
  if (
    configuration.endpoints.length === 0 ||
    (configuration.provider === "walkingRouting" &&
      configuration.endpoints.length > MAX_ROUTING_ENDPOINTS)
  ) {
    return {
      provider: configuration.provider,
      mode: configuration.mode,
      configurationFingerprint,
      endpointCount: configuration.endpoints.length,
      status: "error",
      latencyMs: 0,
      checkedAt,
      errorCode:
        configuration.endpoints.length === 0
          ? "MISSING_ENDPOINT"
          : "TOO_MANY_ENDPOINTS",
    };
  }

  const startedAt = Date.now();
  try {
    const payloads = await Promise.all(
      configuration.endpoints.map((endpoint) =>
        fetchJsonWithTimeout(
          probeUrl(configuration, endpoint),
          options.fetchImpl ?? fetch,
          options.timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS,
        ),
      ),
    );
    if (payloads.some((payload) => !contractValid(configuration.provider, payload))) {
      throw new Error("INVALID_RESPONSE_CONTRACT");
    }
    return {
      provider: configuration.provider,
      mode: configuration.mode,
      configurationFingerprint,
      endpointCount: configuration.endpoints.length,
      status: "success",
      latencyMs: Math.max(0, Date.now() - startedAt),
      checkedAt,
    };
  } catch (error) {
    return {
      provider: configuration.provider,
      mode: configuration.mode,
      configurationFingerprint,
      endpointCount: configuration.endpoints.length,
      status: "error",
      latencyMs: Math.max(0, Date.now() - startedAt),
      checkedAt,
      errorCode: errorCode(error),
    };
  }
}

export async function persistProviderProbeSnapshots(
  snapshots: ProviderProbeSnapshot[],
): Promise<boolean> {
  try {
    const db = getDb();
    for (const snapshot of snapshots) {
      await db
        .insert(providerProbeSnapshots)
        .values(snapshot)
        .onConflictDoUpdate({
          target: providerProbeSnapshots.provider,
          set: {
            mode: snapshot.mode,
            configurationFingerprint: snapshot.configurationFingerprint,
            endpointCount: snapshot.endpointCount,
            status: snapshot.status,
            latencyMs: snapshot.latencyMs,
            checkedAt: snapshot.checkedAt,
            errorCode: snapshot.errorCode ?? null,
          },
        });
    }
    return true;
  } catch {
    return false;
  }
}

export async function getStoredProviderProbeSnapshots(): Promise<
  ProviderProbeSnapshot[]
> {
  const rows = await getDb().select().from(providerProbeSnapshots);
  return rows.flatMap((row): ProviderProbeSnapshot[] => {
    if (!PROVIDER_NAMES.includes(row.provider as ProviderName)) return [];
    if (row.mode !== "managed" && row.mode !== "public_shared") return [];
    if (
      row.status !== "success" &&
      row.status !== "error" &&
      row.status !== "blocked"
    ) {
      return [];
    }
    return [
      {
        provider: row.provider as ProviderName,
        mode: row.mode,
        configurationFingerprint: row.configurationFingerprint,
        endpointCount: row.endpointCount,
        status: row.status,
        latencyMs: row.latencyMs,
        checkedAt: row.checkedAt,
        errorCode: row.errorCode ?? undefined,
      },
    ];
  });
}

export async function evaluateProviderReadiness(
  configurations: ProviderConfiguration[],
  snapshots: ProviderProbeSnapshot[],
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<ProviderReadinessReport> {
  const now = (options.now ?? new Date()).getTime();
  const staleAfterMs =
    options.staleAfterMs ?? PROVIDER_PROBE_STALE_AFTER_MS;
  const byProvider = new Map(
    snapshots.map((snapshot) => [snapshot.provider, snapshot]),
  );
  const entries = await Promise.all(
    configurations.map(async (configuration) => {
      const fingerprint = await providerConfigurationFingerprint(configuration);
      const snapshot = byProvider.get(configuration.provider);
      const checkedAt = snapshot ? Date.parse(snapshot.checkedAt) : Number.NaN;
      const stale =
        !snapshot ||
        !Number.isFinite(checkedAt) ||
        checkedAt > now + 5 * 60_000 ||
        now - checkedAt > staleAfterMs;
      let status: ProviderReadinessItem["status"];
      if (configuration.mode !== "managed") {
        status = "blocked";
      } else if (!snapshot) {
        status = "missing";
      } else if (
        snapshot.configurationFingerprint !== fingerprint ||
        snapshot.mode !== configuration.mode
      ) {
        status = "configuration_changed";
      } else if (stale) {
        status = "stale";
      } else {
        status = snapshot.status;
      }
      const ready =
        configuration.mode === "managed" &&
        status === "success" &&
        !stale;
      const item: ProviderReadinessItem = {
        provider: configuration.provider,
        mode: configuration.mode,
        ready,
        status,
        latencyMs: snapshot?.latencyMs,
        checkedAt: snapshot?.checkedAt,
        stale,
        errorCode:
          configuration.mode !== "managed"
            ? "PUBLIC_SHARED_BLOCKED"
            : status === "configuration_changed"
              ? "CONFIGURATION_CHANGED"
              : status === "stale"
                ? "STALE_PROBE"
                : snapshot?.errorCode,
      };
      return [configuration.provider, item] as const;
    }),
  );
  const providers = Object.fromEntries(entries) as Record<
    ProviderName,
    ProviderReadinessItem
  >;
  return {
    allReady: PROVIDER_NAMES.every((provider) => providers[provider]?.ready),
    staleAfterMs,
    providers,
  };
}

export async function getProviderReadinessReport(): Promise<ProviderReadinessReport> {
  return evaluateProviderReadiness(
    currentProviderConfigurations(),
    await getStoredProviderProbeSnapshots(),
  );
}

let refreshInFlight: Promise<ProviderProbeRefreshResult> | undefined;
let lastAttemptAt = 0;

export type ProviderProbeRefreshResult = {
  probed: boolean;
  persisted: boolean;
  snapshots: ProviderProbeSnapshot[];
  readiness: ProviderReadinessReport;
};

export async function refreshProviderProbes(options: {
  force?: boolean;
  minIntervalMs?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {}): Promise<ProviderProbeRefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  const configurations = currentProviderConfigurations();
  let storageReadable = true;
  const stored = await getStoredProviderProbeSnapshots().catch(() => {
    storageReadable = false;
    return [];
  });
  const current = await evaluateProviderReadiness(configurations, stored, {
    staleAfterMs:
      options.minIntervalMs ?? PROVIDER_PROBE_REFRESH_INTERVAL_MS,
  });
  if (!options.force && current.allReady) {
    return {
      probed: false,
      persisted: storageReadable,
      snapshots: stored,
      readiness: await evaluateProviderReadiness(configurations, stored),
    };
  }
  const minIntervalMs =
    options.minIntervalMs ?? PROVIDER_PROBE_REFRESH_INTERVAL_MS;
  if (!options.force && Date.now() - lastAttemptAt < minIntervalMs / 10) {
    return {
      probed: false,
      persisted: storageReadable,
      snapshots: stored,
      readiness: await evaluateProviderReadiness(configurations, stored),
    };
  }

  lastAttemptAt = Date.now();
  refreshInFlight = (async () => {
    const snapshots = await Promise.all(
      configurations.map((configuration) =>
        probeProviderConfiguration(configuration, {
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
        }),
      ),
    );
    const persisted = await persistProviderProbeSnapshots(snapshots);
    return {
      probed: true,
      persisted,
      snapshots,
      readiness: await evaluateProviderReadiness(configurations, snapshots),
    };
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}
