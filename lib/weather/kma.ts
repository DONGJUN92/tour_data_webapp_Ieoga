import { KMA_SHORT_TERM_URL } from "@/lib/external-providers";
import { getRuntimeSecret } from "@/lib/runtime-env";

/* 기상청 단기예보 adapter.
   The agency publishes the official domestic forecast, which the proposal
   treats as the weather authority. Two things make it unlike Open-Meteo: it
   addresses points by a Lambert conformal grid rather than latitude and
   longitude, and it publishes on fixed announcement times that a caller has to
   round down to. Both are handled here so the rest of the app keeps using one
   weather contract. */

const KMA_BASE_URL = KMA_SHORT_TERM_URL;

/* The portal issues one key per account, so this is usually the same string as
   KTO_SERVICE_KEY — but it is deliberately NOT defaulted to it. Each dataset
   is applied for separately, and an account that has not been approved for the
   forecast service would otherwise spend a five-second timeout failing on
   every weather lookup before falling back, while the readiness panel claimed
   a managed provider that does not answer. Setting this variable is the
   operator asserting the service is approved. */
export function kmaServiceKey(): string | undefined {
  return getRuntimeSecret("KMA_SERVICE_KEY");
}

export function kmaConfigured(): boolean {
  return Boolean(kmaServiceKey());
}

/* Lambert conformal conic projection published by the agency for its 5km
   forecast grid. Constants are theirs; do not retune them. */
export function toKmaGrid(
  latitude: number,
  longitude: number,
): { nx: number; ny: number } {
  const RE = 6371.00877;
  const GRID = 5.0;
  const SLAT1 = 30.0;
  const SLAT2 = 60.0;
  const OLON = 126.0;
  const OLAT = 38.0;
  const XO = 43;
  const YO = 136;
  const DEGRAD = Math.PI / 180.0;

  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn =
    Math.tan(Math.PI * 0.25 + slat2 * 0.5) /
    Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + latitude * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = longitude * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

function kstParts(at: Date) {
  const kst = new Date(
    at.toLocaleString("en-US", { timeZone: "Asia/Seoul" }),
  );
  return {
    year: kst.getFullYear(),
    month: kst.getMonth() + 1,
    day: kst.getDate(),
    hour: kst.getHours(),
    minute: kst.getMinutes(),
  };
}

function stampDate(year: number, month: number, day: number): string {
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function shiftKstDay(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/* 초단기실황 is announced on the hour and published about forty minutes
   later, so before HH:40 the latest available announcement is the previous
   hour — and at 00:xx that rolls back to yesterday. */
export function ultraShortNowcastBase(at = new Date()): {
  baseDate: string;
  baseTime: string;
} {
  const { year, month, day, hour, minute } = kstParts(at);
  let targetHour = minute < 40 ? hour - 1 : hour;
  let date = { year, month, day };
  if (targetHour < 0) {
    targetHour = 23;
    date = shiftKstDay(year, month, day, -1);
  }
  return {
    baseDate: stampDate(date.year, date.month, date.day),
    baseTime: `${String(targetHour).padStart(2, "0")}00`,
  };
}

/* 단기예보 is announced eight times a day and published about ten minutes
   after each slot. Used only for the precipitation probability, which the
   nowcast product does not carry. */
const VILLAGE_SLOTS = [2, 5, 8, 11, 14, 17, 20, 23];

export function villageForecastBase(at = new Date()): {
  baseDate: string;
  baseTime: string;
} {
  const { year, month, day, hour, minute } = kstParts(at);
  const available = VILLAGE_SLOTS.filter(
    (slot) => hour > slot || (hour === slot && minute >= 10),
  );
  if (!available.length) {
    const previous = shiftKstDay(year, month, day, -1);
    return {
      baseDate: stampDate(previous.year, previous.month, previous.day),
      baseTime: "2300",
    };
  }
  return {
    baseDate: stampDate(year, month, day),
    baseTime: `${String(available[available.length - 1]).padStart(2, "0")}00`,
  };
}

/* `20260805` + `1500` → `2026-08-05T15:00:00+09:00`.
   KST 오프셋을 문자열에 박아 둔다. 서버가 어느 시간대에서 돌든 같은 순간을
   가리켜야 하고, Date로 한 번 파싱하면 그 정보가 사라진다. */
function kstIsoFromForecastStamp(
  fcstDate: string,
  fcstTime: string,
): string | undefined {
  if (!/^\d{8}$/.test(fcstDate) || !/^\d{4}$/.test(fcstTime)) return undefined;
  const year = fcstDate.slice(0, 4);
  const month = fcstDate.slice(4, 6);
  const day = fcstDate.slice(6, 8);
  const hour = fcstTime.slice(0, 2);
  const minute = fcstTime.slice(2, 4);
  if (Number(hour) > 23 || Number(minute) > 59) return undefined;
  return `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
}

type KmaItem = {
  category?: string;
  obsrValue?: string;
  fcstValue?: string;
  fcstDate?: string;
  fcstTime?: string;
};

async function callKma(
  operation: string,
  params: Record<string, string | number>,
  signal?: AbortSignal,
  /* 단기예보는 카테고리 12종 x 시간슬롯 66개 = 약 800항목을 준다. 300으로
     받으면 뒷부분 슬롯이 잘린다. 실황은 8항목이라 기본값으로 충분하다. */
  numOfRows = 300,
): Promise<KmaItem[]> {
  const key = kmaServiceKey();
  if (!key) throw new Error("KMA_KEY_MISSING");

  const url = new URL(`${KMA_BASE_URL}/${operation}`);
  const search = new URLSearchParams({
    serviceKey: key,
    dataType: "JSON",
    pageNo: "1",
    numOfRows: String(numOfRows),
  });
  for (const [name, value] of Object.entries(params)) {
    search.set(name, String(value));
  }
  url.search = search.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`KMA_HTTP_${response.status}`);
    /* The service answers errors as XML even when JSON was requested, so the
       body is read as text first and parsed defensively. */
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("KMA_NON_JSON_RESPONSE");
    }
    const envelope = payload as {
      response?: {
        header?: { resultCode?: string };
        body?: { items?: { item?: KmaItem[] | KmaItem } };
      };
    };
    const resultCode = envelope.response?.header?.resultCode ?? "";
    if (resultCode !== "00") throw new Error(`KMA_${resultCode || "INVALID"}`);
    const item = envelope.response?.body?.items?.item;
    if (!item) return [];
    return Array.isArray(item) ? item : [item];
  } finally {
    clearTimeout(timeout);
  }
}

/* PTY (강수형태) and SKY (하늘상태) are the agency's own scales. They are
   translated to the WMO codes the rest of the app already speaks, so a
   provider swap does not change how callers read the value. Precipitation
   always wins over sky state. */
function toWmoCode(pty: number | undefined, sky: number | undefined): number {
  switch (pty) {
    case 1:
      return 61; // 비
    case 2:
      return 66; // 비/눈
    case 3:
      return 71; // 눈
    case 5:
      return 51; // 빗방울
    case 6:
      return 66; // 빗방울/눈날림
    case 7:
      return 77; // 눈날림
    default:
      break;
  }
  switch (sky) {
    case 1:
      return 0; // 맑음
    case 3:
      return 2; // 구름많음
    case 4:
      return 3; // 흐림
    default:
      return 0;
  }
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* RN1 is reported as text such as "강수없음" or "1.0mm", not a bare number. */
function precipitationMillimeters(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("없음")) return 0;
  const match = trimmed.match(/[\d.]+/);
  return match ? Number(match[0]) : 0;
}

/* 단기예보의 시간슬롯 하나. 이 앱은 이미 `getVilageFcst`를 호출하고 있었지만
   첫 슬롯의 강수확률과 하늘상태만 읽고 나머지 약 790개 값을 버렸다. 여행자가
   **거기 있을 시간대**의 날씨는 그 버린 값들 안에 있었다. */
export type KmaForecastSlot = {
  /* KST 기준 예보 시각(ISO 8601, +09:00). */
  at: string;
  precipitationProbabilityPercent?: number;
  /* PTY: 0 없음 1 비 2 비/눈 3 눈 4 소나기. */
  precipitationType?: number;
  /* PCP·SNO 원문. `강수없음`처럼 문자열로 오는 경우가 있어 그대로 보관한다. */
  precipitationText?: string;
  temperatureCelsius?: number;
  skyCode?: number;
  windSpeedKph?: number;
  humidityPercent?: number;
};

export type KmaObservation = {
  observedAt: string;
  temperatureCelsius: number;
  precipitationMillimeters: number;
  precipitationProbabilityPercent?: number;
  weatherCode: number;
  windSpeedKph: number;
  raining: boolean;
  /* 실황의 원시 코드. `weatherCode`(WMO)로 접으면 아이콘을 고를 때 되돌릴 수
     없다. "지금" 칸은 예보가 아니라 이 값으로 만들어야 한다 — 23시 발표
     예보는 00:00부터 시작하므로 현재 시각 이하의 슬롯이 없다. */
  precipitationType?: number;
  skyCode?: number;
  baseDate: string;
  baseTime: string;
  nx: number;
  ny: number;
  /* 지금부터 앞으로의 시간별 예보. 비어 있으면 단기예보 호출이 실패했다는
     뜻이고, 그때는 체류 시간대 판정을 하지 않는다. */
  forecast: KmaForecastSlot[];
};

export async function getKmaObservation(
  latitude: number,
  longitude: number,
  options: { signal?: AbortSignal } = {},
): Promise<KmaObservation> {
  const { nx, ny } = toKmaGrid(latitude, longitude);
  const nowcast = ultraShortNowcastBase();
  const village = villageForecastBase();

  /* The probability call is best effort: a missing POP degrades one field,
     where a missing nowcast means there is no observation to report. */
  const [nowcastResult, villageResult] = await Promise.allSettled([
    callKma(
      "getUltraSrtNcst",
      { base_date: nowcast.baseDate, base_time: nowcast.baseTime, nx, ny },
      options.signal,
    ),
    callKma(
      "getVilageFcst",
      { base_date: village.baseDate, base_time: village.baseTime, nx, ny },
      options.signal,
      /* 카테고리 12종 x 슬롯 66개. 실측 798항목이므로 여유를 둔다. */
      1_000,
    ),
  ]);

  if (nowcastResult.status === "rejected") throw nowcastResult.reason;
  const observed = new Map<string, string>();
  for (const item of nowcastResult.value) {
    if (item.category && item.obsrValue !== undefined) {
      observed.set(item.category, item.obsrValue);
    }
  }
  const temperature = numeric(observed.get("T1H"));
  if (temperature === undefined) throw new Error("KMA_EMPTY_OBSERVATION");

  /* 예보를 시간슬롯으로 모은다. 예전에는 첫 슬롯의 POP·SKY만 읽고 나머지를
     버렸는데, 여행자가 **거기 있을 시간대**의 날씨가 그 버린 값들 안에 있었다.
     같은 응답이므로 추가 호출은 없다. */
  const slotMap = new Map<string, KmaForecastSlot>();
  if (villageResult.status === "fulfilled") {
    for (const item of villageResult.value) {
      if (!item.fcstDate || !item.fcstTime || !item.category) continue;
      const at = kstIsoFromForecastStamp(item.fcstDate, item.fcstTime);
      if (!at) continue;
      const slot = slotMap.get(at) ?? { at };
      const raw = item.fcstValue;
      switch (item.category) {
        case "POP":
          slot.precipitationProbabilityPercent = numeric(raw);
          break;
        case "PTY":
          slot.precipitationType = numeric(raw);
          break;
        case "PCP":
          if (raw) slot.precipitationText = raw;
          break;
        case "TMP":
          slot.temperatureCelsius = numeric(raw);
          break;
        case "SKY":
          slot.skyCode = numeric(raw);
          break;
        case "WSD": {
          const metersPerSecond = numeric(raw);
          if (metersPerSecond !== undefined) {
            slot.windSpeedKph =
              Math.round(metersPerSecond * 3.6 * 10) / 10;
          }
          break;
        }
        case "REH":
          slot.humidityPercent = numeric(raw);
          break;
        default:
          break;
      }
      slotMap.set(at, slot);
    }
  }
  const forecast = [...slotMap.values()].sort((a, b) =>
    a.at.localeCompare(b.at),
  );
  /* 실황에 없는 두 값은 가장 이른 슬롯에서 가져온다 — 예전 동작과 같다.
     슬롯을 만들지 못한 경우(예보 항목에 시각이 없는 응답)에는 원본 항목을
     순서대로 훑어 첫 값을 쓴다. 시계열을 못 만들었다는 이유로 예전에 얻던
     값까지 잃으면 안 된다. */
  const firstCategoryValue = (category: string): number | undefined => {
    if (villageResult.status !== "fulfilled") return undefined;
    for (const item of villageResult.value) {
      if (item.category === category) {
        const value = numeric(item.fcstValue);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  };
  const probability =
    forecast.find(
      (slot) => slot.precipitationProbabilityPercent !== undefined,
    )?.precipitationProbabilityPercent ?? firstCategoryValue("POP");
  const sky =
    forecast.find((slot) => slot.skyCode !== undefined)?.skyCode ??
    firstCategoryValue("SKY");

  const pty = numeric(observed.get("PTY"));
  const rain = precipitationMillimeters(observed.get("RN1"));
  const windMetersPerSecond = numeric(observed.get("WSD")) ?? 0;

  return {
    observedAt: new Date().toISOString(),
    temperatureCelsius: temperature,
    precipitationMillimeters: Math.round(rain * 10) / 10,
    precipitationProbabilityPercent: probability,
    weatherCode: toWmoCode(pty, sky),
    windSpeedKph: Math.round(windMetersPerSecond * 3.6 * 10) / 10,
    precipitationType: pty,
    skyCode: sky,
    raining:
      (pty !== undefined && pty > 0) ||
      rain > 0 ||
      (probability !== undefined && probability >= 50),
    baseDate: nowcast.baseDate,
    baseTime: nowcast.baseTime,
    nx,
    ny,
    forecast,
  };
}
