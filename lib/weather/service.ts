import { openMeteoEndpoint } from "@/lib/external-providers";
import {
  getKmaObservation,
  kmaConfigured,
  type KmaForecastSlot,
} from "./kma";

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
      /* 지금 이후의 시간별 예보. 앱은 이 시계열을 이미 받고 있었는데 첫 슬롯만
         읽고 버렸다. 여행자가 **거기 있을 시간대**의 날씨는 여기에 있다.
         비어 있으면 예보를 확인하지 못했다는 뜻이고, 그때는 체류 시간대
         판정을 하지 않는다. */
      forecast: KmaForecastSlot[];
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
    precipitation?: number[];
    temperature_2m?: number[];
    wind_speed_10m?: number[];
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
        forecast: observation.forecast,
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
  const endpoint = openMeteoEndpoint();
  /* The operator can declare that 기상청 is the only weather source. Then a
     KMA failure is the end of the answer: reporting no evidence is correct,
     and silently reaching for a provider that was switched off is not. */
  if (!endpoint) {
    const unavailable: WeatherEvidence = {
      status: "unavailable",
      observedAt,
      provider: "kma_short_term",
      reason: kmaConfigured()
        ? "기상청 단기예보가 응답하지 않았습니다."
        : "현재 기상 공급자가 설정되지 않았습니다.",
      attribution: KMA_ATTRIBUTION,
    };
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: unavailable });
    return unavailable;
  }
  const url = new URL(endpoint);
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
  /* 대체 공급자도 같은 형태의 시계열을 준다. 기상청이 응답하지 않을 때
     체류 시간대 판정을 통째로 잃지 않도록 함께 받는다. */
  url.searchParams.set(
    "hourly",
    ["precipitation_probability", "precipitation", "temperature_2m", "wind_speed_10m"].join(
      ",",
    ),
  );
  url.searchParams.set("forecast_hours", "24");
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
    /* `timezone=auto`로 요청했으므로 시각이 현지 표기다. 오프셋이 없으면
       Date가 UTC로 읽어 버려 슬롯이 9시간 어긋난다. 국내 좌표만 다루므로
       KST 오프셋을 붙인다. */
    const hourlyForecast: KmaForecastSlot[] = (payload.hourly?.time ?? [])
      .map((time, index) => {
        /* Open-Meteo는 `2026-08-05T15:00` 형태로 준다 — 초와 오프셋이 없다. */
        const at = /[+Z]/.test(time) ? time : `${time}:00+09:00`;
        const millimeters = payload.hourly?.precipitation?.[index];
        return {
          at,
          precipitationProbabilityPercent:
            payload.hourly?.precipitation_probability?.[index],
          /* Open-Meteo는 강수 형태 코드를 주지 않는다. 강수량으로 유무만
             옮기고, 형태를 아는 것처럼 적지 않는다. */
          precipitationType:
            millimeters === undefined
              ? undefined
              : millimeters > 0
                ? 1
                : 0,
          temperatureCelsius: payload.hourly?.temperature_2m?.[index],
          windSpeedKph:
            payload.hourly?.wind_speed_10m?.[index] === undefined
              ? undefined
              : Math.round(
                  Number(payload.hourly.wind_speed_10m[index]) * 10,
                ) / 10,
        };
      })
      .filter((slot) => !Number.isNaN(Date.parse(slot.at)));
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
      forecast: hourlyForecast,
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
