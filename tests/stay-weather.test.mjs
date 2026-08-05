import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 지정과제 1번의 실시간 변수 중 **날씨 변화**를 실제 판정에 쓰기 위한 계약.
 *
 * 배경 — 라이브 측정으로 확인한 것들:
 * - `getKmaObservation`은 실황과 단기예보를 **함께 호출한다.** 단기예보 응답은
 *   798항목 / **66개 시간슬롯**(지금~+4일)이다.
 * - 그런데 첫 슬롯의 POP과 SKY만 읽고 약 790개 값을 버렸다. 그 결과 날씨가
 *   판정에 쓰이는 곳은 "사용자가 우천을 골랐는데 API는 비를 못 봤다"는 경고
 *   문장 **한 곳**뿐이었고 순위·필터를 바꾸지 않았다.
 * - 기온·풍속은 코드 어디에서도 읽지 않았다(측정 당시 서울 37℃).
 * - 출발지 한 점만 조회했다. KMA 격자는 약 5km이고 앱 기본 반경은 도보 8km,
 *   대중교통·자차 20km다. 같은 시각 서울시청 격자는 강수확률 0%인데 남쪽 20km
 *   격자는 17시·19시에 60%·소나기였다(최대 60포인트 차이). */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

function slot(at, extra = {}) {
  return { at, ...extra };
}

function evidence(slots) {
  return {
    status: "available",
    observedAt: "2026-08-05T05:00:00.000Z",
    temperatureCelsius: 30,
    apparentTemperatureCelsius: 30,
    precipitationMillimeters: 0,
    weatherCode: 0,
    windSpeedKph: 3,
    raining: false,
    provider: "kma_short_term",
    attribution: "기상자료: 기상청 단기예보 (공공누리 제1유형)",
    forecast: slots,
  };
}

test("단기예보 시계열을 슬롯으로 모은다", async () => {
  const kma = await src("../lib/weather/kma.ts");
  /* 첫 슬롯만 읽던 코드가 남아 있으면 다시 790개 값을 버린다. */
  assert.match(kma, /export type KmaForecastSlot = \{/);
  assert.match(kma, /const slotMap = new Map<string, KmaForecastSlot>\(\)/);
  for (const category of ["POP", "PTY", "PCP", "TMP", "SKY", "WSD", "REH"]) {
    assert.match(
      kma,
      new RegExp(`case "${category}":`),
      `${category} 카테고리를 읽지 않는다`,
    );
  }
  /* 798항목을 300으로 받으면 뒷부분 슬롯이 잘린다. */
  assert.match(kma, /numOfRows = 300,/);
  assert.match(kma, /options\.signal,\s*\n\s*\/\*[\s\S]*?\*\/\s*\n\s*1_000,/);
  /* 시각은 KST 오프셋을 문자열에 박아 둔다. Date로 파싱하면 그 정보가 사라진다. */
  assert.match(kma, /:00\+09:00`;/);
});

test("시계열을 못 만들어도 예전에 얻던 값을 잃지 않는다", async () => {
  const kma = await src("../lib/weather/kma.ts");
  /* 실제 기상청은 항상 시각을 주지만, 없는 응답에서 강수확률까지 잃으면
     시계열을 추가하다 기존 기능을 깬 것이 된다. */
  assert.match(kma, /const firstCategoryValue = \(category: string\)/);
  assert.match(kma, /\?\?\s*\n?\s*firstCategoryValue\("POP"\)/);
  assert.match(kma, /\?\?\s*\n?\s*firstCategoryValue\("SKY"\)/);
});

test("체류 시간대에 걸치는 슬롯을 빠뜨리지 않는다", async () => {
  const { summariseStayWeather } = await import("../lib/weather/window.ts");
  /* 체류가 14:30~15:30이면 14시와 15시 슬롯이 모두 걸린다. 정시로 확장하지
     않으면 14시 슬롯을 놓쳐 비가 시작되는 시각을 잃는다. */
  const stay = summariseStayWeather(
    evidence([
      slot("2026-08-05T14:00:00+09:00", {
        precipitationProbabilityPercent: 60,
        precipitationType: 4,
      }),
      slot("2026-08-05T15:00:00+09:00", {
        precipitationProbabilityPercent: 20,
      }),
    ]),
    new Date("2026-08-05T14:30:00+09:00"),
    new Date("2026-08-05T15:30:00+09:00"),
  );
  assert.equal(stay.status, "rain_likely");
  assert.equal(stay.slotsChecked, 2);
  assert.equal(stay.maxPrecipitationProbabilityPercent, 60);
  assert.equal(stay.precipitationStartsAt, "2026-08-05T14:00:00+09:00");
  assert.equal(stay.precipitationKind, "소나기");
});

test("체류 시간대 밖의 비는 판정에 넣지 않는다", async () => {
  const { summariseStayWeather } = await import("../lib/weather/window.ts");
  /* "지금 비가 오는가"가 아니라 "내가 거기 있을 동안"이다. 체류가 끝난 뒤의
     비로 후보를 깎으면 근거 없이 불리하게 만드는 것이다. */
  const stay = summariseStayWeather(
    evidence([
      slot("2026-08-05T10:00:00+09:00", { precipitationProbabilityPercent: 0 }),
      slot("2026-08-05T11:00:00+09:00", { precipitationProbabilityPercent: 0 }),
      slot("2026-08-05T20:00:00+09:00", {
        precipitationProbabilityPercent: 90,
        precipitationType: 1,
      }),
    ]),
    new Date("2026-08-05T10:00:00+09:00"),
    new Date("2026-08-05T11:00:00+09:00"),
  );
  assert.equal(stay.status, "dry");
  assert.equal(stay.maxPrecipitationProbabilityPercent, 0);
  assert.equal(stay.precipitationStartsAt, undefined);
});

test("예보가 없으면 판정하지 않고 그 사실을 남긴다", async () => {
  const { summariseStayWeather } = await import("../lib/weather/window.ts");
  assert.equal(summariseStayWeather(undefined, new Date(), new Date()).status, "unknown");
  assert.equal(summariseStayWeather(evidence([]), new Date(), new Date()).status, "unknown");
  /* 체류가 예보 범위를 벗어나면 모른다고 해야 한다. 가장 가까운 슬롯을
     끌어다 쓰면 없는 근거를 만드는 것이다. */
  const outside = summariseStayWeather(
    evidence([slot("2026-08-05T10:00:00+09:00", { precipitationProbabilityPercent: 80 })]),
    new Date("2026-08-09T10:00:00+09:00"),
    new Date("2026-08-09T11:00:00+09:00"),
  );
  assert.equal(outside.status, "unknown");
  assert.match(outside.reason, /예보 범위를 벗어나/);
});

test("강수 형태는 확률보다 강한 신호로 다룬다", async () => {
  const { summariseStayWeather } = await import("../lib/weather/window.ts");
  /* PTY가 예보된 시각이 있으면 확률이 낮아도 최소 `rain_possible`이다. */
  const typed = summariseStayWeather(
    evidence([
      slot("2026-08-05T14:00:00+09:00", {
        precipitationProbabilityPercent: 10,
        precipitationType: 1,
      }),
    ]),
    new Date("2026-08-05T14:00:00+09:00"),
    new Date("2026-08-05T14:30:00+09:00"),
  );
  assert.equal(typed.status, "rain_possible");
  /* 확률만 60% 이상이면 그것으로도 likely다. */
  const likely = summariseStayWeather(
    evidence([
      slot("2026-08-05T14:00:00+09:00", { precipitationProbabilityPercent: 70 }),
    ]),
    new Date("2026-08-05T14:00:00+09:00"),
    new Date("2026-08-05T14:30:00+09:00"),
  );
  assert.equal(likely.status, "rain_likely");
});

test("기온 부담은 실측 경계로 판정한다", async () => {
  const { outdoorTemperatureStrain, summariseStayWeather, OUTDOOR_HEAT_CELSIUS } =
    await import("../lib/weather/window.ts");
  const hot = summariseStayWeather(
    evidence([
      slot("2026-08-05T14:00:00+09:00", {
        precipitationProbabilityPercent: 0,
        temperatureCelsius: 37,
      }),
    ]),
    new Date("2026-08-05T14:00:00+09:00"),
    new Date("2026-08-05T14:30:00+09:00"),
  );
  assert.equal(hot.maxTemperatureCelsius, 37);
  assert.deepEqual(outdoorTemperatureStrain(hot), { kind: "heat", celsius: 37 });
  assert.ok(OUTDOOR_HEAT_CELSIUS >= 33, "폭염 경계가 느슨해졌다");
  /* 판정 불가는 부담 없음과 다르다. */
  assert.equal(
    outdoorTemperatureStrain({ status: "unknown", reason: "x" }),
    undefined,
  );
});

test("날씨는 후보를 제거하지 않고 순위와 문장에만 쓴다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 강수확률 60%는 40%의 경우 비가 오지 않는다. 제거하면 갈 수 있었던 곳을
     잃는다. 이 제품은 하드 필터 대신 순위와 문장을 택해 왔다. */
  assert.match(engine, /const stayWeatherPenalty = \(\(\) => \{/);
  assert.match(engine, /if \(stay\.status === "rain_likely"\) return 9;/);
  assert.match(engine, /if \(stay\.status === "rain_possible"\) return 4;/);
  assert.ok(
    !/stayWeather[\s\S]{0,200}rejected\.push/.test(engine),
    "날씨로 후보를 탈락시키고 있다",
  );
  /* 실내 후보에는 감점하지 않는다. */
  assert.match(engine, /stay\.status === "unknown" \|\| candidate\.indoor\) return 0;/);
});

test("모든 상황에서 같은 크기로 반영된다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* `delay`와 `crowd` 분기에는 `indoorScore` 항이 아예 없다. 그 항에 얹으면
     가장 흔한 두 상황에서 날씨가 순위에 들어오지 못하고, 항을 새로 넣으려면
     연속성 가중치를 깎아야 한다 — 이 제품이 지키겠다고 한 것이다. */
  assert.match(engine, /baseScore - stayWeatherPenalty/);
  assert.match(engine, /comfortScore - stayWeatherPenalty/);
  /* `rain` 분기의 `indoorScore`와 이중 계산되지 않아야 한다. */
  const rainBranch = engine.slice(
    engine.indexOf('if (input.incident === "rain") {'),
    engine.indexOf('} else if (input.incident === "crowd") {'),
  );
  assert.ok(
    !/stayWeather/.test(rainBranch),
    "우천 분기가 날씨를 이중으로 계산한다",
  );
});

test("기온은 조건을 밝힌 요청에서만 순위에 반영하고, 문장은 모두에게 보여 준다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 사용자가 더위를 조건으로 고르지 않았는데 우리가 대신 실내를 선호하면
     사용자가 준 조건을 알리지 않고 조이는 것이다. 유아차·휠체어·고령자를
     이미 밝힌 요청은 그 선언이 곧 동의다. */
  assert.match(
    engine,
    /if \(input\.audience !== "general" && outdoorTemperatureStrain\(stay\)\) return 5;/,
  );
  /* 문장 쪽에는 audience 조건이 없어야 한다 — 판단은 사용자가 한다. */
  const whyBlock = engine.slice(
    engine.indexOf("const strain = outdoorTemperatureStrain(stay);"),
  );
  const sentence = whyBlock.slice(0, 900);
  assert.match(sentence, /그늘과 물을 확인해 주세요/);
  assert.ok(
    !/audience/.test(sentence),
    "기온 문장이 특정 동반 조건에서만 보인다",
  );
});

test("실외 후보에만 날씨 문장을 붙인다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 실내에 들어가 있는 동안의 강수는 결정을 바꾸지 않는다. 카드 문장이 늘면
     기존 문장의 신뢰도가 희석된다. */
  assert.match(
    engine,
    /if \(stay && stay\.status !== "unknown" && !candidate\.indoor\) \{/,
  );
  /* "지금"이 아니라 "머무는 시간대"라고 말해야 한다. */
  assert.match(engine, /머무는 시간대에/);
  assert.match(engine, /During your stay/);
  /* 예보를 단정으로 바꾸지 않는다. */
  assert.match(engine, /예보가 확정은 아니니 출발 전에 다시 확인해 주세요/);
});

test("후보 지점의 예보를 따로 가져오고, 못 가져오면 밝힌다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 기상청 격자는 약 5km인데 이 앱의 기본 반경은 도보 8km·대중교통 20km다.
     실측에서 같은 체류 구간에 서울시청 격자는 dry, 남 20km 격자는 rain_likely
     (POP 60%·소나기)였다. 한 점만 보면 두 곳이 같아 보인다. */
  assert.match(engine, /const gridWeather = new Map</);
  assert.match(engine, /const \{ nx, ny \} = toKmaGrid\(candidate\.latitude, candidate\.longitude\)/);
  /* 격자가 같은 후보를 두 번 부르지 않는다. 검증 대상은 3건이므로 추가 호출은
     최대 3회다. */
  assert.match(engine, /const distinctGrids = new Map<string, WorkingCandidate>\(\)/);
  assert.match(engine, /if \(!distinctGrids\.has\(key\)\) distinctGrids\.set\(key, candidate\)/);
  /* 출발지와 같은 격자면 이미 받은 예보를 쓴다. */
  assert.match(engine, /if \(key === `\$\{originGrid\.nx\},\$\{originGrid\.ny\}`\) continue;/);
  /* 실패하면 출발지 예보로 물러서되 그 사실을 밝힌다 — 다른 지점의 예보를
     이 곳의 것처럼 쓰면 안 된다. */
  assert.match(engine, /candidateForecastFallbacks/);
  assert.match(engine, /출발지 예보로 판단했습니다/);
  assert.match(
    engine,
    /gridWeather\.get\(gridKey\(candidate\)\) \?\? weatherEvidence,/,
  );
});
