import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

const points = [
  { latitude: 37.5665, longitude: 126.978 },
  { latitude: 37.57, longitude: 126.982 },
];

function tmapResponse(minutes) {
  return {
    features: [
      {
        geometry: { type: "Point", coordinates: [126.978, 37.5665] },
        properties: {
          totalDistance: 1_000,
          totalTime: minutes * 60,
          pointType: "S",
        },
      },
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [126.978, 37.5665],
            [126.982, 37.57],
          ],
        },
        properties: {},
      },
    ],
  };
}

test("future car routes use TMAP prediction time and never share a time cache", async () => {
  const savedKey = process.env.TMAP_APP_KEY;
  const originalFetch = globalThis.fetch;
  process.env.TMAP_APP_KEY = "temporal-routing-key";
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.pathname, "/tmap/routes/prediction");
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json(tmapResponse(requests.length === 1 ? 11 : 27));
  };

  try {
    const { getRoute } = await import("../lib/mobility/routing.ts");
    const firstDeparture = new Date(Date.now() + 30 * 60_000).toISOString();
    const secondDeparture = new Date(Date.now() + 90 * 60_000).toISOString();
    const first = await getRoute(points, {
      mode: "car",
      departureAt: firstDeparture,
    });
    const second = await getRoute(points, {
      mode: "car",
      departureAt: secondDeparture,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].routesInfo.predictionType, "arrival");
    /* TMAP은 `predictionTime`을 `yyyy-MM-ddTHH:mm:ss+0900`으로만 받는다.
       `toISOString()`이 주는 `…Z`를 그대로 보내면 좌표가 멀쩡해도 400
       `code 1100`이 돌아오고, 자차 경로가 한 번도 성공하지 못한다. 실호출로
       2026-08-14 확인. 그래서 형식과 **가리키는 순간**을 함께 검증한다. */
    const kstShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0900$/;
    assert.match(requests[0].routesInfo.predictionTime, kstShape);
    assert.match(requests[1].routesInfo.predictionTime, kstShape);
    const sameInstant = (sent, wanted) =>
      Math.abs(Date.parse(sent) - Date.parse(wanted)) < 1_000;
    assert.ok(
      sameInstant(requests[0].routesInfo.predictionTime, firstDeparture),
      "보낸 시각이 요청한 출발 시각과 달라졌다",
    );
    assert.ok(
      sameInstant(requests[1].routesInfo.predictionTime, secondDeparture),
      "두 번째 조회가 첫 번째 시각을 재사용했다",
    );
    assert.equal(first.status, "routed");
    assert.equal(second.status, "routed");
    assert.equal(first.durationMinutes, 11);
    assert.equal(second.durationMinutes, 27);
    assert.equal(first.timeBasis, "provider_departure_prediction");
    assert.equal(first.requestedDepartureAt, firstDeparture);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.TMAP_APP_KEY;
    else process.env.TMAP_APP_KEY = savedKey;
  }
});

/* 예전에는 미래 출발이나 도착 마감이 있으면 제공자를 부르기도 전에 실패
   폐쇄했다. 그런데 빈 시간 추천은 복귀 구간에 **항상** 도착 마감을 넘기므로,
   그 규칙은 대중교통을 고른 모든 요청을 0건으로 만들었다 — 같은 조건에서
   자전거는 결과가 나왔다. 실패 폐쇄가 제품을 더 정직하게 만든 것이 아니라
   한 수단을 영구히 비워 두었다.

   지금은 경로를 받아 쓰되 **가정을 함께 올린다**. 소요시간은 조회 시점 시각표
   기준이고, `assumesCurrentTimetable`이 그 사실을 카드까지 들고 간다. */
test("future transit routes with the current timetable and discloses the assumption", async () => {
  const savedKey = process.env.KAKAO_REST_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.KAKAO_REST_API_KEY = "temporal-routing-kakao";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      status: "OK",
      routes: [
        {
          properties: {
            totalDistance: 4_000,
            totalTime: 1_200,
            transfers: 1,
            fare: { value: 1_650 },
          },
          steps: [
            {
              properties: { type: "SUBWAY", time: 1_200 },
              path: { points: [[126.978, 37.5665], [126.982, 37.57]] },
            },
          ],
        },
      ],
    });
  };
  try {
    const { getRoute } = await import("../lib/mobility/routing.ts");
    const future = await getRoute(points, {
      mode: "transit",
      departureAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      arriveBy: new Date(Date.now() + 120 * 60_000).toISOString(),
    });
    assert.equal(future.status, "routed", "대중교통이 다시 0건이 되었다");
    assert.equal(calls, 1);
    assert.equal(future.provider, "kakao_transit");
    assert.equal(future.assumesCurrentTimetable, true);
    assert.equal(future.scheduleDependent, true);
    assert.equal(future.timeBasis, "provider_current_schedule");

    /* 가정을 붙인 결과가 "지금 출발" 조회의 답으로 재사용되면, 단서 없이
       미래 값이 현재 값 행세를 한다. 캐시가 그 둘을 갈라야 한다. */
    const live = await getRoute(points, { mode: "transit" });
    assert.equal(live.status, "routed");
    assert.equal(calls, 2, "현재 조회가 가정 붙은 캐시를 재사용했다");
    assert.equal(live.assumesCurrentTimetable, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = savedKey;
  }
});

test("walking is explicitly time-independent and may reuse geometry", async () => {
  const savedRouting = process.env.ROUTING_BASE_URL;
  const savedTmap = process.env.TMAP_APP_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ROUTING_BASE_URL = "https://temporal-osrm.test/route";
  delete process.env.TMAP_APP_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      code: "Ok",
      routes: [
        {
          distance: 1_000,
          duration: 600,
          legs: [{ distance: 1_000, duration: 600 }],
          geometry: { coordinates: [[126.978, 37.5665], [126.982, 37.57]] },
        },
      ],
    });
  };
  try {
    const { getRoute } = await import("../lib/mobility/routing.ts");
    const first = await getRoute(points, {
      mode: "walk",
      departureAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const second = await getRoute(points, {
      mode: "walk",
      departureAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    });
    assert.equal(calls, 1);
    assert.equal(first.status, "routed");
    assert.equal(second.status, "routed");
    assert.equal(first.timeBasis, "time_independent");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedRouting === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = savedRouting;
    if (savedTmap === undefined) delete process.env.TMAP_APP_KEY;
    else process.env.TMAP_APP_KEY = savedTmap;
  }
});
