import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

function ktoEnvelope(items) {
  return {
    response: {
      header: { resultCode: "0000", resultMsg: "OK" },
      body: {
        items: items.length ? { item: items } : "",
        totalCount: items.length,
        pageNo: 1,
        numOfRows: Math.max(1, items.length),
      },
    },
  };
}

/* TMAP 자동차 응답의 실제 모양. 2026-08-04 실호출에서 확인한 필드만 쓴다. */
function tmapCarResponse({ distance, time, taxiFare }) {
  return {
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [126.978, 37.5665] },
        properties: {
          totalDistance: distance,
          totalTime: time,
          taxiFare,
          tollFare: 0,
          pointType: "S",
        },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [126.978, 37.5665],
            [126.982, 37.57],
            [126.9768, 37.5759],
          ],
        },
        properties: {},
      },
    ],
  };
}

/* 좌표를 시나리오마다 다르게 준다. `lib/mobility/routing.ts`의 캐시는 모듈
   수준이라 같은 파일의 앞선 테스트가 남긴 결과가 뒤 테스트에 그대로 반환된다.
   실제로 자차 성공 테스트가 캐시에 남겨 둔 경로 때문에, 자차 실패를 검증하는
   테스트가 후보 0개 대신 1개를 받았다. 제품 동작이 아니라 테스트 격리 문제였다. */
async function withCarEnvironment(run, { failCar = false, offset = 0 } = {}) {
  const candidateLongitude = 126.9768 + offset;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  const originalTmap = process.env.TMAP_APP_KEY;
  const originalRouting = process.env.ROUTING_BASE_URL;
  const originalWeather = process.env.WEATHER_API_URL;
  process.env.KTO_SERVICE_KEY = "travel-mode-test-key";
  process.env.TMAP_APP_KEY = "travel-mode-tmap-key";
  process.env.ROUTING_BASE_URL = "none";
  process.env.WEATHER_API_URL = "none";

  const calls = { car: 0, pedestrian: 0 };
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "apis.openapi.sk.com") {
      if (url.pathname.endsWith("/routes/pedestrian")) {
        calls.pedestrian += 1;
        return Response.json(
          tmapCarResponse({ distance: 4_000, time: 3_000 }),
        );
      }
      if (
        url.pathname.endsWith("/routes") ||
        url.pathname.endsWith("/routes/prediction")
      ) {
        calls.car += 1;
        if (failCar) return new Response("nope", { status: 500 });
        /* 같은 거리를 자동차는 훨씬 빠르게 간다. 수단이 실제로 갈렸는지
           도착 시각으로 확인할 수 있도록 크게 벌린다. */
        return Response.json(
          tmapCarResponse({ distance: 4_000, time: 480, taxiFare: 8_420 }),
        );
      }
    }
    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      items = [
        {
          contentid: "car-1",
          contenttypeid: "14",
          title: "차로 가는 문화관",
          addr1: "서울특별시 종로구",
          mapx: String(candidateLongitude),
          mapy: "37.5759",
          dist: "4000",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
      ];
    } else if (service === "KorService2" && operation === "detailIntro2") {
      items = [{ usetimeculture: "24시간", restdateculture: "연중무휴" }];
    }
    return Response.json(ktoEnvelope(items));
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = originalKey;
    if (originalTmap === undefined) delete process.env.TMAP_APP_KEY;
    else process.env.TMAP_APP_KEY = originalTmap;
    if (originalRouting === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = originalRouting;
    if (originalWeather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalWeather;
  }
}

function request(travelMode, { windowMinutes = 180, offset = 0 } = {}) {
  return {
    origin: {
      latitude: 37.5665,
      longitude: 126.978 + offset,
      label: "현재 위치",
      areaCode: "11",
      sigunguCode: "11110",
    },
    incident: "delay",
    availableMinutes: Math.min(240, windowMinutes),
    maxDistanceMeters: 20_000,
    audience: "general",
    indoorOnly: false,
    travelMode,
    radiusMeters: 20_000,
    safetyBufferMinutes: 15,
    minimumStayMinutes: 60,
    analyticsConsent: false,
    openWindow: {
      availableUntil: new Date(
        Date.now() + windowMinutes * 60_000,
      ).toISOString(),
      plannedStayMinutes: 60,
    },
  };
}

test("자차를 고르면 자동차 경로 제공자로 계산하고 도보를 호출하지 않는다", async () => {
  await withCarEnvironment(async (calls) => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      request("car", { offset: 0 }),
      "travel-mode-car",
    );

    assert.ok(result.options.length >= 1, "자차 후보가 남아야 한다");
    assert.equal(calls.car >= 1, true, "자동차 경로를 호출하지 않았다");
    assert.equal(
      calls.pedestrian,
      0,
      "자차를 골랐는데 보행 경로를 호출했다",
    );

    const option = result.options[0];
    assert.equal(option.continuityProof.routeEvidence.provider, "tmap_car");
    assert.match(
      option.continuityProof.routeEvidence.attribution,
      /TMAP 자동차/,
    );
    /* 4,000m를 8분으로 왔으므로 문장이 보행이라고 말해서는 안 된다. */
    assert.ok(
      option.why.some((line) => line.includes("자동차 경로로")),
      `수단이 문장에 드러나지 않았다: ${JSON.stringify(option.why)}`,
    );
    assert.ok(
      !option.why.some((line) => line.includes("보행 경로로")),
      "자차 결과에 보행 경로라고 적혀 있다",
    );
    assert.ok(
      option.why.some((line) => line.includes("자차 비용으로 표시하지 않습니다")),
      "택시 추정값을 자차 비용과 분리해 설명하지 않았다",
    );
    assert.ok(
      !option.why.some((line) => line.includes("8,420원")),
      "택시 추정값을 자차 비용처럼 숫자로 노출했다",
    );
  });
});

test("도보를 고르면 보행 경로 제공자로 계산하고 자동차를 호출하지 않는다", async () => {
  await withCarEnvironment(
    async (calls) => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        request("walk", { offset: 0.01 }),
        "travel-mode-walk",
      );
      assert.equal(calls.pedestrian >= 1, true);
      assert.equal(calls.car, 0, "도보를 골랐는데 자동차 경로를 호출했다");
      assert.ok(result.options.length >= 1, "도보 후보가 남아야 한다");
      assert.equal(
        result.options[0].continuityProof.routeEvidence.provider,
        "tmap_pedestrian",
      );
    },
    { offset: 0.01 },
  );
});

test("자동차 경로 조회가 실패하면 보행으로 바꿔 통과시키지 않는다", async () => {
  await withCarEnvironment(
    async (calls) => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        request("car", { offset: 0.02 }),
        "travel-mode-car-fail",
      );
      /* 단위가 다른 경로로 대체해 도착 시각을 만들어내면 "차로 8분"이 실제로는
         걸어서 50분인 값이 된다. 확인하지 못한 후보는 탈락해야 한다. */
      assert.equal(
        calls.pedestrian,
        0,
        "자동차 실패를 보행 경로로 메꿨다",
      );
      assert.equal(result.options.length, 0);
      assert.ok(
        result.rejectionSummary.some(
          (entry) => entry.reasonCode === "ROUTE_UNAVAILABLE",
        ),
        "경로 미확인 사유로 탈락해야 한다",
      );
    },
    { failCar: true, offset: 0.02 },
  );
});

test("자차 사전 걸러내기는 도보 속도를 쓰지 않는다", async () => {
  const { conservativeDrivingMinutes, conservativeWalkingMinutes } =
    await import("../lib/geo.ts");
  /* 8km는 걸어서 두 시간이 넘지만 차로는 30분 안이다. 도보 속도로 걸러내면
     실제로 갈 수 있는 후보가 "가용시간 초과"로 사라진다. */
  assert.ok(conservativeWalkingMinutes(8_000) > 120);
  assert.ok(conservativeDrivingMinutes(8_000) < 35);
  assert.ok(
    conservativeDrivingMinutes(1_000) < conservativeWalkingMinutes(1_000),
  );
});

test("자동차 경로에는 공개 OSRM 폴백을 붙이지 않는다", async () => {
  const providers = await readFile(
    new URL("../lib/external-providers.ts", import.meta.url),
    "utf8",
  );
  const chain = providers.slice(providers.indexOf("export function carRouteChain"));
  assert.ok(
    !/routingEndpoints\(\)/.test(chain.slice(0, chain.indexOf("}"))),
    "자동차 체인에 OSRM 엔드포인트가 들어갔다",
  );
  assert.match(providers, /TMAP_CAR_URL/);
});

test("이동수단 목록은 한 곳에서만 정의되고 검증 가능한 수단만 담는다", async () => {
  const model = await readFile(
    new URL("../app/product-app-model.ts", import.meta.url),
    "utf8",
  );
  const panel = await readFile(
    new URL("../app/DiscoverWindowPanel.tsx", import.meta.url),
    "utf8",
  );
  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(model, /export const TRAVEL_MODES/);
  /* 화면마다 목록을 따로 두면 한쪽에만 수단이 추가된다. */
  assert.ok(
    !/const TRAVEL_MODES = \[/.test(panel),
    "빈 시간 화면이 이동수단 목록을 따로 정의했다",
  );
  assert.ok(
    !/const TRAVEL_MODES = \[/.test(product),
    "복구 화면이 이동수단 목록을 따로 정의했다",
  );
  assert.match(panel, /TRAVEL_MODES,/);
  assert.match(product, /TRAVEL_MODES,/);
  /* 실호출로 확인한 네 수단만 둔다. 확인되지 않은 수단을 넣으면 선택은 되고
     검증은 안 되는 상태가 되어 잘못된 도착 시각을 준다.
     (`tests/kakao-modes.test.mjs`가 네 수단의 제공자 분기를 고정한다.) */
  for (const present of ["walk", "car", "transit", "bicycle"]) {
    assert.ok(
      new RegExp(`value: "${present}"`).test(model),
      `확인된 수단 ${present}이 목록에 없다`,
    );
  }
  for (const absent of ["bike", "bus", "subway", "helicopter"]) {
    assert.ok(
      !new RegExp(`value: "${absent}"`).test(model),
      `검증되지 않은 수단 ${absent}이 목록에 있다`,
    );
  }
  const schema = await readFile(
    new URL("../lib/recovery/schema.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    schema.includes('.enum(["walk", "car", "transit", "bicycle"])'),
    "스키마가 네 수단을 받지 않는다",
  );
});

test("기여 원장은 실제로 응답한 경로·기상 제공자 이름을 적는다", async () => {
  await withCarEnvironment(
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        request("car", { offset: 0.03 }),
        "ledger-provider-car",
      );
      const sources = (result.dataContributions ?? []).map(
        (entry) => entry.source,
      );
      /* 고정 문자열이던 시절 TMAP으로 계산한 결과에도 OpenStreetMap이라고
         적혔다. 심사 증거로 내는 원장이 스스로 출처를 틀리게 적는 상태였다. */
      assert.ok(
        sources.includes("TMAP 자동차 경로안내"),
        `자동차 제공자가 원장에 없다: ${JSON.stringify(sources)}`,
      );
      assert.ok(
        !sources.includes("OpenStreetMap Routing"),
        "TMAP으로 계산했는데 OpenStreetMap이라고 적혀 있다",
      );
    },
    { offset: 0.03 },
  );
});

test("보행으로 계산하면 원장도 보행 제공자를 적는다", async () => {
  await withCarEnvironment(
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        request("walk", { offset: 0.04 }),
        "ledger-provider-walk",
      );
      const sources = (result.dataContributions ?? []).map(
        (entry) => entry.source,
      );
      assert.ok(sources.includes("TMAP 보행자 경로안내"));
      assert.ok(!sources.includes("TMAP 자동차 경로안내"));
    },
    { offset: 0.04 },
  );
});

test("원장에 남는 제공자 이름은 고정 문자열이 아니라 응답에서 온다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* 경로·기상 기여 항목이 응답의 provider를 읽는지 확인한다. */
  assert.match(engine, /const routeProvider = candidate\.routeEvidence\.provider/);
  assert.match(engine, /weather\.provider === "kma_short_term"/);
  assert.ok(
    !/source: "OpenStreetMap Routing"/.test(engine),
    "경로 제공자 이름이 다시 고정 문자열로 박혔다",
  );
  assert.ok(
    !/source: "Open-Meteo"/.test(engine),
    "기상 제공자 이름이 다시 고정 문자열로 박혔다",
  );
});
