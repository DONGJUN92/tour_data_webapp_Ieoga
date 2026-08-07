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

test("날씨는 순위에 쓰지 않는다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 감점으로 넣어 봤지만 임계값(강수확률 30·60%, 기온 33℃)이 실측으로 조정한
     값이 아니었다. 검증되지 않은 숫자를 순위에 박아 넣으면 사용자는 왜 이
     순서인지 알 수 없고 우리도 방어할 수 없다. 예보를 그대로 보여 주고 판단은
     사용자가 한다. */
  assert.ok(
    !/stayWeatherPenalty/.test(engine),
    "날씨 감점이 다시 순위에 들어갔다",
  );
  assert.match(engine, /baseScore: Math\.round\(baseScore \* 10\) \/ 10,/);
  /* 우천 상황을 고른 요청의 실내 선호는 그대로여야 한다 — 그것은 사용자가
     직접 선언한 조건이고, 감점을 빼도 잃지 않는다. */
  const rainBranch = engine.slice(
    engine.indexOf('if (input.incident === "rain") {'),
    engine.indexOf('} else if (input.incident === "crowd") {'),
  );
  assert.match(rainBranch, /indoorScore \* 0\.25/);
  /* 후보를 날씨로 탈락시키지도 않는다. */
  assert.ok(
    !/stayWeather[\s\S]{0,200}rejected\.push/.test(engine),
    "날씨로 후보를 탈락시키고 있다",
  );
});

test("시점별 아이콘용 값을 30분 단위라고 말하지 않는다", async () => {
  const { weatherGlance, GLANCE_HOURS_AHEAD } = await import(
    "../lib/weather/window.ts"
  );
  /* 기상청에는 30분 단위 예보가 없다 — 단기예보와 초단기예보 모두 정시
     슬롯이다(실측 확인). 정시 값을 "30분 후"라고 적으면 없는 정밀도를
     주장하는 것이다. */
  assert.deepEqual([...GLANCE_HOURS_AHEAD], [0, 1, 2]);
  const now = new Date("2026-08-05T14:20:00+09:00");
  const slots = weatherGlance(
    evidence([
      slot("2026-08-05T14:00:00+09:00", {
        precipitationProbabilityPercent: 0,
        skyCode: 1,
        temperatureCelsius: 34,
      }),
      slot("2026-08-05T15:00:00+09:00", {
        precipitationProbabilityPercent: 60,
        precipitationType: 4,
        temperatureCelsius: 33,
      }),
      slot("2026-08-05T16:00:00+09:00", {
        precipitationProbabilityPercent: 30,
        skyCode: 4,
        temperatureCelsius: 32,
      }),
    ]),
    now,
  );
  assert.equal(slots.length, 3);
  assert.deepEqual(
    slots.map((entry) => entry.hoursAhead),
    [0, 1, 2],
  );
  /* "지금"은 예보가 아니라 실황이다 — 23시 발표 예보는 00:00부터 시작하므로
     예보 슬롯이 있어야만 지금을 그리면 밤에 이 칸이 비어 버린다. */
  assert.equal(slots[0].at, "2026-08-05T05:00:00.000Z");
  assert.equal(slots[1].precipitationType, 4);
  assert.equal(slots[2].skyCode, 4);
});

test("지금 시점은 예보보다 실황을 쓴다", async () => {
  const { weatherGlance } = await import("../lib/weather/window.ts");
  const base = evidence([
    slot("2026-08-05T14:00:00+09:00", {
      precipitationProbabilityPercent: 0,
      skyCode: 1,
      temperatureCelsius: 30,
    }),
  ]);
  base.temperatureCelsius = 36.8;
  base.raining = true;
  const slots = weatherGlance(base, new Date("2026-08-05T14:20:00+09:00"));
  /* 실황이 비를 보고 있으면 예보 슬롯의 0을 따르지 않는다. 형태는 모르므로
     비(1)로만 표시하고 소나기 같은 단정은 하지 않는다. */
  assert.equal(slots[0].temperatureCelsius, 36.8);
  assert.equal(slots[0].precipitationType, 1);
});

test("예보 범위를 벗어난 시점은 비워 둔다", async () => {
  const { weatherGlance } = await import("../lib/weather/window.ts");
  /* 가장 가까운 값을 끌어다 쓰면 없는 근거를 만드는 것이다. */
  const slots = weatherGlance(
    evidence([
      slot("2026-08-05T14:00:00+09:00", { precipitationProbabilityPercent: 0 }),
    ]),
    new Date("2026-08-05T14:20:00+09:00"),
  );
  /* "지금"은 실황에서 오므로 항상 있다. 예보가 닿지 않는 시점만 빈다. */
  assert.deepEqual(
    slots.map((entry) => entry.hoursAhead),
    [0, 1],
    "2시간 후 슬롯이 없는데 값을 만들어 냈다",
  );
  assert.equal(weatherGlance(undefined, new Date()).length, 0);
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

test("정렬 축은 값이 있는 후보만 줄 세우고 없는 후보는 따로 내린다", async () => {
  const { OPTION_SORTS, sortOptionsByCrowd } = await import(
    "../app/product-app-model.ts"
  );
  /* 측정하면 집중률 예측을 가진 후보는 유형별로 관광지 25~36%, 문화시설
     0~26%, 음식점·레포츠 0%다. 즉 값이 없는 후보가 다수다. 중립값으로 한
     목록에 섞으면 "왜 이 위치인가"를 설명할 수 없다. */
  assert.deepEqual(
    OPTION_SORTS.map((entry) => entry.value),
    [
      "recommended",
      "quiet_first",
      "busy_first",
      "nearest_first",
      "open_first",
    ],
  );
  const options = [
    { id: "a", title: "붐빔", crowd: { relativeRate: 80 } },
    { id: "b", title: "없음1" },
    { id: "c", title: "한적", crowd: { relativeRate: 20 } },
    { id: "d", title: "없음2" },
    { id: "e", title: "중간", crowd: { relativeRate: 50 } },
  ];

  const recommended = sortOptionsByCrowd(options, "recommended");
  assert.deepEqual(
    recommended.ranked.map((o) => o.id),
    ["a", "b", "c", "d", "e"],
    "추천순은 원래 순서를 그대로 두어야 한다",
  );
  assert.deepEqual(recommended.unranked, []);

  const quiet = sortOptionsByCrowd(options, "quiet_first");
  assert.deepEqual(quiet.ranked.map((o) => o.id), ["c", "e", "a"]);
  assert.deepEqual(quiet.unranked.map((o) => o.id), ["b", "d"]);

  const busy = sortOptionsByCrowd(options, "busy_first");
  assert.deepEqual(busy.ranked.map((o) => o.id), ["a", "e", "c"]);
  assert.deepEqual(busy.unranked.map((o) => o.id), ["b", "d"]);

  /* 같은 값이면 원래 순서를 유지해야 한다 — 흔들리면 같은 화면을 다시 볼
     때마다 카드가 움직인다. */
  const tied = sortOptionsByCrowd(
    [
      { id: "x", crowd: { relativeRate: 40 } },
      { id: "y", crowd: { relativeRate: 40 } },
      { id: "z", crowd: { relativeRate: 40 } },
    ],
    "quiet_first",
  );
  assert.deepEqual(tied.ranked.map((o) => o.id), ["x", "y", "z"]);
});

test("정렬 컨트롤은 줄 세울 값이 2개 이상일 때만 나온다", async () => {
  const product = await src("../app/ProductApp.tsx");
  /* 후보가 둘 이상이면 정렬을 준다. 운영 여부는 모든 후보에 값이 있으므로
     집중률이 없어도 쓸 수 있다. */
  assert.match(product, /\{recovery\.options\.length >= 2 && \(/);
  /* 방향을 라벨에 적어 어느 쪽도 오해하지 않게 한다. */
  const model = await src("../app/product-app-model.ts");
  assert.match(model, /ko: "한적한 순"/);
  assert.match(model, /ko: "붐비는 순"/);
  assert.match(model, /집중률 예측이 낮은 곳부터 봅니다/);
  assert.match(model, /집중률 예측이 높은 곳부터 봅니다/);
  /* 값이 없는 묶음에 "더 나쁜 곳"이라는 뜻이 실리지 않게 한다. */
  assert.match(product, /더 나쁜 곳이라는 뜻이 아니라 측정되지 않았다는 뜻입니다/);
});

test("기준 지점과 대안을 같은 시점으로 나란히 놓는다", async () => {
  const product = await src("../app/ProductApp.tsx");
  const engine = await src("../lib/recovery/engine.ts");
  /* 비교 대상이 없으면 대안의 날씨만 보고 "여기가 나은가"를 판단할 수 없다. */
  assert.match(engine, /originWeatherGlance:/);
  assert.match(engine, /originWeatherLabel:/);
  assert.match(product, /isBaseline/);
  assert.match(product, /원래 가려던 곳 ·/);
  assert.match(product, /이 곳 ·/);
  /* 기준 시각은 후보의 체류 시작이 아니라 "지금"이어야 한다 — 후보마다
     체류 시작이 달라 그것을 기준으로 하면 카드 간 시점이 어긋난다. */
  assert.match(engine, /const glance = weatherGlance\(weatherEvidence, new Date\(\)\)/);

  /* 아이콘만 있으면 스크린리더 사용자는 이 줄을 전혀 쓸 수 없다. */
  const strip = await src("../app/WeatherGlanceStrip.tsx");
  assert.match(strip, /aria-label=\{`\$\{label\}: \$\{spoken\}`\}/);
  assert.match(strip, /<ul aria-hidden="true">/);
  /* 예보를 못 받았으면 빈 칸을 그리지 않는다. */
  assert.match(strip, /if \(!slots\.length\) return null;/);
});

test("예보가 현재 시각 이후부터 시작해도 지금 칸이 비지 않는다", async () => {
  const { weatherGlance } = await import("../lib/weather/window.ts");
  /* 23시 발표 단기예보는 00:00부터 시작한다. 실측에서 이 때문에 "지금" 칸이
     통째로 비었다. 실황은 매시 발표되는 관측값이므로 그것으로 만든다. */
  const base = evidence([
    slot("2026-08-06T00:00:00+09:00", {
      precipitationProbabilityPercent: 0,
      skyCode: 1,
      temperatureCelsius: 29,
    }),
    slot("2026-08-06T01:00:00+09:00", {
      precipitationProbabilityPercent: 0,
      skyCode: 1,
      temperatureCelsius: 29,
    }),
  ]);
  base.temperatureCelsius = 30.2;
  base.observedSkyCode = 3;
  base.observedPrecipitationType = 0;
  const slots = weatherGlance(base, new Date("2026-08-05T23:15:00+09:00"));
  assert.deepEqual(
    slots.map((entry) => entry.hoursAhead),
    [0, 1, 2],
  );
  assert.equal(slots[0].temperatureCelsius, 30.2);
  assert.equal(slots[0].skyCode, 3, "지금 칸이 실황의 하늘상태를 쓰지 않았다");
  /* 1시간 후(00:15)에 가장 가까운 슬롯은 00:00이다. */
  assert.equal(slots[1].at, "2026-08-06T00:00:00+09:00");
});

test("운영 여부 정렬은 닫힌 곳을 지우지 않고 맨 아래로 보낸다", async () => {
  const { sortOptionsByCrowd } = await import("../app/product-app-model.ts");
  /* 닫힌 곳도 30분 뒤에 열릴 수 있고, 근처에 있다는 사실 자체가 판단에
     쓰인다. 우리가 지우면 그 판단 기회를 없앤다. */
  const options = [
    { id: "closed", availability: { status: "confirmed_closed" } },
    { id: "unknown", availability: { status: "official_hours_unstructured" } },
    { id: "open", availability: { status: "confirmed_open" } },
    { id: "none" },
  ];
  const sorted = sortOptionsByCrowd(options, "open_first");
  assert.deepEqual(
    sorted.ranked.map((o) => o.id),
    ["open", "unknown", "none", "closed"],
  );
  /* 운영 여부는 모두에게 값이 있으므로 따로 내릴 묶음이 없다. */
  assert.deepEqual(sorted.unranked, []);
});

test("위치 직접 입력이 탭을 바꾸지 않고 제자리에서 열린다", async () => {
  const panel = await src("../app/DiscoverWindowPanel.tsx");
  const product = await src("../app/ProductApp.tsx");
  /* 예전에는 `onManualLocation={() => changeTab("recover")}`이었다. 버튼을
     눌렀더니 다른 화면에 와 있고, 지금 하려던 일과 입력한 조건이 함께
     사라졌다. */
  assert.ok(
    !/onManualLocation=\{\(\) => changeTab\("recover"\)\}/.test(product),
    "직접 입력이 다시 탭을 바꾼다",
  );
  assert.match(panel, /const \[manualOpen, setManualOpen\] = useState\(false\)/);
  assert.match(panel, /<ManualLocationPicker/);
  /* 고른 위치를 그 자리에서 받아 좌표·행정구역까지 채운다. */
  assert.match(product, /onManualLocation=\{\(place: ManualPlace\) => \{/);
  assert.match(product, /setAreaCode\(place\.areaCode \?\? ""\)/);
  assert.match(product, /setSigunguCode\(place\.sigunguCode \?\? ""\)/);
});

test("장소명을 몰라도 시·군·구로 위치를 정할 수 있다", async () => {
  const picker = await src("../app/ManualLocationPicker.tsx");
  const product = await src("../app/ProductApp.tsx");
  /* 여행 중에는 지금 서 있는 곳의 이름을 모르는 일이 흔하다. 장소명만
     요구하면 그때 아무것도 할 수 없다. */
  assert.match(picker, /\/api\/v1\/regions"/);
  assert.match(picker, /\/api\/v1\/regions\/\$\{regionCode\}\/districts`/);
  assert.match(picker, /data-testid="manual-picker-region"/);
  assert.match(picker, /data-testid="manual-picker-district"/);
  /* 행정구역 코드는 검색 결과가 아니라 사용자가 고른 값을 쓴다. */
  assert.match(picker, /areaCode: regionCode,\s*\n\s*sigunguCode: districtCode,/);
  /* 구 전체를 대표하는 근사 지점임을 밝힌다. */
  assert.match(picker, /정확한 현재 위치가 아니라 그 구 일대라는 뜻입니다/);
  /* 두 탭이 같은 컴포넌트를 쓴다. */
  assert.match(product, /<ManualLocationPicker/);
});

test("가까운 순 정렬은 거리로 줄 세우고 값 없는 후보를 지우지 않는다", async () => {
  const { OPTION_SORTS, sortOptionsByCrowd } = await import(
    "../app/product-app-model.ts"
  );
  assert.deepEqual(
    OPTION_SORTS.map((entry) => entry.value),
    [
      "recommended",
      "quiet_first",
      "busy_first",
      "nearest_first",
      "open_first",
    ],
  );
  const options = [
    { id: "far", distanceMeters: 4200 },
    { id: "none" },
    { id: "near", distanceMeters: 800 },
    { id: "mid", distanceMeters: 2100 },
  ];
  const sorted = sortOptionsByCrowd(options, "nearest_first");
  assert.deepEqual(
    sorted.ranked.map((o) => o.id),
    ["near", "mid", "far", "none"],
    "거리 값이 없는 후보는 뒤로 보내되 지우지 않는다",
  );
  assert.deepEqual(sorted.unranked, []);
});

test("모바일과 데스크톱이 같은 탭을 가리킨다", async () => {
  const product = await src("../app/ProductApp.tsx");
  /* 예전에는 모바일 하단 바가 `/flow`·`/policy`·`/sources` 세 라우트로 갔고
     탭 바는 821px 미만에서 숨겨져 있었다. 그래서 휴대폰에서는 `지금 갈 곳
     찾기`로 갈 방법이 아예 없었고, 여행자 화면에서 뺀 `지역 회복력`이 하단에
     남아 있었다. 화면 크기에 따라 있는 기능이 달라지면 그건 다른 앱이다. */
  const nav = product.slice(
    product.indexOf('className="mobile-nav"'),
    product.indexOf("<footer className=\"product-footer\">"),
  );
  assert.ok(nav.length > 0 && nav.length < 3000, "모바일 내비를 찾지 못했다");
  /* 삭제한 탭이 하단에 남아 있으면 안 된다. */
  assert.ok(
    !/지역 회복력/.test(nav),
    "여행자 화면에서 뺀 탭이 모바일 하단 바에 남아 있다",
  );
  /* 라우트 링크가 아니라 탭 전환이어야 한다. */
  assert.ok(!/<a href="\/policy">/.test(nav), "모바일 내비가 라우트로 나간다");
  for (const testid of ["mobile-nav-recover", "mobile-nav-discover"]) {
    assert.match(nav, new RegExp(`data-testid="${testid}"`), `${testid} 없음`);
  }
  assert.match(nav, /지금 갈 곳 찾기/);
  assert.match(nav, /changeTab\("discover"\)/);
  /* 지금 어느 탭인지 하단 바에도 드러나야 한다. */
  assert.match(nav, /activeTab === "discover" \? "is-active" : ""/);
  assert.ok(
    !/데이터 투명성/.test(nav),
    "데이터 투명성이 아직 모바일 하단 바에 있다",
  );
  assert.match(nav, /aria-current=\{activeTab === "recover" \? "page" : undefined\}/);

  /* 두 내비의 항목이 정확히 같아야 한다. */
  const tabBar = product.slice(
    product.indexOf('className="desktop-nav"'),
    product.indexOf('<div className="header-actions">'),
  );
  /* 데이터 투명성은 두 내비 모두에서 빠지고 하단 메뉴로 갔다 — 그것도
     "같아야 한다"의 일부다. */
  for (const label of ["여행 복구", "지금 갈 곳 찾기"]) {
    assert.ok(tabBar.includes(label), `데스크톱 탭에 ${label} 없음`);
    assert.ok(nav.includes(label), `모바일 내비에 ${label} 없음`);
  }
});
