import type { WeatherEvidence } from "./service";

/* 체류 시간대의 날씨.
 *
 * 앱은 기상청 단기예보를 이미 호출하고 있었지만 첫 슬롯의 강수확률과 하늘상태만
 * 읽고 나머지 약 790개 값을 버렸다. 그 결과 날씨가 판정에 쓰이는 곳은 한 군데,
 * "사용자가 우천을 골랐는데 API는 비를 못 봤다"는 경고 문장 하나뿐이었다.
 * 순위도 필터도 바뀌지 않았다.
 *
 * 여행자에게 필요한 것은 "지금 비가 오는가"가 아니라 **"내가 거기 있을 동안 비가
 * 오는가"**다. 실측(2026-08-05 14시 발표)에서 서울시청 격자는 앞으로 4일간 강수
 * 확률이 0%였지만 남쪽 20km 격자는 17시와 19시에 60%·소나기였다. 지금 하늘만
 * 보면 두 곳이 같아 보인다.
 *
 * 이 파일이 하지 않는 것:
 * - **순위를 바꾸지 않는다.** 감점으로 넣어 봤지만 임계값(강수확률 30·60%,
 *   기온 33℃)이 실측으로 조정한 값이 아니어서 되돌렸다. 검증되지 않은 숫자를
 *   순위에 박아 넣으면 사용자는 왜 이 순서인지 알 수 없고 우리도 방어할 수 없다.
 *   예보를 그대로 보여 주고 판단은 사용자가 한다.
 * - 확률을 단정으로 바꾸지 않는다. 60%는 40%의 경우 비가 오지 않는다는 뜻이다.
 * - 예보 슬롯이 없으면 판정하지 않는다. `unknown`을 돌려주고 그 사실을 밝힌다.
 */

export type StayWeather =
  | {
      status: "unknown";
      reason: string;
    }
  | {
      status: "dry" | "rain_likely" | "rain_possible";
      /* 체류 구간에 걸친 슬롯 수. 0이면 status가 unknown이다. */
      slotsChecked: number;
      maxPrecipitationProbabilityPercent: number;
      /* 강수 형태가 있는 첫 슬롯 시각. 예보에 형태가 없으면 비어 있다. */
      precipitationStartsAt?: string;
      precipitationKind?: PrecipitationKind;
      maxTemperatureCelsius?: number;
      minTemperatureCelsius?: number;
      maxWindSpeedKph?: number;
    };

export type PrecipitationKind = "비" | "비/눈" | "눈" | "소나기";

const PRECIPITATION_KIND: Record<number, PrecipitationKind> = {
  1: "비",
  2: "비/눈",
  3: "눈",
  4: "소나기",
};

/* 판정 경계.
   `rain_likely`는 우산 없이 나가면 젖을 가능성이 실질적인 수준, `rain_possible`은
   확률이 낮지 않지만 단정할 수 없는 수준이다. 기상청 강수확률은 10% 단위로
   오므로 경계를 그 단위에 맞춘다. */
const LIKELY_PROBABILITY = 60;
const POSSIBLE_PROBABILITY = 30;

export function summariseStayWeather(
  evidence: WeatherEvidence | undefined,
  stayStart: Date,
  stayEnd: Date,
): StayWeather {
  if (!evidence || evidence.status !== "available") {
    return {
      status: "unknown",
      reason: "기상 예보를 확인하지 못했습니다.",
    };
  }
  if (!evidence.forecast.length) {
    return {
      status: "unknown",
      reason: "시간별 예보를 받지 못해 체류 시간대는 판정하지 않았습니다.",
    };
  }

  const startMs = stayStart.getTime();
  const endMs = stayEnd.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return {
      status: "unknown",
      reason: "체류 시간을 계산하지 못했습니다.",
    };
  }

  /* 예보는 정시 단위다. 체류가 14:30~15:30이면 14시와 15시 슬롯이 모두 걸린다.
     구간을 정시로 확장해 잡는다 — 걸치는 슬롯을 빠뜨리면 비가 시작되는 시각을
     놓친다. */
  const HOUR_MS = 60 * 60 * 1000;
  const windowStart = startMs - HOUR_MS + 1;
  const covered = evidence.forecast.filter((slot) => {
    const at = Date.parse(slot.at);
    return Number.isFinite(at) && at >= windowStart && at <= endMs;
  });

  if (!covered.length) {
    return {
      status: "unknown",
      reason:
        "체류 시간대가 예보 범위를 벗어나 그 시간의 날씨는 판정하지 않았습니다.",
    };
  }

  let maxProbability = 0;
  let precipitationStartsAt: string | undefined;
  let precipitationKind: PrecipitationKind | undefined;
  const temperatures: number[] = [];
  const winds: number[] = [];

  for (const slot of covered) {
    if (slot.precipitationProbabilityPercent !== undefined) {
      maxProbability = Math.max(
        maxProbability,
        slot.precipitationProbabilityPercent,
      );
    }
    if (
      slot.precipitationType !== undefined &&
      slot.precipitationType > 0 &&
      !precipitationStartsAt
    ) {
      precipitationStartsAt = slot.at;
      precipitationKind = PRECIPITATION_KIND[slot.precipitationType];
    }
    if (slot.temperatureCelsius !== undefined) {
      temperatures.push(slot.temperatureCelsius);
    }
    if (slot.windSpeedKph !== undefined) winds.push(slot.windSpeedKph);
  }

  /* 강수 형태가 예보된 시각이 있으면 확률과 무관하게 최소 `rain_possible`이다.
     형태는 확률보다 강한 신호다. */
  const status =
    maxProbability >= LIKELY_PROBABILITY ||
    (precipitationStartsAt && maxProbability >= POSSIBLE_PROBABILITY)
      ? "rain_likely"
      : maxProbability >= POSSIBLE_PROBABILITY || precipitationStartsAt
        ? "rain_possible"
        : "dry";

  return {
    status,
    slotsChecked: covered.length,
    maxPrecipitationProbabilityPercent: maxProbability,
    precipitationStartsAt,
    precipitationKind,
    maxTemperatureCelsius: temperatures.length
      ? Math.max(...temperatures)
      : undefined,
    minTemperatureCelsius: temperatures.length
      ? Math.min(...temperatures)
      : undefined,
    maxWindSpeedKph: winds.length ? Math.max(...winds) : undefined,
  };
}

/* 기온이 야외 활동에 부담이 되는 수준인가.
 *
 * 이 판정은 **점수를 바꾸는 데 쓰지 않는다.** 카드 문장에만 쓴다 — 사용자가
 * 더위나 추위를 조건으로 고르지 않았는데 우리가 대신 실내를 선호하면 사용자가
 * 준 조건을 알리지 않고 조이는 것이다. 판단할 근거는 주고, 고르는 것은
 * 사용자다.
 *
 * 경계는 기상청·질병관리청의 폭염·한파 주의보 기준을 참고했다. 체감온도가
 * 아니라 기온이므로 단정하지 않고 "부담이 될 수 있다"로만 말한다. */
export const OUTDOOR_HEAT_CELSIUS = 33;
export const OUTDOOR_COLD_CELSIUS = -12;

export function outdoorTemperatureStrain(
  stay: StayWeather,
): { kind: "heat" | "cold"; celsius: number } | undefined {
  if (stay.status === "unknown") return undefined;
  if (
    stay.maxTemperatureCelsius !== undefined &&
    stay.maxTemperatureCelsius >= OUTDOOR_HEAT_CELSIUS
  ) {
    return { kind: "heat", celsius: stay.maxTemperatureCelsius };
  }
  if (
    stay.minTemperatureCelsius !== undefined &&
    stay.minTemperatureCelsius <= OUTDOOR_COLD_CELSIUS
  ) {
    return { kind: "cold", celsius: stay.minTemperatureCelsius };
  }
  return undefined;
}

/* 시점별 날씨 한 줄 — 아이콘으로 보여 줄 최소 정보.
 *
 * 기상청에는 **30분 단위 예보가 없다.** 단기예보(`getVilageFcst`)와
 * 초단기예보(`getUltraSrtFcst`) 모두 1시간 간격이다(실측: 단기 66~83슬롯,
 * 초단기 6슬롯, 둘 다 정시). 그래서 "30분 후"라고 적을 수 없다 — 정시 슬롯을
 * 30분 후라고 표기하면 없는 정밀도를 주장하는 것이다. 상대 시각으로 표기한다.
 *
 * 이 값은 **순위에 쓰지 않는다.** 지정 여행지와 대안을 같은 시점으로 나란히
 * 놓아 사용자가 직접 비교하게 하는 것이 목적이다. */
export type WeatherGlanceSlot = {
  /* 기준 시각으로부터 몇 시간 뒤인가. 0은 지금. */
  hoursAhead: number;
  at: string;
  /* 화면이 아이콘을 고르는 데 쓰는 값. 우리가 아이콘 문자를 정하지 않는다 —
     표현은 화면의 일이고, 여기서는 판정 근거만 넘긴다. */
  precipitationType?: number;
  skyCode?: number;
  precipitationProbabilityPercent?: number;
  temperatureCelsius?: number;
};

export const GLANCE_HOURS_AHEAD = [0, 1, 2] as const;

export function weatherGlance(
  evidence: WeatherEvidence | undefined,
  from: Date,
): WeatherGlanceSlot[] {
  if (!evidence || evidence.status !== "available") return [];
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) return [];
  const HOUR_MS = 60 * 60 * 1000;

  const slots: WeatherGlanceSlot[] = [];

  /* "지금" 칸은 **예보가 아니라 실황**으로 만든다.
     23시 발표 단기예보는 00:00부터 시작하므로 현재 시각 이하의 슬롯이 없는
     때가 있다. 예보 슬롯이 있어야만 지금을 그리면 밤에는 이 칸이 비어 버린다.
     실황은 매시 발표되고 관측값이므로 예보보다 정확하기도 하다. */
  const nowSlot: WeatherGlanceSlot = {
    hoursAhead: 0,
    at: evidence.observedAt,
    precipitationType:
      evidence.observedPrecipitationType ??
      /* 원시 코드가 없는 공급자(대체 경로)에서는 강수 유무만 옮긴다. 형태를
         아는 것처럼 적지 않는다. */
      (evidence.raining ? 1 : undefined),
    skyCode: evidence.observedSkyCode,
    precipitationProbabilityPercent: evidence.precipitationProbabilityPercent,
    temperatureCelsius: evidence.temperatureCelsius,
  };
  slots.push(nowSlot);

  for (const hoursAhead of GLANCE_HOURS_AHEAD) {
    if (hoursAhead === 0) continue;
    const targetMs = fromMs + hoursAhead * HOUR_MS;
    /* 그 시각을 담는 정시 슬롯을 찾는다. 예보 값은 해당 시간대를 가리키므로
       목표 시각 이하의 가장 늦은 슬롯이 맞다. 없으면 목표 시각 **이후**의 가장
       이른 슬롯을 쓰되 1시간 이내일 때만 — 23시 발표 예보가 00:00부터
       시작하는 경우가 그렇다. */
    let chosen: (typeof evidence.forecast)[number] | undefined;
    for (const slot of evidence.forecast) {
      const at = Date.parse(slot.at);
      if (!Number.isFinite(at) || at > targetMs) continue;
      if (!chosen || at > Date.parse(chosen.at)) chosen = slot;
    }
    if (!chosen) {
      for (const slot of evidence.forecast) {
        const at = Date.parse(slot.at);
        if (!Number.isFinite(at) || at <= targetMs) continue;
        if (at - targetMs >= HOUR_MS) continue;
        if (!chosen || at < Date.parse(chosen.at)) chosen = slot;
      }
    }
    /* 예보 범위를 벗어나면 그 시점은 비운다. 가장 가까운 값을 끌어다 쓰면
       없는 근거를 만드는 것이다. */
    if (!chosen) continue;
    const chosenMs = Date.parse(chosen.at);
    if (Math.abs(targetMs - chosenMs) >= HOUR_MS * 2) continue;
    slots.push({
      hoursAhead,
      at: chosen.at,
      precipitationType: chosen.precipitationType,
      skyCode: chosen.skyCode,
      precipitationProbabilityPercent: chosen.precipitationProbabilityPercent,
      temperatureCelsius: chosen.temperatureCelsius,
    });
  }

  return slots;
}
