import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

function envelope(items) {
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

/* 우천 시나리오에서 모든 후보가 실외다. 실측에서 가장 많았던 탈락 사유이고,
   예전에는 이 상황에서 counterfactual이 항상 null이었다. */
async function withOutdoorOnly(run) {
  const originalFetch = globalThis.fetch;
  const saved = {
    kto: process.env.KTO_SERVICE_KEY,
    tmap: process.env.TMAP_APP_KEY,
    routing: process.env.ROUTING_BASE_URL,
    weather: process.env.WEATHER_API_URL,
  };
  process.env.KTO_SERVICE_KEY = "cf-test-key";
  process.env.TMAP_APP_KEY = "cf-tmap";
  process.env.ROUTING_BASE_URL = "none";
  process.env.WEATHER_API_URL = "none";
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "apis.openapi.sk.com") {
      return Response.json({
        features: [
          {
            geometry: { type: "Point", coordinates: [126.978, 37.5665] },
            properties: { totalDistance: 500, totalTime: 420 },
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
      });
    }
    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      /* contentTypeId 12 = 관광지. 실내로 확인되지 않는 유형이다. */
      items = [
        {
          contentid: "outdoor-1",
          contenttypeid: "12",
          title: "야외 공원",
          addr1: "서울특별시 종로구",
          mapx: "126.9805",
          mapy: "37.567",
          dist: "500",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
      ];
    } else if (
      service === "KorService2" &&
      operation === "detailIntro2"
    ) {
      /* 거리 반사실 테스트가 운영정보 미확인이라는 두 번째 필수 조건에
         막히지 않도록 체류 구간 전체가 열려 있음을 명시한다. */
      items = [{ usetimeculture: "00:00~23:59" }];
    }
    return Response.json(envelope(items));
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = saved.kto;
    if (saved.tmap === undefined) delete process.env.TMAP_APP_KEY;
    else process.env.TMAP_APP_KEY = saved.tmap;
    if (saved.routing === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = saved.routing;
    if (saved.weather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = saved.weather;
  }
}

test("우천에 실외 후보만 있어도 반사실 설명이 나온다", async () => {
  await withOutdoorOnly(async () => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      {
        origin: {
          latitude: 37.5665,
          longitude: 126.978,
          label: "현재 위치",
          areaCode: "11",
          sigunguCode: "11110",
        },
        incident: "rain",
        availableMinutes: 180,
        maxDistanceMeters: 5_000,
        audience: "general",
        indoorOnly: true,
        travelMode: "walk",
        radiusMeters: 8_000,
        safetyBufferMinutes: 15,
        minimumStayMinutes: 60,
        analyticsConsent: false,
        openWindow: {
          availableUntil: new Date(Date.now() + 180 * 60_000).toISOString(),
          plannedStayMinutes: 60,
        },
      },
      "cf-indoor",
    );

    assert.equal(result.options.length, 0, "실내 후보가 없어야 하는 설정이다");
    assert.ok(
      result.rejectionSummary.some(
        (entry) => entry.reasonCode === "INDOOR_UNVERIFIED",
      ),
    );
    const counterfactual = result.counterfactual;
    assert.ok(
      counterfactual,
      "탈락은 있는데 반사실 설명이 비어 있다 — 기획의 대표 차별점이 시연되지 않는다",
    );
    assert.equal(
      counterfactual.requiredRelaxation.constraint,
      "indoor_requirement",
    );
    assert.equal(counterfactual.requiredRelaxation.unit, "condition");
    assert.equal(counterfactual.verificationDepth, "pre_filter");
    /* 사전 걸러내기 단계는 예약 보존을 확인하지 않았으므로 주장하지 않는다. */
    assert.equal(
      counterfactual.requiredRelaxation.preservesNextFixedAppointment,
      false,
    );
  });
});

test("레거시 거리 상한은 후보를 탈락시키지 않는다", async () => {
  await withOutdoorOnly(async () => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      {
        origin: {
          latitude: 37.5665,
          longitude: 126.978,
          label: "현재 위치",
          areaCode: "11",
          sigunguCode: "11110",
        },
        incident: "delay",
        availableMinutes: 180,
        /* 이전 클라이언트의 작은 값을 보내도 실제 이동·체류·복귀 시간으로만
           판정해야 한다. */
        maxDistanceMeters: 300,
        audience: "general",
        indoorOnly: false,
        travelMode: "walk",
        radiusMeters: 8_000,
        safetyBufferMinutes: 15,
        minimumStayMinutes: 60,
        analyticsConsent: false,
        openWindow: {
          availableUntil: new Date(Date.now() + 180 * 60_000).toISOString(),
          plannedStayMinutes: 60,
        },
      },
      "cf-distance",
    );
    assert.equal(
      result.rejectionSummary.some(
        (entry) => entry.reasonCode === "DISTANCE_LIMIT",
      ),
      false,
    );
    assert.notEqual(
      result.counterfactual?.requiredRelaxation?.constraint,
      "maximum_distance",
    );
  });
});

test("capabilities가 실제 완화 대상과 검증 단계를 공표한다", async () => {
  const source = await readFile(
    new URL("../app/api/v1/capabilities/route.ts", import.meta.url),
    "utf8",
  );
  /* 예전에는 supported:true와 보존 계약만 적어, 응답이 항상 null인데도
     계약은 지원한다고 말했다. */
  assert.match(source, /relaxableConstraints/);
  assert.doesNotMatch(source, /maximum_distance/);
  assert.match(source, /indoor_requirement/);
  assert.match(source, /verificationDepths/);
  assert.match(source, /preservedContractAppliesTo: "route_verified"/);
});

test("사전 걸러내기 반사실에는 예약 보존을 주장하지 않는다", async () => {
  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(product, /verificationDepth ===\s*\n?\s*"pre_filter"/);
  assert.match(product, /다음 예약 보존은 이 조건을 적용한 뒤 다시 검증합니다/);
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* 경로까지 검증한 탈락안이 먼저 올라와야 한다. */
  assert.match(engine, /entry\.verificationDepth === "route_verified" \? 0 : 1/);
});
