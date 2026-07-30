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
  return providerConfig(
    getRuntimeSecret("ROUTING_BASE_URL"),
    PUBLIC_OSRM_WALKING_URL,
  );
}

export function weatherProviderConfig() {
  return providerConfig(
    getRuntimeSecret("WEATHER_API_URL"),
    PUBLIC_OPEN_METEO_URL,
  );
}
import { getRuntimeSecret } from "@/lib/runtime-env";
