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
      normalizeUrl(url) === normalizeUrl(publicUrl)
        ? "public_shared"
        : "managed",
  };
}

/* A Kakao REST key turns geocoding into a managed, keyed provider: reverse
   lookups go through coord2regioncode and place search through the local
   keyword API, with the shared Nominatim endpoints kept only as fallback. */
function kakaoGeocodingConfigured(): boolean {
  return Boolean(getRuntimeSecret("KAKAO_REST_API_KEY"));
}

/* Whether the Nominatim endpoint itself is the shared public one. The
   reverse-geocode *mode* can read as managed via Kakao while Nominatim is
   still reachable as fallback, and that fallback must keep honouring the
   public usage policy — so throttling keys off this, not off the mode. */
export function usesPublicNominatim(): boolean {
  return (
    providerConfig(
      getRuntimeSecret("REVERSE_GEOCODE_URL"),
      PUBLIC_NOMINATIM_REVERSE_URL,
    ).mode === "public_shared"
  );
}

export function reverseGeocodeProviderConfig() {
  const config = providerConfig(
    getRuntimeSecret("REVERSE_GEOCODE_URL"),
    PUBLIC_NOMINATIM_REVERSE_URL,
  );
  if (config.mode === "public_shared" && kakaoGeocodingConfigured()) {
    return { ...config, mode: "managed" as ProviderMode };
  }
  return config;
}

export function forwardGeocodeProviderConfig() {
  const config = providerConfig(
    getRuntimeSecret("FORWARD_GEOCODE_URL"),
    PUBLIC_NOMINATIM_SEARCH_URL,
  );
  if (config.mode === "public_shared" && kakaoGeocodingConfigured()) {
    return { ...config, mode: "managed" as ProviderMode };
  }
  return config;
}

export function routingProviderConfig() {
  return providerConfig(
    routingEndpoints()[0],
    PUBLIC_OSRM_WALKING_URL,
  );
}

/* Walking ETA is a hard gate: a candidate whose arrival cannot be verified is
   rejected rather than guessed, so a single unreachable router takes the whole
   recovery down. ROUTING_BASE_URL therefore accepts a comma-separated list of
   OSRM-compatible endpoints, tried in order. The shared public router is
   always kept as the final entry so a misconfigured managed endpoint degrades
   instead of failing closed. Every entry is a real routing engine — none of
   this substitutes an estimated distance for a measured one. */
export function routingEndpoints(): string[] {
  const configured = splitEndpointList(getRuntimeSecret("ROUTING_BASE_URL"));
  const ordered = configured.length ? configured : [PUBLIC_OSRM_WALKING_URL];
  if (!ordered.some((url) => normalizeUrl(url) === normalizeUrl(PUBLIC_OSRM_WALKING_URL))) {
    ordered.push(PUBLIC_OSRM_WALKING_URL);
  }
  return ordered;
}

export function weatherProviderConfig() {
  const config = providerConfig(
    getRuntimeSecret("WEATHER_API_URL"),
    PUBLIC_OPEN_METEO_URL,
  );
  /* An approved KMA forecast service makes the domestic authority the primary
     source, with Open-Meteo kept only as fallback. Keyed off the dedicated
     variable so the status reflects an approval the operator confirmed, not
     merely the presence of some portal key. */
  if (config.mode === "public_shared" && getRuntimeSecret("KMA_SERVICE_KEY")) {
    return { ...config, mode: "managed" as ProviderMode };
  }
  return config;
}
import { getRuntimeSecret } from "@/lib/runtime-env";
