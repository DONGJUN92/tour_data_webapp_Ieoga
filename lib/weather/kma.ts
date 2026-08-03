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
): Promise<KmaItem[]> {
  const key = kmaServiceKey();
  if (!key) throw new Error("KMA_KEY_MISSING");

  const url = new URL(`${KMA_BASE_URL}/${operation}`);
  const search = new URLSearchParams({
    serviceKey: key,
    dataType: "JSON",
    pageNo: "1",
    numOfRows: "300",
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

export type KmaObservation = {
  observedAt: string;
  temperatureCelsius: number;
  precipitationMillimeters: number;
  precipitationProbabilityPercent?: number;
  weatherCode: number;
  windSpeedKph: number;
  raining: boolean;
  baseDate: string;
  baseTime: string;
  nx: number;
  ny: number;
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

  let probability: number | undefined;
  let sky: number | undefined;
  if (villageResult.status === "fulfilled") {
    /* Take the earliest forecast slot at or after now, which is the first
       entry the service returns for each category. */
    for (const item of villageResult.value) {
      if (item.category === "POP" && probability === undefined) {
        probability = numeric(item.fcstValue);
      }
      if (item.category === "SKY" && sky === undefined) {
        sky = numeric(item.fcstValue);
      }
      if (probability !== undefined && sky !== undefined) break;
    }
  }

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
    raining:
      (pty !== undefined && pty > 0) ||
      rain > 0 ||
      (probability !== undefined && probability >= 50),
    baseDate: nowcast.baseDate,
    baseTime: nowcast.baseTime,
    nx,
    ny,
  };
}
