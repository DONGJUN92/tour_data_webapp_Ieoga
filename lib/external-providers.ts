import { getRuntimeSecret } from "@/lib/runtime-env";

export const PUBLIC_NOMINATIM_REVERSE_URL =
  "https://nominatim.openstreetmap.org/reverse";
export const PUBLIC_NOMINATIM_SEARCH_URL =
  "https://nominatim.openstreetmap.org/search";
export const PUBLIC_OSRM_WALKING_URL =
  "https://routing.openstreetmap.de/routed-foot/route/v1/driving";
export const PUBLIC_OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast";

export type ProviderMode = "managed" | "public_shared";

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    const port =
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
        ? ""
        : url.port;
    return `${url.protocol}//${hostname}${port ? `:${port}` : ""}`;
  } catch {
    return undefined;
  }
}

function sameOrigin(left: string, right: string): boolean {
  const leftOrigin = canonicalOrigin(left);
  const rightOrigin = canonicalOrigin(right);
  return leftOrigin && rightOrigin
    ? leftOrigin === rightOrigin
    : normalizeUrl(left) === normalizeUrl(right);
}

/* Splits a comma-separated endpoint list without breaking URLs that carry a
   comma inside their query string — `annotations=distance,duration` is valid
   and must not be read as two endpoints. Any fragment that does not begin a
   new URL is rejoined to the one before it, so a misplaced comma degrades
   into one endpoint rather than silently dropping configuration. */
function splitEndpointList(value: string | undefined): string[] {
  const parts = (value ?? "").split(",");
  const endpoints: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed) || endpoints.length === 0) {
      endpoints.push(trimmed);
    } else {
      endpoints[endpoints.length - 1] += `,${trimmed}`;
    }
  }
  return endpoints.filter((entry) => /^https?:\/\//i.test(entry));
}

function providerConfig(
  configured: string | undefined,
  publicUrl: string,
): { url: string; mode: ProviderMode } {
  const url = configured?.trim() || publicUrl;
  return {
    url,
    mode:
      sameOrigin(url, publicUrl)
        ? "public_shared"
        : "managed",
  };
}

/* Whether the reachable reverse-geocoding fallback is the shared public
   Nominatim endpoint. Kakao being configured does not change that endpoint's
   usage policy or release classification. */
export function usesPublicNominatim(): boolean {
  return (
    providerConfig(
      getRuntimeSecret("REVERSE_GEOCODE_URL"),
      PUBLIC_NOMINATIM_REVERSE_URL,
    ).mode === "public_shared"
  );
}

export function reverseGeocodeProviderConfig() {
  return providerConfig(
    getRuntimeSecret("REVERSE_GEOCODE_URL"),
    PUBLIC_NOMINATIM_REVERSE_URL,
  );
}

export function forwardGeocodeProviderConfig() {
  return providerConfig(
    getRuntimeSecret("FORWARD_GEOCODE_URL"),
    PUBLIC_NOMINATIM_SEARCH_URL,
  );
}

export function routingProviderConfig() {
  const endpoints = routingEndpoints();
  /* TMAP 보행자 경로는 OSRM 호환 엔드포인트가 아니라 별도 어댑터이므로
     ROUTING_BASE_URL로는 설정할 수 없다. 하지만 키가 있으면 그것이 1순위
     공급자이고 상용 쿼터를 쓰므로, 준비 상태 판정에서 공용 공유 서버 의존이
     끝났다고 보는 것이 사실에 맞다. OSRM은 그 뒤의 폴백으로만 남는다. */
  if (getRuntimeSecret("TMAP_APP_KEY")) {
    return {
      url: "https://apis.openapi.sk.com/tmap/routes/pedestrian",
      mode: "managed" as const,
    };
  }
  return {
    url: endpoints[0],
    mode: endpoints.some(
      (url) => sameOrigin(url, PUBLIC_OSRM_WALKING_URL),
    )
      ? ("public_shared" as const)
      : ("managed" as const),
  };
}

/* Walking ETA is a hard gate: a candidate whose arrival cannot be verified is
   rejected rather than guessed. ROUTING_BASE_URL accepts a comma-separated
   list of OSRM-compatible endpoints, tried in order. A configured list is
   authoritative; operators must explicitly include a shared-public fallback,
   allowing readiness to classify the complete reachable chain truthfully. */
export function routingEndpoints(): string[] {
  const configured = splitEndpointList(getRuntimeSecret("ROUTING_BASE_URL"));
  return configured.length ? configured : [PUBLIC_OSRM_WALKING_URL];
}

export function weatherProviderConfig() {
  return providerConfig(
    getRuntimeSecret("WEATHER_API_URL"),
    PUBLIC_OPEN_METEO_URL,
  );
}
