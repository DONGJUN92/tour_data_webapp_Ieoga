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

function tmapResponse({ distance, time }) {
  return {
    features: [
      {
        geometry: { type: "Point", coordinates: [126.978, 37.5665] },
        properties: { totalDistance: distance, totalTime: time },
      },
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [126.978, 37.5665],
            [126.9805, 37.567],
          ],
        },
        properties: {},
      },
    ],
  };
}

/* 카카오 자전거·도보 응답 모양. 2026-08-04 실호출에서 확인한 필드만 쓴다. */
function kakaoBicycle(distance, time) {
  return {
    status: "OK",
    route: {
      properties: { totalDistance: distance, totalTime: time },
      legs: [
        {
          properties: { distance, time },
          steps: [
            {
              path: {
                points: [
                  [126.978, 37.5665],
                  [126.9805, 37.567],
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

/* 카카오 대중교통 응답 모양. 여러 경로를 유형별로 돌려주며 정렬되어 있지 않다. */
function kakaoTransit({ totalTime, fare, transfers }) {
  return {
    status: "OK",
    properties: { total: 3, bus: 1, subway: 1, busAndSubway: 1 },
    routes: [
      {
        properties: {
          type: "BUS",
          totalDistance: 9_500,
          totalTime: totalTime + 900,
          transfers: transfers + 1,
          fare: { value: fare + 200 },
        },
        steps: [
          {
            properties: { type: "BUS", time: totalTime + 900 },
            path: { points: [[126.978, 37.5665]] },
          },
        ],
      },
      {
        properties: {
          type: "SUBWAY",
          totalDistance: 9_000,
          totalTime,
          transfers,
          fare: { value: fare },
        },
        steps: [
          {
            properties: {
              type: "SUBWAY",
              time: totalTime - 300,
              guidance: "2호선 (시청 > 강남)",
            },
            path: {
              points: [
                [126.978, 37.5665],
                [126.9805, 37.567],
              ],
            },
          },
          {
            properties: { type: "WALKING", time: 300, guidance: "도보 이동" },
            path: { points: [[126.9805, 37.567]] },
          },
        ],
      },
    ],
  };
}

async function withKakaoUpstream(run, { offset = 0, transitStatus } = {}) {
  const candidateLongitude = 126.9768 + offset;
  const originalFetch = globalThis.fetch;
  const saved = {
    kto: process.env.KTO_SERVICE_KEY,
    kakao: process.env.KAKAO_REST_API_KEY,
    tmap: process.env.TMAP_APP_KEY,
    routing: process.env.ROUTING_BASE_URL,
    weather: process.env.WEATHER_API_URL,
  };
  process.env.KTO_SERVICE_KEY = "kakao-mode-kto";
  process.env.KAKAO_REST_API_KEY = "kakao-mode-key";
  process.env.TMAP_APP_KEY = "kakao-mode-tmap";
  process.env.ROUTING_BASE_URL = "none";
  process.env.WEATHER_API_URL = "none";

  const calls = { transit: 0, bicycle: 0, tmapWalk: 0, tmapCar: 0 };
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "dapi.kakao.com") {
      if (url.pathname.endsWith("/publictraffic")) {
        calls.transit += 1;
        /* 카카오는 실패를 HTTP 200 본문의 status로 알린다. */
        if (transitStatus) return Response.json({ status: transitStatus });
        return Response.json(
          kakaoTransit({ totalTime: 1_800, fare: 1_650, transfers: 1 }),
        );
      }
      if (url.pathname.endsWith("/bicycle")) {
        calls.bicycle += 1;
        return Response.json(kakaoBicycle(4_100, 1_200));
      }
    }
    if (url.hostname === "apis.openapi.sk.com") {
      if (url.pathname.endsWith("/routes/pedestrian")) calls.tmapWalk += 1;
      else calls.tmapCar += 1;
      return Response.json(tmapResponse({ distance: 4_000, time: 3_000 }));
    }
    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      items = [
        {
          contentid: "kk-1",
          contenttypeid: "14",
          title: "카카오로 가는 문화관",
          addr1: "서울특별시 종로구",
          mapx: String(candidateLongitude),
          mapy: "37.5759",
          dist: "9000",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
      ];
    } else if (service === "KorService2" && operation === "detailIntro2") {
      items = [{ usetimeculture: "00:00~23:59" }];
    }
    return Response.json(ktoEnvelope(items));
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = saved.kto;
    if (saved.kakao === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = saved.kakao;
    if (saved.tmap === undefined) delete process.env.TMAP_APP_KEY;
    else process.env.TMAP_APP_KEY = saved.tmap;
    if (saved.routing === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = saved.routing;
    if (saved.weather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = saved.weather;
  }
}

function request(travelMode, offset = 0) {
  return {
    origin: {
      latitude: 37.5665,
      longitude: 126.978 + offset,
      label: "현재 위치",
      areaCode: "11",
      sigunguCode: "11110",
    },
    incident: "delay",
    availableMinutes: 240,
    maxDistanceMeters: 20_000,
    audience: "general",
    indoorOnly: false,
    travelMode,
    radiusMeters: 20_000,
    safetyBufferMinutes: 15,
    minimumStayMinutes: 60,
    analyticsConsent: false,
    openWindow: {
      availableUntil: new Date(Date.now() + 240 * 60_000).toISOString(),
      plannedStayMinutes: 60,
    },
  };
}

test("대중교통 왕복은 미래 복귀 배차를 검증할 수 없어 실패 폐쇄한다", async () => {
  await withKakaoUpstream(
    async (calls) => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const currentTransit = request("transit", 0.05);
      currentTransit.openWindow.departureAt = new Date().toISOString();
      const result = await recoverTrip(currentTransit, "mode-transit");
      assert.equal(result.options.length, 0);
      assert.ok(
        result.rejectionSummary.some(
          (entry) => entry.reasonCode === "ROUTE_UNAVAILABLE",
        ),
      );
      assert.ok(calls.transit >= 1, "카카오 대중교통을 호출하지 않았다");
      assert.equal(calls.tmapWalk, 0, "대중교통인데 TMAP 보행을 호출했다");
      assert.equal(calls.tmapCar, 0, "대중교통인데 TMAP 자동차를 호출했다");
    },
    { offset: 0.05 },
  );
});

test("자전거는 카카오 자전거로 계산하고 배차 문구를 붙이지 않는다", async () => {
  await withKakaoUpstream(
    async (calls) => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        request("bicycle", 0.06),
        "mode-bicycle",
      );
      assert.ok(result.options.length >= 1);
      assert.ok(calls.bicycle >= 1, "카카오 자전거를 호출하지 않았다");
      assert.equal(calls.transit, 0);
      assert.equal(calls.tmapWalk, 0);
      const option = result.options[0];
      assert.equal(
        option.continuityProof.routeEvidence.provider,
        "kakao_bicycle",
      );
      assert.match(
        option.continuityProof.routeEvidence.attribution,
        /카카오맵 자전거/,
      );
      /* 자전거에는 배차가 없다. 대중교통 문구가 새면 안 된다. */
      assert.ok(
        !option.why.some((line) => line.includes("배차 간격")),
        "자전거 결과에 배차 문구가 붙었다",
      );
      assert.ok(
        option.dataContributions.some(
          (entry) => entry.source === "카카오맵 자전거 길찾기",
        ),
      );
    },
    { offset: 0.06 },
  );
});

test("카카오가 status로 실패를 알리면 다른 수단으로 대체하지 않는다", async () => {
  await withKakaoUpstream(
    async (calls) => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        {
          ...request("transit", 0.07),
          openWindow: {
            ...request("transit", 0.07).openWindow,
            departureAt: new Date().toISOString(),
          },
        },
        "mode-transit-fail",
      );
      /* 단위가 다른 경로로 메꾸면 "대중교통 30분"이 실제로는 도보 30분이 된다. */
      assert.equal(calls.tmapWalk, 0, "대중교통 실패를 보행으로 메꿨다");
      assert.equal(calls.tmapCar, 0);
      assert.equal(result.options.length, 0);
      assert.ok(
        result.rejectionSummary.some(
          (entry) => entry.reasonCode === "ROUTE_UNAVAILABLE",
        ),
      );
    },
    { offset: 0.07, transitStatus: "NO_RESULTS" },
  );
});

test("수단별 보수 추정이 서로 다른 속도를 쓴다", async () => {
  const {
    conservativeWalkingMinutes,
    conservativeCyclingMinutes,
    conservativeTransitMinutes,
    conservativeDrivingMinutes,
  } = await import("../lib/geo.ts");
  const distance = 9_000;
  /* 9km를 도보 속도로 걸러내면 대중교통·자전거로 갈 수 있는 후보가 사라진다. */
  assert.ok(
    conservativeWalkingMinutes(distance) >
      conservativeTransitMinutes(distance),
  );
  assert.ok(
    conservativeWalkingMinutes(distance) > conservativeCyclingMinutes(distance),
  );
  assert.ok(
    conservativeDrivingMinutes(distance) < conservativeCyclingMinutes(distance),
  );
});

test("네 수단 모두 스키마와 화면 목록에 있다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  for (const mode of ["walk", "car", "transit", "bicycle"]) {
    const parsed = recoveryRequestSchema.safeParse({
      ...request("walk"),
      travelMode: mode,
    });
    assert.equal(parsed.success, true, `${mode}를 스키마가 거절했다`);
  }
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...request("walk"),
      travelMode: "helicopter",
    }).success,
    false,
  );
  const model = await readFile(
    new URL("../app/product-app-model.ts", import.meta.url),
    "utf8",
  );
  for (const mode of ["walk", "car", "transit", "bicycle"]) {
    assert.ok(model.includes(`value: "${mode}"`), `화면 목록에 ${mode}가 없다`);
  }
});

test("대중교통·자전거에도 공개 폴백을 붙이지 않는다", async () => {
  const providers = await readFile(
    new URL("../lib/external-providers.ts", import.meta.url),
    "utf8",
  );
  assert.match(providers, /KAKAO_TRANSIT_ROUTE_URL/);
  assert.match(providers, /KAKAO_BICYCLE_ROUTE_URL/);
  const chains = providers.slice(providers.indexOf("export function transitRouteChain"));
  assert.ok(
    !/routingEndpoints\(\)/.test(chains.slice(0, chains.indexOf("walkingRouteChain"))),
    "대중교통·자전거 체인에 OSRM 엔드포인트가 들어갔다",
  );
});
