import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

const { toKmaGrid, ultraShortNowcastBase, villageForecastBase } = await import(
  "../lib/weather/kma.ts"
);
const { getWeatherEvidence } = await import("../lib/weather/service.ts");

/* The agency addresses its forecast grid by Lambert cell, so a wrong
   conversion silently returns weather for the wrong place. These are
   published reference cells. */
test("KMA grid conversion matches published reference cells", () => {
  const cases = [
    { name: "서울 종로구", lat: 37.5729, lon: 126.9793, nx: 60, ny: 127 },
    { name: "제주 제주시", lat: 33.5006, lon: 126.5311, nx: 53, ny: 38 },
    { name: "강원 춘천시", lat: 37.8813, lon: 127.73, nx: 73, ny: 134 },
    { name: "대구 중구", lat: 35.8694, lon: 128.6062, nx: 89, ny: 90 },
  ];
  for (const entry of cases) {
    assert.deepEqual(
      toKmaGrid(entry.lat, entry.lon),
      { nx: entry.nx, ny: entry.ny },
      `${entry.name} grid cell`,
    );
  }
});

test("KMA grid steps one cell per five kilometres", () => {
  const base = toKmaGrid(35.1063, 129.0322);
  assert.deepEqual(toKmaGrid(35.1563, 129.0322), {
    nx: base.nx,
    ny: base.ny + 1,
  });
  assert.deepEqual(toKmaGrid(35.1063, 129.0822), {
    nx: base.nx + 1,
    ny: base.ny,
  });
});

/* 초단기실황 publishes about forty minutes after each hour, so asking for the
   current hour too early returns nothing. */
test("nowcast base time rounds back before the publish minute", () => {
  const before = ultraShortNowcastBase(new Date("2026-07-15T02:20:00+09:00"));
  assert.equal(before.baseDate, "20260715");
  assert.equal(before.baseTime, "0100");

  const after = ultraShortNowcastBase(new Date("2026-07-15T02:45:00+09:00"));
  assert.equal(after.baseDate, "20260715");
  assert.equal(after.baseTime, "0200");
});

test("nowcast base time rolls to the previous day just after midnight", () => {
  const justAfterMidnight = ultraShortNowcastBase(
    new Date("2026-07-15T00:10:00+09:00"),
  );
  assert.equal(justAfterMidnight.baseDate, "20260714");
  assert.equal(justAfterMidnight.baseTime, "2300");
});

test("village forecast base picks the latest announced slot", () => {
  assert.deepEqual(villageForecastBase(new Date("2026-07-15T13:00:00+09:00")), {
    baseDate: "20260715",
    baseTime: "1100",
  });
  /* 14:05 is before the 14:00 slot has published. */
  assert.deepEqual(villageForecastBase(new Date("2026-07-15T14:05:00+09:00")), {
    baseDate: "20260715",
    baseTime: "1100",
  });
  assert.deepEqual(villageForecastBase(new Date("2026-07-15T14:15:00+09:00")), {
    baseDate: "20260715",
    baseTime: "1400",
  });
  /* Before the day's first announcement, yesterday's last one still stands. */
  assert.deepEqual(villageForecastBase(new Date("2026-07-15T01:00:00+09:00")), {
    baseDate: "20260714",
    baseTime: "2300",
  });
});

async function withEnv(env, fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  const previous = {};
  for (const name of Object.keys(env)) previous[name] = process.env[name];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function kmaNowcast(items) {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: { items: { item: items } },
    },
  };
}

test("KMA observation is normalised to the shared weather contract", async () => {
  const calls = [];
  await withEnv(
    { KMA_SERVICE_KEY: "kma-test-key", WEATHER_API_URL: undefined },
    async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("getUltraSrtNcst")) {
        return new Response(
          JSON.stringify(
            kmaNowcast([
              { category: "T1H", obsrValue: "24.3" },
              { category: "RN1", obsrValue: "1.5" },
              { category: "PTY", obsrValue: "1" },
              { category: "WSD", obsrValue: "3.0" },
            ]),
          ),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify(
          kmaNowcast([
            { category: "POP", fcstValue: "70" },
            { category: "SKY", fcstValue: "4" },
          ]),
        ),
        { status: 200 },
      );
    },
    async () => {
      /* Coordinates are distinct per test so the module cache cannot serve a
         previous case's answer. */
      const evidence = await getWeatherEvidence(37.5729, 126.9793);
      assert.equal(evidence.status, "available");
      assert.equal(evidence.provider, "kma_short_term");
      assert.equal(evidence.temperatureCelsius, 24.3);
      assert.equal(evidence.precipitationMillimeters, 1.5);
      assert.equal(evidence.precipitationProbabilityPercent, 70);
      assert.equal(evidence.weatherCode, 61, "PTY=1 비 → WMO 61");
      assert.equal(evidence.windSpeedKph, 10.8, "3.0 m/s → 10.8 km/h");
      assert.equal(evidence.raining, true);
      assert.match(evidence.attribution, /기상청/);
      assert.ok(
        calls.some((url) => url.includes("nx=60") && url.includes("ny=127")),
        "requests the Seoul grid cell",
      );
    },
  );
});

test('"강수없음" text is read as zero precipitation', async () => {
  await withEnv(
    { KMA_SERVICE_KEY: "kma-test-key", WEATHER_API_URL: undefined },
    async (input) =>
      new Response(
        JSON.stringify(
          String(input).includes("getUltraSrtNcst")
            ? kmaNowcast([
                { category: "T1H", obsrValue: "18.0" },
                { category: "RN1", obsrValue: "강수없음" },
                { category: "PTY", obsrValue: "0" },
                { category: "WSD", obsrValue: "1.0" },
              ])
            : kmaNowcast([{ category: "SKY", fcstValue: "1" }]),
        ),
        { status: 200 },
      ),
    async () => {
      const evidence = await getWeatherEvidence(33.5006, 126.5311);
      assert.equal(evidence.status, "available");
      assert.equal(evidence.precipitationMillimeters, 0);
      assert.equal(evidence.raining, false);
      assert.equal(evidence.weatherCode, 0, "SKY=1 맑음 → WMO 0");
    },
  );
});

/* An account that has not been approved for the forecast dataset gets a 403.
   Weather is supporting evidence, so that must degrade to the fallback
   provider rather than removing the evidence entirely. */
test("unapproved KMA service falls back to Open-Meteo", async () => {
  let openMeteoCalled = false;
  await withEnv(
    { KMA_SERVICE_KEY: "unapproved-key", WEATHER_API_URL: undefined },
    async (input) => {
      const url = String(input);
      if (url.includes("VilageFcstInfoService")) {
        return new Response("Forbidden", { status: 403 });
      }
      openMeteoCalled = true;
      return new Response(
        JSON.stringify({
          current: {
            time: "2026-07-15T10:00",
            temperature_2m: 21.5,
            apparent_temperature: 22.0,
            precipitation: 0,
            weather_code: 3,
            wind_speed_10m: 5,
          },
          hourly: { precipitation_probability: [10] },
        }),
        { status: 200 },
      );
    },
    async () => {
      const evidence = await getWeatherEvidence(37.8813, 127.73);
      assert.equal(evidence.status, "available");
      assert.equal(evidence.provider, "open_meteo");
      assert.equal(evidence.temperatureCelsius, 21.5);
      assert.ok(openMeteoCalled, "falls through to the fallback provider");
    },
  );
});

/* Without the dedicated variable the adapter must stay dormant: an account
   that never applied for the dataset should not spend a timeout on it. */
test("KMA is not called unless KMA_SERVICE_KEY is set", async () => {
  let kmaCalled = false;
  await withEnv(
    {
      KMA_SERVICE_KEY: undefined,
      KTO_SERVICE_KEY: "kto-key-must-not-be-reused",
      WEATHER_API_URL: undefined,
    },
    async (input) => {
      if (String(input).includes("VilageFcstInfoService")) kmaCalled = true;
      return new Response(
        JSON.stringify({
          current: {
            time: "2026-07-15T10:00",
            temperature_2m: 19,
            weather_code: 0,
            precipitation: 0,
            wind_speed_10m: 2,
          },
          hourly: { precipitation_probability: [0] },
        }),
        { status: 200 },
      );
    },
    async () => {
      const evidence = await getWeatherEvidence(35.8694, 128.6062);
      assert.equal(evidence.provider, "open_meteo");
      assert.equal(kmaCalled, false, "must not borrow the KTO key");
    },
  );
});
