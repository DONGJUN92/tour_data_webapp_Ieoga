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

function tmap(distance, time) {
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

/* 후보는 실외(관광지 12)뿐이고, 연관 목록에는 시군구 접두어 없는 이름과
   같은 이름의 음식점이 함께 들어 있다. 두 결함을 한 시나리오로 본다. */
async function withUpstream(run, { offset = 0, anchor = "원래 관광지" } = {}) {
  const originalFetch = globalThis.fetch;
  const saved = {
    kto: process.env.KTO_SERVICE_KEY,
    tmap: process.env.TMAP_APP_KEY,
    routing: process.env.ROUTING_BASE_URL,
    weather: process.env.WEATHER_API_URL,
  };
  process.env.KTO_SERVICE_KEY = "indoor-related-key";
  process.env.TMAP_APP_KEY = "indoor-related-tmap";
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
      return Response.json(tmap(600, 540));
    }
    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      items = [
        {
          /* 국문 관광정보는 시군구 접두어를 붙여 표기한다. */
          contentid: "outdoor-1",
          contenttypeid: "12",
          title: "해운대 동백섬",
          addr1: "부산광역시 해운대구",
          mapx: String(126.9805 + offset),
          mapy: "37.567",
          dist: "600",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
        {
          /* 같은 이름을 포함하지만 전혀 다른 장소. 분류가 다르다. */
          contentid: "food-1",
          contenttypeid: "39",
          title: "동백섬횟집",
          addr1: "부산광역시 해운대구",
          mapx: String(126.9806 + offset),
          mapy: "37.5671",
          dist: "620",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
      ];
    } else if (service === "KorService2" && operation === "detailIntro2") {
      items = [{ usetime: "상시 개방", restdate: "연중무휴" }];
    } else if (
      service === "TarRlteTarService1" &&
      operation === "areaBasedList1"
    ) {
      /* 연관 관광지는 접두어 없이 표기한다. */
      items = [
        {
          tAtsNm: anchor,
          rlteTatsNm: "동백섬",
          rlteCtgryLclsNm: "관광지",
          rlteCtgryMclsNm: "자연관광",
          rlteRank: "1",
          baseYm: "202606",
        },
      ];
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

function itineraryRequest({ indoorOnly, offset = 0 }) {
  const now = Date.now();
  const nodes = [
    {
      id: "n1",
      sequence: 1,
      type: "visit",
      title: "원래 관광지",
      startAt: new Date(now + 10 * 60_000).toISOString(),
      locked: false,
      reservation: false,
      location: {
        latitude: 37.5665,
        longitude: 126.978 + offset,
        label: "원래 관광지",
        areaCode: "11",
        sigunguCode: "11110",
      },
    },
    {
      id: "n2",
      sequence: 2,
      type: "reservation",
      title: "다음 예약",
      startAt: new Date(now + 200 * 60_000).toISOString(),
      locked: true,
      reservation: true,
      location: {
        latitude: 37.57,
        longitude: 126.99,
        label: "다음 예약",
        areaCode: "11",
        sigunguCode: "11110",
      },
    },
  ];
  const request = {
    origin: {
      latitude: 37.5665,
      longitude: 126.978 + offset,
      label: "현재 위치",
      areaCode: "11",
      sigunguCode: "11110",
    },
    incident: "rain",
    availableMinutes: 180,
    maxDistanceMeters: 5_000,
    audience: "general",
    travelMode: "walk",
    radiusMeters: 8_000,
    safetyBufferMinutes: 15,
    minimumStayMinutes: 60,
    analyticsConsent: false,
    itinerary: {
      title: "테스트 일정",
      timezone: "Asia/Seoul",
      audience: "general",
      occurredAt: new Date(now).toISOString(),
      disruptedNodeId: "n1",
      nextFixedNodeId: "n2",
      nodes,
    },
  };
  if (indoorOnly !== undefined) request.indoorOnly = indoorOnly;
  return request;
}

test("우천이면 기본으로 실내를 요구해 실외 후보가 탈락한다", async () => {
  await withUpstream(async () => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    /* indoorOnly 미지정 = 상황 기본값을 따른다. */
    const result = await recoverTrip(
      itineraryRequest({ indoorOnly: undefined, offset: 0 }),
      "indoor-default",
    );
    assert.equal(result.options.length, 0);
    assert.ok(
      result.rejectionSummary.some(
        (entry) => entry.reasonCode === "INDOOR_UNVERIFIED",
      ),
      "우천 기본값이 실내를 요구하지 않는다",
    );
  });
});

test("실내 조건을 명시적으로 끄면 우천이어도 실외 후보가 살아난다", async () => {
  await withUpstream(
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        itineraryRequest({ indoorOnly: false, offset: 0.01 }),
        "indoor-relaxed",
      );
      /* 예전에는 엔진이 `incident === "rain"`을 OR로 강제해, 클라이언트가 끄고
         보내도 다시 켜졌다. 여행자에게 되돌릴 방법이 없는 상태였다. */
      assert.ok(
        result.options.length >= 1,
        "명시적 false가 우천 기본값을 이기지 못한다",
      );
      assert.ok(
        !result.rejectionSummary.some(
          (entry) => entry.reasonCode === "INDOOR_UNVERIFIED",
        ),
      );
    },
    { offset: 0.01 },
  );
});

test("표기가 달라도 분류가 맞으면 연관 근거를 연결한다", async () => {
  await withUpstream(
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        itineraryRequest({ indoorOnly: false, offset: 0.02 }),
        "related-boundary",
      );
      const scenic = result.options.find(
        (option) => option.title === "해운대 동백섬",
      );
      assert.ok(scenic, "관광지 후보가 결과에 없다");
      /* 연관 목록은 `동백섬`, 국문 관광정보는 `해운대 동백섬`이다. 정확 일치만
         보던 구현은 이 쌍을 연결하지 못했다. */
      assert.equal(
        scenic.relatedRank,
        1,
        "시군구 접두어 때문에 연관 근거가 연결되지 않았다",
      );
      assert.equal(
        scenic.purposePreservation.evidenceSource,
        "TarRlteTarService1",
      );
    },
    { offset: 0.02 },
  );
});

test("이름이 포함되더라도 분류가 다르면 연결하지 않는다", async () => {
  await withUpstream(
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        itineraryRequest({ indoorOnly: false, offset: 0.03 }),
        "related-guard",
      );
      const restaurant = result.options.find(
        (option) => option.title === "동백섬횟집",
      );
      if (restaurant) {
        /* `동백섬횟집`(음식점)을 `동백섬`(자연관광)에 붙이면 "함께 방문한 기록이
           실제로 있는 곳"이라는 사실 주장이 거짓이 된다. */
        assert.equal(
          restaurant.relatedRank,
          undefined,
          "분류가 다른 장소에 연관 근거가 붙었다",
        );
        assert.notEqual(
          restaurant.purposePreservation.evidenceSource,
          "TarRlteTarService1",
        );
      }
    },
    { offset: 0.03 },
  );
});

test("실내 조건 판단이 한 곳에만 있고 화면이 되돌릴 수단을 제공한다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  assert.match(engine, /function indoorRequirement/);
  assert.match(engine, /input\.indoorOnly \?\? input\.incident === "rain"/);
  /* 세 곳에서 각자 OR로 계산하던 흔적이 남아 있으면 다시 강제된다. */
  assert.ok(
    !/input\.incident === "rain" \|\| input\.indoorOnly/.test(engine),
    "우천을 이유로 실내를 강제하는 계산이 남아 있다",
  );

  const schema = await readFile(
    new URL("../lib/recovery/schema.ts", import.meta.url),
    "utf8",
  );
  assert.match(schema, /indoorOnly: z\.boolean\(\)\.optional\(\)/);

  const flow = await readFile(
    new URL("../app/flow/FlowApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(flow, /실외 후보까지 포함해 다시 찾기/);
  /* 상태 갱신을 기다리지 않고 인자로 넘겨야 버튼이 한 번에 동작한다. */
  assert.match(flow, /runRecovery\(\{ includeOutdoor: true \}\)/);
  assert.match(flow, /options\.includeOutdoor \?\? allowOutdoor/);
});

test("분류 매핑은 모르는 분류를 통과시키지 않는다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  const fn = engine.slice(
    engine.indexOf("function relatedCategoryAllowsType"),
    engine.indexOf("type RelatedMatch"),
  );
  assert.match(fn, /음식/);
  assert.match(fn, /숙박/);
  assert.match(fn, /관광지/);
  /* 새 분류가 생겼을 때 조용히 느슨해지면 오탐이 늘어난다. */
  assert.match(fn, /return false;/);
});

test("이동 부담 감소가 실제로 순위를 바꾼다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* `less_walk`는 엔진에 아예 없어 `delay`와 똑같이 계산됐다. 고른 상황이 결과를
     바꾸지 않으면 그 선택지는 화면 장식이다. */
  assert.match(engine, /input\.incident === "less_walk"/);
  const branch = engine.slice(
    engine.indexOf('input.incident === "less_walk"'),
  );
  const weights = branch.slice(0, 900);
  /* 거리 가중이 다른 항목보다 확실히 커야 순위가 갈린다. */
  assert.match(weights, /distanceScore \* 0\.38/);
  assert.match(weights, /accessScore \* 0\.22/);
  /* 무엇을 기준으로 정렬했는지 카드가 밝혀야 한다. */
  assert.match(engine, /이동 부담을 가장 크게 반영해 정렬했습니다/);
});

test("화면 문구가 실제 동작과 일치한다", async () => {
  const model = await readFile(
    new URL("../app/product-app-model.ts", import.meta.url),
    "utf8",
  );
  /* 예전 문구는 "먼저 통과한 후보만 제시합니다"로 하드 필터를 약속했는데 필터는
     없었다. 사용자가 준 이동거리 상한을 알리지 않고 조이지 않기로 했으므로
     문구를 실제 동작(정렬)에 맞춘다. */
  assert.ok(
    !model.includes("보행 부담과 접근성 조건을 먼저 통과한 후보만 제시합니다"),
    "구현하지 않은 필터를 약속하는 문구가 남아 있다",
  );
  assert.match(model, /이동거리와 접근성 확인 여부를 가장 크게 반영해 정렬합니다/);
});
