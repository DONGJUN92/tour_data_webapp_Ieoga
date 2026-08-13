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
    assert.equal(requests[0].routesInfo.predictionTime, firstDeparture);
    assert.equal(requests[1].routesInfo.predictionTime, secondDeparture);
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

test("future transit fails closed before calling a provider without time routing", async () => {
  const savedKey = process.env.KAKAO_REST_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.KAKAO_REST_API_KEY = "temporal-routing-kakao";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("future transit must not call current-time routing");
  };
  try {
    const { getRoute } = await import("../lib/mobility/routing.ts");
    const result = await getRoute(points, {
      mode: "transit",
      departureAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /cannot verify.*future departure/i);
    assert.equal(calls, 0);
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
