import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));

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

function recoveryRequest({
  suffix,
  candidateLongitude,
  occurredAt,
  middleAt,
  fixedAt,
  minimumStayMinutes = 30,
}) {
  return {
    origin: {
      latitude: 37.5665,
      longitude: 126.978 + Number(suffix) * 0.001,
      label: "현재 위치",
      areaCode: "11",
      sigunguCode: "11110",
    },
    incident: "delay",
    availableMinutes: 120,
    maxDistanceMeters: 2_000,
    audience: "general",
    indoorOnly: false,
    radiusMeters: 5_000,
    safetyBufferMinutes: 15,
    minimumStayMinutes,
    analyticsConsent: false,
    itinerary: {
      id: `00000000-0000-4000-8000-00000000000${suffix}`,
      title: "서울 원래 일정",
      timezone: "Asia/Seoul",
      audience: "general",
      occurredAt,
      disruptedNodeId: `disrupted-${suffix}`,
      nextFixedNodeId: `fixed-${suffix}`,
      nodes: [
        {
          id: `disrupted-${suffix}`,
          sequence: 1,
          type: "visit",
          title: "원래 미술관",
          startAt: occurredAt,
          durationMinutes: 60,
          locked: false,
          reservation: false,
          location: {
            latitude: 37.5665,
            longitude: 126.978,
            label: "원래 미술관",
          },
        },
        {
          id: `middle-${suffix}`,
          sequence: 2,
          type: "meal",
          title: "원래 점심",
          startAt: middleAt,
          durationMinutes: 20,
          locked: false,
          reservation: false,
          location: {
            latitude: 37.568,
            longitude: 126.982,
            label: "원래 점심",
          },
        },
        {
          id: `fixed-${suffix}`,
          sequence: 3,
          type: "reservation",
          title: "예약 공연",
          startAt: fixedAt,
          locked: true,
          reservation: true,
          location: {
            latitude: 37.57,
            longitude: 126.986,
            label: "예약 공연",
          },
        },
      ],
    },
    __candidateLongitude: candidateLongitude,
  };
}

test("minimum-change engine routes through every original waypoint and proves preservation", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  const originalRouting = process.env.ROUTING_BASE_URL;
  const originalWeather = process.env.WEATHER_API_URL;
  let scenario = "preserved";

  process.env.KTO_SERVICE_KEY = "continuity-test-key";
  process.env.ROUTING_BASE_URL = "https://managed-routing.test/route";
  process.env.WEATHER_API_URL = "https://managed-weather.test/forecast";

  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );

    if (url.hostname === "managed-routing.test") {
      const durations =
        scenario === "preserved" ? [600, 600, 600] : [600, 900, 600];
      return Response.json({
        code: "Ok",
        routes: [
          {
            distance: 1_500,
            duration: durations.reduce((sum, value) => sum + value, 0),
            legs: durations.map((duration, index) => ({
              distance: 500 + index * 20,
              duration,
            })),
            geometry: {
              coordinates: [
                [126.978, 37.5665],
                [126.98, 37.567],
                [126.982, 37.568],
                [126.986, 37.57],
              ],
            },
          },
        ],
      });
    }

    if (url.hostname === "managed-weather.test") {
      return Response.json({
        current: {
          time: "2026-07-16T10:00",
          temperature_2m: 26,
          apparent_temperature: 27,
          precipitation: 0,
          rain: 0,
          showers: 0,
          weather_code: 1,
          wind_speed_10m: 4,
        },
        hourly: { precipitation_probability: [10] },
      });
    }

    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      items = [
        {
          contentid: scenario === "preserved" ? "candidate-a" : "candidate-b",
          contenttypeid: "14",
          title:
            scenario === "preserved" ? "대체 문화관" : "대체 전시관",
          addr1: "서울특별시 종로구",
          mapx: scenario === "preserved" ? "126.980" : "126.981",
          mapy: "37.567",
          dist: "450",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
      ];
    } else if (
      service === "TarRlteTarService1" &&
      operation === "areaBasedList1"
    ) {
      items = [
        {
          tAtsNm: "원래 미술관",
          rlteTatsNm:
            scenario === "preserved" ? "대체 문화관" : "대체 전시관",
          rlteRank: "1",
          baseYm: "202606",
        },
      ];
    } else if (
      service === "KorService2" &&
      operation === "detailIntro2"
    ) {
      items = [{ usetime: "00:00~23:59", infocenter: "02-000-0000" }];
    }

    return Response.json(ktoEnvelope(items));
  };

  try {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");

    const preservedInput = recoveryRequest({
      suffix: "1",
      candidateLongitude: 126.98,
      occurredAt: "2026-07-16T10:00:00+09:00",
      middleAt: "2026-07-16T11:10:00+09:00",
      fixedAt: "2026-07-16T12:00:00+09:00",
    });
    delete preservedInput.__candidateLongitude;
    const preserved = await recoverTrip(
      preservedInput,
      "continuity-preserved",
    );

    assert.equal(preserved.options.length, 1);
    const option = preserved.options[0];
    assert.equal(option.relatedRank, 1);
    assert.equal(
      option.purposePreservation.status,
      "verified_related_place",
    );
    assert.equal(
      option.purposePreservation.evidenceSource,
      "TarRlteTarService1",
    );
    assert.equal(option.purposePreservation.relatedRank, 1);
    assert.equal(option.scheduleDiff.changedNodeCount, 1);
    assert.equal(option.scheduleDiff.preservedWaypoints?.length, 2);
    assert.ok(
      option.scheduleDiff.preservedWaypoints?.every(
        (waypoint) => waypoint.status === "preserved",
      ),
    );
    assert.equal(
      option.scheduleDiff.nextFixedAppointmentPreserved,
      true,
    );
    assert.equal(
      option.continuityProof.routeEvidence.status,
      "routed",
    );
    assert.equal(
      option.continuityProof.routeEvidence.status === "routed"
        ? option.continuityProof.routeEvidence.legs.length
        : 0,
      3,
    );

    scenario = "minimum-relaxation";
    const nearMissInput = recoveryRequest({
      suffix: "2",
      candidateLongitude: 126.981,
      occurredAt: "2026-07-16T10:00:00+09:00",
      middleAt: "2026-07-16T10:40:00+09:00",
      fixedAt: "2026-07-16T12:00:00+09:00",
      minimumStayMinutes: 20,
    });
    delete nearMissInput.__candidateLongitude;
    const nearMiss = await recoverTrip(
      nearMissInput,
      "continuity-near-miss",
    );

    assert.equal(nearMiss.options.length, 0);
    assert.equal(
      nearMiss.counterfactual?.proofType,
      "single_constraint_minimum_relaxation",
    );
    assert.equal(
      nearMiss.counterfactual?.reasonCode,
      "CONTINUITY_WAYPOINT_AT_RISK",
    );
    assert.deepEqual(nearMiss.counterfactual?.requiredRelaxation, {
      constraint: "minimum_stay",
      amount: 5,
      unit: "minutes",
      currentLimit: 20,
      requiredLimit: 15,
      description: "최소 체류 20분 → 15분",
      preservesLockedNodes: true,
      preservesNextFixedAppointment: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = originalKey;
    if (originalRouting === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = originalRouting;
    if (originalWeather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalWeather;
  }
});

test("availability confirms the full stay interval, not only arrival time", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  const audit = {
    apiName: "KorService2",
    operation: "detailIntro2",
    status: "live",
    latencyMs: 1,
    resultCount: 1,
    totalCount: 1,
    fieldsUsed: ["usetime"],
  };

  assert.equal(
    evaluateAvailabilityItem(
      { usetime: "09:00~18:00" },
      audit,
      new Date("2026-07-16T17:50:00+09:00"),
      new Date("2026-07-16T18:20:00+09:00"),
    ).status,
    "confirmed_closed",
  );
  assert.equal(
    evaluateAvailabilityItem(
      { usetime: "09:00~18:00" },
      audit,
      new Date("2026-07-16T10:00:00+09:00"),
      new Date("2026-07-16T11:00:00+09:00"),
    ).status,
    "confirmed_open",
  );
  assert.equal(
    evaluateAvailabilityItem(
      { usetime: "하절기 09:00~18:00 · 동절기 10:00~17:00" },
      audit,
      new Date("2026-07-16T10:00:00+09:00"),
      new Date("2026-07-16T11:00:00+09:00"),
    ).status,
    "official_hours_unstructured",
  );
});

test("indoor hard evidence rejects parks even when their broad type looks cultural", async () => {
  const { hasVerifiedIndoorEvidence } = await import(
    "../lib/recovery/engine.ts"
  );

  assert.equal(
    hasVerifiedIndoorEvidence({
      contenttypeid: "14",
      title: "대한민국역사박물관",
      cat3: "A02060100",
    }),
    true,
  );
  assert.equal(
    hasVerifiedIndoorEvidence({
      contenttypeid: "14",
      title: "세종로공원",
      cat3: "A02060700",
    }),
    false,
  );
  assert.equal(
    hasVerifiedIndoorEvidence({
      contenttypeid: "14",
      title: "세종 문화 명소",
    }),
    false,
  );
  assert.equal(
    hasVerifiedIndoorEvidence({
      contenttypeid: "39",
      title: "두가헌",
    }),
    true,
  );
});

test("rain recovery never promotes an outdoor park to a verified option", async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    kto: process.env.KTO_SERVICE_KEY,
    routing: process.env.ROUTING_BASE_URL,
    weather: process.env.WEATHER_API_URL,
    kma: process.env.KMA_SERVICE_KEY,
  };
  process.env.KTO_SERVICE_KEY = "rain-indoor-regression-key";
  process.env.ROUTING_BASE_URL = "https://rain-routing.test/route";
  process.env.WEATHER_API_URL = "https://rain-weather.test/forecast";
  delete process.env.KMA_SERVICE_KEY;
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "rain-weather.test") {
      return Response.json({
        current: {
          time: "2026-07-16T10:00",
          temperature_2m: 22,
          apparent_temperature: 22,
          precipitation: 2,
          rain: 2,
          showers: 0,
          weather_code: 61,
          wind_speed_10m: 4,
        },
        hourly: { precipitation_probability: [90] },
      });
    }
    if (url.hostname === "rain-routing.test") {
      throw new Error("an outdoor candidate must be rejected before routing");
    }
    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    const items =
      service === "KorService2" && operation === "locationBasedList2"
        ? [
            {
              contentid: "outdoor-park-rain-regression",
              contenttypeid: "14",
              title: "세종로공원",
              cat3: "A02060700",
              addr1: "서울특별시 종로구",
              mapx: "126.979",
              mapy: "37.572",
              dist: "250",
              lDongRegnCd: "11",
              lDongSignguCd: "110",
            },
          ]
        : [];
    return Response.json(ktoEnvelope(items));
  };

  try {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const input = recoveryRequest({
      suffix: "6",
      candidateLongitude: 126.979,
      occurredAt: "2026-07-16T10:00:00+09:00",
      middleAt: "2026-07-16T11:10:00+09:00",
      fixedAt: "2026-07-16T12:00:00+09:00",
    });
    delete input.__candidateLongitude;
    input.incident = "rain";
    const result = await recoverTrip(input, "rain-outdoor-regression");

    assert.equal(result.options.length, 0);
    assert.notEqual(result.status, "verified");
    assert.ok(
      result.rejectionSummary.some(
        (entry) =>
          entry.reasonCode === "INDOOR_UNVERIFIED" && entry.count >= 1,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      KTO_SERVICE_KEY: previous.kto,
      ROUTING_BASE_URL: previous.routing,
      WEATHER_API_URL: previous.weather,
      KMA_SERVICE_KEY: previous.kma,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("weather uses canonical precipitation without double-counting rain and showers", async () => {
  const originalFetch = globalThis.fetch;
  const originalWeather = process.env.WEATHER_API_URL;
  process.env.WEATHER_API_URL = "https://weather-canonical.test/forecast";
  globalThis.fetch = async () =>
    Response.json({
      current: {
        time: "2026-07-16T10:00",
        temperature_2m: 24,
        apparent_temperature: 25,
        precipitation: 1.2,
        rain: 0.7,
        showers: 0.5,
        weather_code: 61,
        wind_speed_10m: 5,
      },
      hourly: { precipitation_probability: [80] },
    });

  try {
    const { getWeatherEvidence } = await import(
      "../lib/weather/service.ts"
    );
    const evidence = await getWeatherEvidence(36.1234, 127.4321);
    assert.equal(evidence.status, "available");
    assert.equal(
      evidence.status === "available"
        ? evidence.precipitationMillimeters
        : undefined,
      1.2,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWeather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalWeather;
  }
});

test("explicit public OSM URLs remain classified as shared and rate-limited providers", async () => {
  const originalReverse = process.env.REVERSE_GEOCODE_URL;
  const originalRouting = process.env.ROUTING_BASE_URL;
  process.env.REVERSE_GEOCODE_URL =
    "https://nominatim.openstreetmap.org/reverse";
  process.env.ROUTING_BASE_URL =
    "https://routing.openstreetmap.de/routed-foot/route/v1/driving";
  try {
    const {
      reverseGeocodeProviderConfig,
      routingProviderConfig,
    } = await import("../lib/external-providers.ts");
    assert.equal(reverseGeocodeProviderConfig().mode, "public_shared");
    assert.equal(routingProviderConfig().mode, "public_shared");
  } finally {
    if (originalReverse === undefined) {
      delete process.env.REVERSE_GEOCODE_URL;
    } else {
      process.env.REVERSE_GEOCODE_URL = originalReverse;
    }
    if (originalRouting === undefined) {
      delete process.env.ROUTING_BASE_URL;
    } else {
      process.env.ROUTING_BASE_URL = originalRouting;
    }
  }
});

test("provider readiness reflects each actually reachable fallback chain", async () => {
  const names = [
    "KAKAO_REST_API_KEY",
    "KMA_SERVICE_KEY",
    "REVERSE_GEOCODE_URL",
    "FORWARD_GEOCODE_URL",
    "ROUTING_BASE_URL",
    "WEATHER_API_URL",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.KAKAO_REST_API_KEY = "managed-kakao-key";
  process.env.KMA_SERVICE_KEY = "managed-kma-key";
  delete process.env.REVERSE_GEOCODE_URL;
  delete process.env.FORWARD_GEOCODE_URL;
  process.env.ROUTING_BASE_URL =
    "https://managed-routing.example/route/v1/walking";
  delete process.env.WEATHER_API_URL;
  try {
    const {
      forwardGeocodeProviderConfig,
      reverseGeocodeProviderConfig,
      routingEndpoints,
      routingProviderConfig,
      weatherProviderConfig,
    } = await import("../lib/external-providers.ts");
    assert.equal(reverseGeocodeProviderConfig().mode, "public_shared");
    assert.equal(forwardGeocodeProviderConfig().mode, "public_shared");
    assert.equal(routingProviderConfig().mode, "managed");
    assert.deepEqual(routingEndpoints(), [
      "https://managed-routing.example/route/v1/walking",
    ]);
    assert.equal(weatherProviderConfig().mode, "public_shared");

    process.env.ROUTING_BASE_URL =
      "https://managed-routing.example/route/v1/walking,https://routing.openstreetmap.de/routed-foot/route/v1/driving";
    assert.equal(routingProviderConfig().mode, "public_shared");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("recover route enforces one deadline from preflight through persistence", async () => {
  const source = await readFile(
    `${ROOT}/app/api/v1/recover/route.ts`,
    "utf8",
  );
  /* The guarantee is that one budget governs both the upstream calls and the
     persistence step — not that it holds a particular number. Pinning the
     literal made this fail when the budget was retuned against measured
     upstream latency, which is a legitimate change, so the shape is asserted
     instead: a single declared constant, reused rather than duplicated. */
  assert.match(source, /const RECOVERY_RESPONSE_BUDGET_MS = \d[\d_]*;/);
  assert.match(source, /const PERSISTENCE_COMMIT_RESERVE_MS = \d[\d_]*;/);
  assert.match(source, /deadlineAt = Date\.now\(\) \+ RECOVERY_RESPONSE_BUDGET_MS/);
  assert.match(
    source,
    /commitDeadlineAt = deadlineAt - PERSISTENCE_COMMIT_RESERVE_MS/,
  );
  assert.match(source, /deadlineController\.abort\(\)/);
  assert.match(source, /signal:\s*deadlineController\.signal/);
  assert.match(source, /beforeDeadline\(\s*allowDurableRequest\(/);
  assert.match(source, /beforeDeadline\(request\.json\(\), deadlineAt\)/);
  assert.match(source, /beforeDeadline\(\s*getOwnedSessionItinerary\(/);
  assert.match(source, /beforeDeadline\(\s*recoverTrip\(/);
  assert.match(source, /beforeDeadline\(\s*persistRecovery\(/);
  assert.match(source, /persistRecovery\([\s\S]{0,300}commitDeadlineAt/);
  assert.match(source, /RECOVERY_DEADLINE_EXCEEDED/);
  assert.match(source, /status:\s*persistenceStatus/);
  assert.match(source, /persistenceStatus[\s\S]{0,100}\? "unknown"/);
  assert.doesNotMatch(source, /저장되지 않은 후보/);
});

test("shared deadline helper resolves fast work and rejects stalled preflight work", async () => {
  const { beforeDeadline, DeadlineExceededError } = await import(
    "../lib/deadline.ts"
  );
  assert.equal(
    await beforeDeadline(Promise.resolve("ok"), Date.now() + 100),
    "ok",
  );
  await assert.rejects(
    beforeDeadline(new Promise(() => {}), Date.now() + 15),
    DeadlineExceededError,
  );
  await assert.rejects(
    beforeDeadline(Promise.resolve("late"), Date.now() - 1),
    DeadlineExceededError,
  );
  const blockedDeadline = Date.now() + 15;
  const microtaskWinsBeforeTimer = beforeDeadline(
    new Promise((resolve) => setTimeout(() => resolve("too-late"), 1)),
    blockedDeadline,
  );
  while (Date.now() < blockedDeadline + 10) {
    // Deliberately block the event loop so the earlier work timer resolves
    // before the deadline timer; the absolute-time recheck must still reject.
  }
  await assert.rejects(microtaskWinsBeforeTimer, DeadlineExceededError);
});

test("partner recovery and operator control use different bearer secrets", async () => {
  const [auth, partner, ops] = await Promise.all([
    readFile(`${ROOT}/lib/auth.ts`, "utf8"),
    readFile(`${ROOT}/app/api/v1/partner/recover/route.ts`, "utf8"),
    readFile(`${ROOT}/app/api/v1/ops/sync/route.ts`, "utf8"),
  ]);
  assert.match(auth, /authenticateBearer\(authorization,\s*"PARTNER_API_KEY"\)/);
  assert.match(auth, /authenticateBearer\(authorization,\s*"OPS_API_KEY"\)/);
  assert.match(partner, /authenticatePartner/);
  assert.doesNotMatch(partner, /authenticateOps/);
  assert.match(ops, /authenticateOps/);
  assert.doesNotMatch(ops, /authenticatePartner/);
});

test("KorService2 detailCommon2 omits retired selector flags", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  process.env.KTO_SERVICE_KEY = "detail-contract-test-key";
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return Response.json(
      ktoEnvelope([
        {
          contentid: "1604784",
          contenttypeid: "14",
          title: "서울역사박물관",
          mapx: "126.9707",
          mapy: "37.5704",
        },
      ]),
    );
  };

  try {
    const { getTourismCommonDetail } = await import(
      "../lib/kto/adapters.ts"
    );
    const result = await getTourismCommonDetail("1604784");
    assert.equal(result.items.length, 1);
    assert.equal(requestedUrl.searchParams.get("contentId"), "1604784");
    for (const retired of [
      "defaultYN",
      "firstImageYN",
      "areacodeYN",
      "catcodeYN",
      "addrinfoYN",
      "mapinfoYN",
      "overviewYN",
    ]) {
      assert.equal(requestedUrl.searchParams.has(retired), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = originalKey;
  }
});

/* 경유지가 있는 경로는 구간별 결과가 있어야 한다. 엔진은 경유지마다 도착을
   검증하므로 합계 하나만 오면 그 후보를 통째로 탈락시킨다. 배포본 실측에서
   라우팅까지 도달한 후보가 매번 전부 ROUTE_UNAVAILABLE로 떨어져 대안이 하나도
   제시되지 않았고, 원인이 정확히 이것이었다. */
test("a waypointed TMAP route reports one leg per segment", async () => {
  const { getTmapPedestrianRoute } = await import(
    "../lib/mobility/tmap-pedestrian.ts"
  );
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.TMAP_APP_KEY;
  process.env.TMAP_APP_KEY = "tmap-leg-test-key";
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [body.startX, body.startY] },
            properties: { totalDistance: 500, totalTime: 600 },
          },
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [body.startX, body.startY],
                [body.endX, body.endY],
              ],
            },
            properties: {},
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const points = [
      { latitude: 37.5665, longitude: 126.978 },
      { latitude: 37.5658, longitude: 126.9751 },
      { latitude: 37.5693, longitude: 126.9788 },
    ];
    const route = await getTmapPedestrianRoute(points);
    assert.ok(route);
    /* 엔진의 통과 조건과 같은 식으로 확인한다. */
    assert.ok(route.legs.length >= points.length - 1);
    assert.equal(route.legs.length, 2);
    assert.equal(calls.length, 2, "구간마다 한 번씩 호출해야 한다");
    /* 두 번째 호출의 출발점은 첫 번째의 도착점이어야 한다. */
    assert.equal(calls[0].endX, calls[1].startX);
    assert.equal(calls[0].endY, calls[1].startY);
    assert.equal(route.distanceMeters, 1000);
    assert.equal(route.durationMinutes, 20);
    /* 경유지 좌표가 두 번 들어가지 않아야 한다. */
    assert.equal(route.geometry.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TMAP_APP_KEY;
    else process.env.TMAP_APP_KEY = previousKey;
  }
});

/* 활동 유형이 바뀐 후보는 마지막 수단이어야 한다. 목적 점수는 총점의 18%뿐이라
   가까운 식당이 먼 박물관을 제치고 첫 카드가 되는 일이 배포본 측정에서 실제로
   나왔고, `minimum_change` 정렬은 목적을 아예 보지 않는다. 그래서 순위가 아니라
   후보 풀에서 가른다. */
test("category-changed candidates are only offered when nothing preserves the purpose", async () => {
  const source = await readFile(`${ROOT}/lib/recovery/engine.ts`, "utf8");
  const pickOptions =
    source.match(/function pickOptions\([\s\S]*?\n\}/)?.[0] ?? "";

  assert.ok(pickOptions, "pickOptions source must be present");
  assert.match(
    pickOptions,
    /purposePreservation\.status !== "changed_visit_category"/,
  );
  assert.match(
    pickOptions,
    /const pool = purposePreserving\.length \? purposePreserving : candidates/,
  );
  /* 모든 정렬이 걸러진 풀을 써야 한다. 하나라도 원본을 보면 그 축으로 뽑힌
     카드에 바뀐 후보가 다시 올라온다. */
  assert.doesNotMatch(pickOptions, /\[\.\.\.candidates\]/);
  const poolSorts = pickOptions.match(/\[\.\.\.pool\]/g) ?? [];
  assert.ok(poolSorts.length >= 5, "모든 선택 축이 풀을 써야 한다");
  /* 목적을 지키는 후보가 없을 때 결과가 0개가 되면 안 된다. */
  assert.match(pickOptions, /: candidates;/);
});
