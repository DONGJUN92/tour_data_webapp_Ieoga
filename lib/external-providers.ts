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

export const TMAP_PEDESTRIAN_URL =
  "https://apis.openapi.sk.com/tmap/routes/pedestrian";

/* 자동차 경로는 같은 `TMAP_APP_KEY`로 동작한다. 별도 발급·별도 승인이 필요하지
   않음을 2026-08-04 실호출로 확인했다. */
export const TMAP_CAR_URL = "https://apis.openapi.sk.com/tmap/routes";

export function tmapPedestrianConfigured(): boolean {
  return Boolean(getRuntimeSecret("TMAP_APP_KEY"));
}

export function tmapCarConfigured(): boolean {
  return Boolean(getRuntimeSecret("TMAP_APP_KEY"));
}

/* 자동차 경로에는 OSRM 공개 폴백을 붙이지 않는다. 공개 OSRM 기본 프로파일은
   보행이고, 자동차 프로파일을 쓰는 공개 서버를 임의로 가정하면 "차로 12분"이
   실제로는 걸어서 12분인 값이 될 수 있다. 도착 시각이 판정 근거이므로 잘못된
   단위로 통과시키는 것보다 확인하지 못한 채 탈락시키는 쪽이 안전하다. */
export function carRouteChain(): string[] {
  return tmapCarConfigured() ? [TMAP_CAR_URL] : [];
}

/* The complete chain a walking-route request can actually reach, in call
   order. TMAP is not an OSRM-compatible endpoint and cannot be expressed in
   ROUTING_BASE_URL, so it is joined here rather than classified on its own.
   Readiness asks "does a shared public server remain reachable", not "what
   answers first" — the same rule Kakao and KMA already live under, where a
   commercial primary does not hide the public fallback behind it. */
export function walkingRouteChain(): string[] {
  const endpoints = routingEndpoints();
  return tmapPedestrianConfigured()
    ? [TMAP_PEDESTRIAN_URL, ...endpoints]
    : endpoints;
}

export function routingProviderConfig(): { url?: string; mode: ProviderMode } {
  const chain = walkingRouteChain();
  return {
    url: chain[0],
    mode: chain.some(
      (url) => sameOrigin(url, PUBLIC_OSRM_WALKING_URL),
    )
      ? ("public_shared" as const)
      : ("managed" as const),
  };
}

/* Operators need a way to say "no public fallback" out loud. Without it the
   public default is appended forever, so a deployment running entirely on a
   commercial or official provider could never be classified as anything but
   shared — and the honest classification would be unreachable by
   configuration. */
const FALLBACK_DISABLED_VALUES = new Set(["none", "disabled", "off"]);

function fallbackDisabled(value: string | undefined): boolean {
  return Boolean(value && FALLBACK_DISABLED_VALUES.has(value.toLowerCase()));
}

/* Walking ETA is a hard gate: a candidate whose arrival cannot be verified is
   rejected rather than guessed. ROUTING_BASE_URL accepts a comma-separated
   list of OSRM-compatible endpoints, tried in order. A configured list is
   authoritative; operators must explicitly include a shared-public fallback,
   allowing readiness to classify the complete reachable chain truthfully. */
export function routingEndpoints(): string[] {
  const raw = getRuntimeSecret("ROUTING_BASE_URL")?.trim();
  if (fallbackDisabled(raw)) return [];
  const configured = splitEndpointList(raw);
  return configured.length ? configured : [PUBLIC_OSRM_WALKING_URL];
}

export const KMA_SHORT_TERM_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";

export function kmaShortTermConfigured(): boolean {
  return Boolean(getRuntimeSecret("KMA_SERVICE_KEY"));
}

/* The Open-Meteo-compatible endpoint the weather fallback calls, or undefined
   when the operator has declared there is no fallback. Kept separate from the
   chain below because callers fetch this one directly and must not be handed
   the agency URL, which speaks a different contract entirely. */
export function openMeteoEndpoint(): string | undefined {
  const raw = getRuntimeSecret("WEATHER_API_URL")?.trim();
  if (fallbackDisabled(raw)) return undefined;
  return raw || PUBLIC_OPEN_METEO_URL;
}

/* 기상청 answers first when its key is set, so it leads the chain the same way
   TMAP leads walking routes. Readiness asks what remains reachable behind it,
   not what answers first. */
export function weatherChain(): string[] {
  const fallback = openMeteoEndpoint();
  return [
    ...(kmaShortTermConfigured() ? [KMA_SHORT_TERM_URL] : []),
    ...(fallback ? [fallback] : []),
  ];
}

export function weatherProviderConfig(): { url?: string; mode: ProviderMode } {
  const chain = weatherChain();
  return {
    url: chain[0],
    mode: chain.some((url) => sameOrigin(url, PUBLIC_OPEN_METEO_URL))
      ? ("public_shared" as const)
      : ("managed" as const),
  };
}
