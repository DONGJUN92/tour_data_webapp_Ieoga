import { weatherProviderConfig } from "@/lib/external-providers";
import { getKmaObservation, kmaConfigured } from "./kma";

export type WeatherProvider = "kma_short_term" | "open_meteo";

export type WeatherEvidence =
  | {
      status: "available";
      observedAt: string;
      temperatureCelsius: number;
      apparentTemperatureCelsius: number;
      precipitationMillimeters: number;
      precipitationProbabilityPercent?: number;
      weatherCode: number;
      windSpeedKph: number;
      raining: boolean;
      provider: WeatherProvider;
      attribution: string;
    }
  | {
      status: "unavailable";
      observedAt: string;
      provider: WeatherProvider;
      reason: string;
      attribution: string;
    };

const KMA_ATTRIBUTION = "기상자료: 기상청 단기예보 (공공누리 제1유형)";
const OPEN_METEO_ATTRIBUTION = "기상자료: Open-Meteo (CC BY 4.0)";

type OpenMeteoResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    precipitation?: number;
    rain?: number;
    showers?: number;
    snowfall?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  hourly?: {
    time?: string[];
    precipitation_probability?: number[];
  };
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: WeatherEvidence }>();

function weatherKey(latitude: number, longitude: number) {
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

export async function getWeatherEvidence(
  latitude: number,
  longitude: number,
  options: { signal?: AbortSignal } = {},
): Promise<WeatherEvidence> {
  const key = weatherKey(latitude, longitude);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  /* The domestic forecast authority answers first when its service is
     approved on the portal key. Open-Meteo stays as the fallback so a KMA
     outage degrades the evidence rather than removing it, and every result
     names the provider that actually answered. */
  if (kmaConfigured()) {
    try {
      const observation = await getKmaObservation(latitude, longitude, options);
      const evidence: WeatherEvidence = {
        status: "available",
        observedAt: observation.observedAt,
        temperatureCelsius: observation.temperatureCelsius,
        /* The nowcast product does not publish an apparent temperature, and
           deriving one here would present a computed value as an observed
           one. The measured air temperature is reported instead. */
        apparentTemperatureCelsius: observation.temperatureCelsius,
        precipitationMillimeters: observation.precipitationMillimeters,
        precipitationProbabilityPercent:
          observation.precipitationProbabilityPercent,
        weatherCode: observation.weatherCode,
        windSpeedKph: observation.windSpeedKph,
        raining: observation.raining,
        provider: "kma_short_term",
        attribution: KMA_ATTRIBUTION,
      };
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: evidence });
      return evidence;
    } catch {
      if (options.signal?.aborted) {
        throw new DOMException("Weather request cancelled", "AbortError");
      }
      /* Fall through to Open-Meteo below. */
    }
  }

  const observedAt = new Date().toISOString();
  const attribution = OPEN_METEO_ATTRIBUTION;
  const url = new URL(weatherProviderConfig().url);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "rain",
      "showers",
      "snowfall",
      "weather_code",
      "wind_speed_10m",
    ].join(","),
  );
  url.searchParams.set("hourly", "precipitation_probability");
  url.searchParams.set("forecast_hours", "6");
  url.searchParams.set("timezone", "auto");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let result: WeatherEvidence;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
    });
    if (!response.ok) throw new Error(`WEATHER_HTTP_${response.status}`);
    const payload = (await response.json()) as OpenMeteoResponse;
    const current = payload.current;
    if (
      !current ||
      !Number.isFinite(current.temperature_2m) ||
      !Number.isFinite(current.weather_code)
    ) {
      throw new Error("WEATHER_EMPTY");
    }
    const probability = payload.hourly?.precipitation_probability?.[0];
    const precipitation = Number.isFinite(current.precipitation)
      ? Number(current.precipitation)
      : Number(current.rain ?? 0) +
        Number(current.showers ?? 0) +
        Number(current.snowfall ?? 0);
    result = {
      status: "available",
      observedAt: current.time || observedAt,
      temperatureCelsius: Number(current.temperature_2m),
      apparentTemperatureCelsius: Number(
        current.apparent_temperature ?? current.temperature_2m,
      ),
      precipitationMillimeters: Math.round(precipitation * 10) / 10,
      precipitationProbabilityPercent: Number.isFinite(probability)
        ? Number(probability)
        : undefined,
      weatherCode: Number(current.weather_code),
      windSpeedKph: Number(current.wind_speed_10m ?? 0),
      raining:
        precipitation > 0 ||
        (Number.isFinite(probability) && Number(probability) >= 50),
      provider: "open_meteo",
      attribution,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw new DOMException("Weather request cancelled", "AbortError");
    }
    result = {
      status: "unavailable",
      observedAt,
      provider: "open_meteo",
      reason:
        error instanceof Error && error.name === "AbortError"
          ? "현재 기상 확인 시간이 초과되었습니다."
          : "현재 기상 공급자가 응답하지 않습니다.",
      attribution,
    };
  } finally {
    clearTimeout(timeout);
  }

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
  return result;
}
