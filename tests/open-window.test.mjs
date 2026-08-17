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

/* 두 후보를 돌려준다. 하나는 가깝고 하나는 멀어, 창을 넘기는 후보만 탈락하는지
   구분해서 볼 수 있다. */
function nearbyItems() {
  return [
    {
      contentid: "near-1",
      contenttypeid: "14",
      title: "가까운 문화관",
      addr1: "서울특별시 종로구",
      mapx: "126.980",
      mapy: "37.567",
      dist: "450",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
      modifiedtime: "20260716",
    },
    {
      contentid: "far-1",
      contenttypeid: "14",
      title: "먼 전시관",
      addr1: "서울특별시 종로구",
      mapx: "126.995",
      mapy: "37.575",
      dist: "1900",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
      modifiedtime: "20260716",
    },
  ];
}

function installFetch({ legSecondsByCandidate, routePaths }) {
  const originalFetch = globalThis.fetch;
  let availabilityRequestCount = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );

    if (url.hostname === "managed-routing.test") {
      /* OSRM 호환 경로는 좌표를 path에 붙인다. 두 번째 좌표의 경도로 어느
         후보에 대한 호출인지 구분한다. */
      const coordinates = url.pathname.split("/").pop() ?? "";
      routePaths.push(coordinates);
      const routeCoordinates = coordinates.replace(/^[^:]+:/, "");
      const isFar = routeCoordinates.includes("126.995");
      const configured = isFar
        ? legSecondsByCandidate.far
        : legSecondsByCandidate.near;
      const candidateLongitude = isFar ? "126.995" : "126.98";
      const isOriginReturn = routeCoordinates.startsWith(candidateLongitude);
      const durations = Array.isArray(configured)
        ? configured
        : configured?.[isOriginReturn ? "return" : "outbound"];
      if (!durations) {
        return Response.json({ code: "NoRoute", routes: [] });
      }
      return Response.json({
        code: "Ok",
        routes: [
          {
            distance: isFar ? 1_900 : 450,
            duration: durations.reduce((sum, value) => sum + value, 0),
            legs: durations.map((duration, index) => ({
              distance: (isFar ? 1_900 : 450) / durations.length + index,
              duration,
            })),
            geometry: {
              coordinates: [
                [126.978, 37.5665],
                [126.98, 37.567],
              ],
            },
          },
        ],
      });
    }

    if (url.hostname === "managed-weather.test") {
      return Response.json({
        current: {
          time: "2026-08-04T10:00",
          temperature_2m: 28,
          apparent_temperature: 30,
          precipitation: 0,
          rain: 0,
          showers: 0,
          weather_code: 1,
          wind_speed_10m: 5,
        },
        hourly: { precipitation_probability: [10] },
      });
    }

    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      items = nearbyItems();
    } else if (service === "KorService2" && operation === "detailIntro2") {
      availabilityRequestCount += 1;
      const availabilityMode =
        legSecondsByCandidate.availability ?? "confirmed_open";
      if (
        availabilityMode === "upstream_error" ||
        ((availabilityMode === "partial_upstream_error" ||
          availabilityMode === "partial_upstream_error_no_valid") &&
          availabilityRequestCount === 2)
      ) {
        return new Response("upstream unavailable", { status: 503 });
      }
      const effectiveAvailabilityMode =
        availabilityMode === "partial_upstream_error_no_valid"
          ? "unconfirmed"
          : availabilityMode;
      items =
        effectiveAvailabilityMode === "confirmed_closed"
          ? [{ eventenddate: "20000101", infocenter: "02-000-0000" }]
          : effectiveAvailabilityMode === "unconfirmed"
            ? [{ infocenter: "02-000-0000" }]
            : [
                {
                  usetimeculture: "24시간",
                  restdateculture: "연중무휴",
                  infocenter: "02-000-0000",
                },
              ];
    }
    return Response.json(ktoEnvelope(items));
  };
  return originalFetch;
}

function openWindowRequest(overrides = {}) {
  return {
    origin: {
      latitude: 37.5665,
      longitude: 126.978,
      label: "현재 위치",
      areaCode: "11",
      sigunguCode: "11110",
    },
    incident: "delay",
    availableMinutes: 180,
    maxDistanceMeters: 3_000,
    audience: "general",
    indoorOnly: false,
    radiusMeters: 5_000,
    safetyBufferMinutes: 15,
    minimumStayMinutes: 30,
    analyticsConsent: false,
    ...overrides,
  };
}

async function withMockedEnvironment(legSecondsByCandidate, run) {
  const originalKey = process.env.KTO_SERVICE_KEY;
  const originalRouting = process.env.ROUTING_BASE_URL;
  const originalWeather = process.env.WEATHER_API_URL;
  process.env.KTO_SERVICE_KEY = "open-window-test-key";
  process.env.ROUTING_BASE_URL = "https://managed-routing.test/route";
  process.env.WEATHER_API_URL = "https://managed-weather.test/forecast";
  const routePaths = [];
  const originalFetch = installFetch({ legSecondsByCandidate, routePaths });
  try {
    return await run(routePaths);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = originalKey;
    if (originalRouting === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = originalRouting;
    if (originalWeather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalWeather;
  }
}

test("빈 시간 추천은 일정 없이 실행되고 창 안에 들어가는 후보만 제시한다", async () => {
  await withMockedEnvironment(
    /* 가까운 후보는 왕복 10분+10분, 먼 후보는 왕복 50분+50분. 창은 105분,
       체류 60분과 안전여유 15분을 더해도 가까운 후보만 통과한다. */
    { near: [600], far: [3_000] },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const now = Date.now();
      const result = await recoverTrip(
        openWindowRequest({
          openWindow: {
            availableUntil: new Date(now + 105 * 60_000).toISOString(),
            plannedStayMinutes: 60,
          },
        }),
        "open-window-basic",
      );

      assert.equal(result.recoveryMode, "open_window");
      assert.ok(
        result.options.length >= 1,
        "창 안에 들어가는 후보가 최소 한 개는 남아야 한다",
      );
      assert.equal(
        result.itinerarySummary?.disruptedNodeId,
        undefined,
        "교체할 일정이 없으므로 중단 노드는 비어 있어야 한다",
      );
      assert.equal(result.openWindowSummary?.plannedStayMinutes, 60);

      for (const option of result.options) {
        assert.equal(option.scheduleDiff.changeKind, "insert");
        assert.equal(
          option.scheduleDiff.changedNodeCount,
          0,
          "끼워 넣기이므로 바뀐 일정은 0곳이어야 한다",
        );
        assert.equal(option.scheduleDiff.replacedNodeId, undefined);
        assert.equal(option.scheduleDiff.originalNode, undefined);
        assert.equal(
          option.continuityProof.objective,
          "maximize_fit_within_open_window",
        );
        const window = option.scheduleDiff.openWindow;
        assert.ok(window, "창 증명이 있어야 한다");
        assert.equal(window.status, "fits");
        assert.ok(
          window.leftoverMinutes >= window.requiredBufferMinutes,
          "복귀 뒤 안전여유를 확보하지 못한 후보가 제시되어서는 안 된다",
        );
        assert.equal(window.requiredBufferMinutes, 15);
        assert.equal(window.returnBasis, "origin_return_route");
        assert.equal(window.returnProvider, "openstreetmap_osrm");
        assert.ok(window.returnDistanceMeters > 0);
        assert.ok(Number.isFinite(Date.parse(window.returnCalculatedAt)));
      }

      const overflow = result.rejectionSummary.find(
        (entry) => entry.reasonCode === "OPEN_WINDOW_OVERFLOW",
      );
      assert.ok(
        overflow && overflow.count >= 1,
        "창을 넘긴 후보는 사유와 함께 탈락해야 한다",
      );
    },
  );
});

test("미래 출발은 대기시간을 제외하고 그 시각부터 경로·체류·복귀를 계산한다", async () => {
  await withMockedEnvironment(
    { near: [600], far: [3_000] },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const now = Date.now();
      const departureAt = new Date(now + 60 * 60_000).toISOString();
      const availableUntil = new Date(now + 180 * 60_000).toISOString();
      const result = await recoverTrip(
        openWindowRequest({
          /* API가 두 시각 사이의 실제 120분으로 재계산한 값과 동일하게 보낸다. */
          availableMinutes: 120,
          openWindow: {
            departureAt,
            availableUntil,
            plannedStayMinutes: 30,
          },
        }),
        "open-window-future-departure",
      );

      assert.equal(result.openWindowSummary?.windowStartAt, departureAt);
      assert.equal(result.openWindowSummary?.windowEndAt, availableUntil);
      assert.equal(result.openWindowSummary?.windowMinutes, 120);
      assert.ok(result.options.length > 0);
      for (const option of result.options) {
        const visitStart = Date.parse(option.scheduleDiff.replacementNode.startAt);
        assert.ok(
          visitStart >= Date.parse(departureAt),
          "대기 중에 방문이 시작된 것처럼 계산해서는 안 된다",
        );
        assert.equal(option.scheduleDiff.openWindow?.windowStartAt, departureAt);
        assert.equal(option.scheduleDiff.openWindow?.windowMinutes, 120);
      }
    },
  );
});

test("첫 페이지 후보가 모두 부적합하면 다음 KTO 페이지까지 탐색해 검증 후보를 보충한다", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  const originalRouting = process.env.ROUTING_BASE_URL;
  const originalWeather = process.env.WEATHER_API_URL;
  process.env.KTO_SERVICE_KEY = "open-window-pagination-key";
  process.env.ROUTING_BASE_URL = "https://managed-routing.test/route";
  process.env.WEATHER_API_URL = "https://managed-weather.test/forecast";
  const requestedPages = [];
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "managed-routing.test") {
      return Response.json({
        code: "Ok",
        routes: [
          {
            distance: 800,
            duration: 600,
            legs: [{ distance: 800, duration: 600 }],
            geometry: {
              coordinates: [
                [127.031, 37.601],
                [127.032, 37.602],
              ],
            },
          },
        ],
      });
    }
    if (url.hostname === "managed-weather.test") {
      return Response.json({
        current: {
          time: "2026-08-13T10:00",
          temperature_2m: 26,
          apparent_temperature: 27,
          precipitation: 0,
          rain: 0,
          showers: 0,
          weather_code: 1,
          wind_speed_10m: 3,
        },
        hourly: { precipitation_probability: [0] },
      });
    }

    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    let totalCount = 0;
    if (service === "KorService2" && operation === "locationBasedList2") {
      const pageNo = Number(url.searchParams.get("pageNo") ?? 1);
      requestedPages.push(pageNo);
      totalCount = 101;
      items =
        pageNo === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              contentid: `invalid-page-one-${index}`,
              contenttypeid: "14",
              title: `좌표 없는 후보 ${index}`,
              mapx: "",
              mapy: "",
            }))
          : [
              {
                contentid: "valid-page-two",
                contenttypeid: "14",
                title: "두 번째 페이지 문화관",
                addr1: "서울특별시 성북구",
                mapx: "127.032",
                mapy: "37.602",
                dist: "800",
                lDongRegnCd: "11",
                lDongSignguCd: "290",
                lclsSystm1: "VE",
                lclsSystm2: "VE07",
                modifiedtime: "20260813",
              },
            ];
    } else if (service === "KorService2" && operation === "detailIntro2") {
      totalCount = 1;
      items = [{ usetimeculture: "24시간", restdateculture: "연중무휴" }];
    }
    return Response.json({
      response: {
        header: { resultCode: "0000", resultMsg: "OK" },
        body: {
          items: items.length ? { item: items } : "",
          totalCount,
          pageNo: Number(url.searchParams.get("pageNo") ?? 1),
          numOfRows: 100,
        },
      },
    });
  };

  try {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const now = Date.now();
    const result = await recoverTrip(
      openWindowRequest({
        origin: {
          latitude: 37.601,
          longitude: 127.031,
          label: "페이지 확장 테스트 출발지",
          areaCode: "11",
          sigunguCode: "11290",
        },
        openWindow: {
          availableUntil: new Date(now + 180 * 60_000).toISOString(),
          plannedStayMinutes: 30,
        },
      }),
      "open-window-adaptive-pagination",
      { deadlineAt: Date.now() + 20_000 },
    );
    assert.ok(requestedPages.includes(2), "KTO 두 번째 페이지를 조회하지 않았다");
    assert.ok(
      result.options.some((option) => option.contentId === "valid-page-two"),
      "첫 페이지 탈락 뒤 다음 페이지의 검증 가능 후보를 보충하지 않았다",
    );
    /* 지켜야 할 것은 "20km"라는 숫자가 아니라 **실제로 훑어본 범위를 밝히는
       것**이다. 탐색 반경을 시간 예산에서 유도하게 된 뒤에는 그 값이 요청마다
       다르므로, 20km 문구를 못박으면 오히려 거짓을 강제하게 된다. 반경이 좁아진
       경우에는 좁혔다는 사실과 그 값을, 상한에 닿은 경우에는 상한을 밝힌다. */
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.includes("최대 검색 범위 20km") ||
          /반경 [\d.]+km 안에서 후보를 찾았습니다/.test(warning),
      ),
      `실제로 탐색한 반경을 숨겨서는 안 된다. 실제 경고: ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = originalKey;
    if (originalRouting === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = originalRouting;
    if (originalWeather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalWeather;
  }
});

test("왕복 빈시간은 경계 도착이 아니라 선언한 안전여유까지 남아야 통과한다", async () => {
  await withMockedEnvironment(
    { near: [300], far: [3_000] },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const tight = await recoverTrip(
        openWindowRequest({
          origin: {
            ...openWindowRequest().origin,
            latitude: 37.5672,
          },
          openWindow: {
            /* 왕복 10분 + 체류 30분 뒤 약 4분만 남는다. 예전의 >=0
               계약에서는 실행 가능한 추천으로 잘못 통과했다. */
            availableUntil: new Date(Date.now() + 45 * 60_000).toISOString(),
            plannedStayMinutes: 30,
          },
        }),
        "open-window-zero-slack-rejected",
      );
      /* 안전여유를 지키는 것이 이 테스트의 핵심 계약이다. 45분 창에 체류 30분과
         안전여유 15분을 넣으면 이동에 쓸 수 있는 시간이 0분이므로 통과하는 후보가
         있어서는 안 된다. */
      assert.equal(tight.options.length, 0);
      /* **왜** 비었는지는 설명되어야 한다. 다만 어느 경로로 설명하든 상관없다 —
         후보를 하나씩 검증해 창 초과로 떨어뜨렸거나(`OPEN_WINDOW_OVERFLOW`),
         후보를 보기 전에 요청 자체가 불가능하다고 판정했거나(`input_infeasible`).
         후자가 더 낫다: 외부 조회를 한 건도 쓰지 않고, 무엇을 얼마나 바꾸면
         되는지까지 함께 돌려준다. 채널을 못박으면 그 개선이 회귀로 보인다. */
      const tightExplained =
        tight.rejectionSummary.some(
          (entry) => entry.reasonCode === "OPEN_WINDOW_OVERFLOW",
        ) ||
        (tight.status === "input_infeasible" &&
          tight.inputFeasibility?.shortfallMinutes > 0 &&
          tight.inputFeasibility.remedies.length > 0);
      assert.ok(
        tightExplained,
        `창을 넘긴 이유가 설명되지 않았다. status=${tight.status}, 사유=${JSON.stringify(tight.rejectionSummary)}, 실행가능성=${JSON.stringify(tight.inputFeasibility)}`,
      );

      const safe = await recoverTrip(
        openWindowRequest({
          origin: {
            ...openWindowRequest().origin,
            latitude: 37.5673,
          },
          openWindow: {
            availableUntil: new Date(Date.now() + 56 * 60_000).toISOString(),
            plannedStayMinutes: 30,
          },
        }),
        "open-window-buffer-preserved",
      );
      const near = safe.options.find((option) => option.contentId === "near-1");
      assert.ok(near);
      assert.equal(near.scheduleDiff.openWindow?.requiredBufferMinutes, 15);
      assert.ok((near.scheduleDiff.openWindow?.leftoverMinutes ?? 0) >= 15);
    },
  );
});

test("왕복 빈시간은 비대칭 역방향 경로를 별도 조회해 실제 복귀시간을 사용한다", async () => {
  await withMockedEnvironment(
    {
      near: { outbound: [300], return: [2_400] },
      far: { outbound: [3_000], return: [3_000] },
    },
    async (routePaths) => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const now = Date.now();
      const result = await recoverTrip(
        openWindowRequest({
          origin: {
            ...openWindowRequest().origin,
            latitude: 37.5666,
          },
          openWindow: {
            availableUntil: new Date(now + 120 * 60_000).toISOString(),
            plannedStayMinutes: 30,
          },
        }),
        "open-window-asymmetric-return",
      );

      const option = result.options.find(
        (candidate) => candidate.contentId === "near-1",
      );
      assert.ok(option);
      assert.equal(option.scheduleDiff.openWindow?.travelToMinutes, 5);
      assert.equal(option.scheduleDiff.openWindow?.returnMinutes, 40);
      assert.equal(
        option.scheduleDiff.openWindow?.returnBasis,
        "origin_return_route",
      );
      assert.ok(routePaths.length >= 2);
      assert.ok(
        routePaths.every((path) => !/^(?:walk|car|transit|bicycle):/.test(path)),
        "경로 공급자 URL에 내부 캐시 네임스페이스가 유출되면 안 된다",
      );
    },
  );
});

test("역방향 복귀 경로가 없으면 왕복 빈시간 후보를 실패 폐쇄한다", async () => {
  await withMockedEnvironment(
    {
      near: { outbound: [300], return: null },
      far: { outbound: [600], return: null },
    },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        openWindowRequest({
          origin: {
            ...openWindowRequest().origin,
            latitude: 37.5667,
          },
          openWindow: {
            availableUntil: new Date(Date.now() + 180 * 60_000).toISOString(),
            plannedStayMinutes: 30,
          },
        }),
        "open-window-return-unavailable",
      );

      assert.equal(result.options.length, 0);
      assert.ok(
        result.rejectionSummary.some(
          (entry) => entry.reasonCode === "ROUTE_UNAVAILABLE",
        ),
      );
    },
  );
});

/* 세 가지는 이름이 비슷하지만 여행자에게는 전혀 다른 상황이고, 빈 시간 추천은
   그 셋을 다르게 다룬다.

   - 휴무로 **확인된** 곳: 제외한다. 확인하지 못한 것이 아니라 확인된 사실이고,
     한 번 더 물어본다고 문이 열리지 않는다.
   - 제공자에 **연결하지 못한** 곳: 제외한다. 우리가 아무것도 받지 못했으므로
     보여 줄 근거 자체가 없다. 다시 시도하면 달라질 수 있다.
   - 응답은 받았지만 운영시간을 **대조하지 못한** 곳: 보여 준다. 원문은 우리가
     들고 있고 사람은 그것을 읽을 수 있다. 목록에서 지우면 여행자는 그런 곳이
     있었다는 사실조차 모른 채 "갈 곳이 없다"를 본다. 대신 일정에 넣기 전에
     확인을 받는다. */
test("휴무·제공자 장애는 제외하고, 운영시간 미대조는 확인을 받고 제안한다", async () => {
  const scenarios = [
    {
      mode: "confirmed_closed",
      latitude: 37.5668,
      reasonCode: "OFFICIALLY_CLOSED",
      status: "no_valid_candidate",
      offered: false,
    },
    {
      mode: "unconfirmed",
      latitude: 37.5669,
      /* 조건이 붙은 결과이므로 전체 응답도 완전 검증이라고 말하지 않는다. */
      status: "degraded",
      offered: true,
    },
    {
      mode: "upstream_error",
      latitude: 37.5671,
      reasonCode: "OPERATING_STATUS_UPSTREAM_UNAVAILABLE",
      status: "upstream_unavailable",
      offered: false,
    },
  ];

  for (const scenario of scenarios) {
    await withMockedEnvironment(
      {
        near: [300],
        far: [600],
        availability: scenario.mode,
      },
      async () => {
        const { recoverTrip } = await import("../lib/recovery/engine.ts");
        const result = await recoverTrip(
          openWindowRequest({
            origin: {
              ...openWindowRequest().origin,
              latitude: scenario.latitude,
            },
            openWindow: {
              availableUntil: new Date(
                Date.now() + 180 * 60_000,
              ).toISOString(),
              plannedStayMinutes: 30,
            },
          }),
          `availability-${scenario.mode}`,
        );

        if (scenario.offered) {
          const { optionApplicationSafety } = await import(
            "../app/traveler-safety.ts"
          );
          assert.ok(
            result.options.length > 0,
            "운영시간을 대조하지 못했다는 이유로 목록에서 지우지 않는다",
          );
          for (const option of result.options) {
            /* 카드가 그 사실을 말할 수 있어야 한다. */
            assert.ok(
              option.evidenceGaps.some(
                (gap) => gap.code === "OPERATING_HOURS_UNVERIFIED",
              ),
              "확인하지 못한 사실을 근거 공백으로 남겨야 한다",
            );
            const safety = optionApplicationSafety(option, "ko");
            assert.equal(
              safety.hoursUnconfirmedOnly,
              true,
              "넣기 전에 확인을 받아야 하는 상태로 표시되어야 한다",
            );
          }
        } else {
          assert.equal(result.options.length, 0, scenario.mode);
          assert.ok(
            result.rejectionSummary.some(
              (entry) => entry.reasonCode === scenario.reasonCode,
            ),
            scenario.mode,
          );
        }
        assert.equal(result.status, scenario.status, scenario.mode);
        if (scenario.mode === "upstream_error") {
          const detailAudits = result.sourceLedger.filter(
            (audit) => audit.operation === "detailIntro2",
          );
          assert.ok(detailAudits.length > 0);
          assert.ok(
            detailAudits.every((audit) => audit.status === "error"),
            "모든 상세 운영정보 조회가 실패한 경우에만 전체 제공자 장애다",
          );
        }
      },
    );
  }
});

test("상세 운영정보 한 건 실패를 공급자 전체 장애 503으로 승격하지 않는다", async () => {
  await withMockedEnvironment(
    {
      near: [300],
      far: [600],
      availability: "partial_upstream_error",
    },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        openWindowRequest({
          openWindow: {
            availableUntil: new Date(
              Date.now() + 180 * 60_000,
            ).toISOString(),
            plannedStayMinutes: 30,
          },
        }),
        "availability-partial-upstream-error",
      );

      assert.ok(result.options.length >= 1);
      assert.equal(result.status, "degraded");
      assert.ok(
        result.sourceLedger.some(
          (audit) =>
            audit.operation === "detailIntro2" &&
            audit.status === "live",
        ),
      );
      assert.ok(
        result.sourceLedger.some(
          (audit) =>
            audit.operation === "detailIntro2" &&
            audit.status === "error",
        ),
      );
    },
  );
});

/* 조회에 실패한 후보와, 응답은 받았지만 대조하지 못한 후보가 섞여 있는 경우.
   전자는 제외되고 후자는 확인을 받고 제안되므로 결과가 0개는 아니지만, 한 건의
   실패를 제공자 전체 장애 503으로 승격하지 않는다는 계약은 그대로다. */
test("상세 운영정보 일부 실패는 제공자 전체 장애가 아니다", async () => {
  await withMockedEnvironment(
    {
      near: [300],
      far: [600],
      availability: "partial_upstream_error_no_valid",
    },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        openWindowRequest({
          openWindow: {
            availableUntil: new Date(
              Date.now() + 180 * 60_000,
            ).toISOString(),
            plannedStayMinutes: 30,
          },
        }),
        "availability-partial-error-empty-result",
      );

      assert.notEqual(
        result.status,
        "upstream_unavailable",
        "일부 조회 실패는 검증되지 않은 해당 후보만 제외하며 전체 503이 아니다",
      );
      assert.ok(
        result.rejectionSummary.some(
          (entry) =>
            entry.reasonCode === "OPERATING_STATUS_UPSTREAM_UNAVAILABLE" &&
            entry.count >= 1,
        ),
      );
      const detailAudits = result.sourceLedger.filter(
        (audit) => audit.operation === "detailIntro2",
      );
      assert.ok(detailAudits.some((audit) => audit.status === "live"));
      assert.ok(detailAudits.some((audit) => audit.status === "error"));

      const route = await readFile(
        `${ROOT}/app/api/v1/recover/route.ts`,
        "utf8",
      );
      assert.match(
        route,
        /status:\s*result\.status\s*===\s*"upstream_unavailable"\s*\?\s*503\s*:\s*200/,
        "no_valid_candidate는 API에서 HTTP 200으로 전달돼야 한다",
      );
    },
  );
});

test("다음 장소를 알려 주면 그 도착까지 검증하고 목적 근거를 그 장소로 삼는다", async () => {
  await withMockedEnvironment(
    { near: [600, 600], far: [3_000, 3_000] },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const now = Date.now();
      const arriveBy = new Date(now + 120 * 60_000).toISOString();
      const result = await recoverTrip(
        openWindowRequest({
          openWindow: {
            availableUntil: arriveBy,
            plannedStayMinutes: 60,
            nextPlace: {
              latitude: 37.57,
              longitude: 126.99,
              label: "예약한 저녁 식당",
              areaCode: "11",
              sigunguCode: "11110",
              arriveBy,
            },
          },
        }),
        "open-window-next-place",
      );

      assert.equal(result.recoveryMode, "open_window");
      assert.equal(
        result.openWindowSummary?.nextPlaceLabel,
        "예약한 저녁 식당",
      );
      assert.ok(result.options.length >= 1);

      for (const option of result.options) {
        assert.equal(option.scheduleDiff.changedNodeCount, 0);
        assert.equal(
          option.scheduleDiff.nextFixedAppointment?.title,
          "예약한 저녁 식당",
          "알려 준 다음 장소가 도착 검증 대상이어야 한다",
        );
        assert.equal(
          option.scheduleDiff.nextFixedAppointmentPreserved,
          true,
        );
        assert.equal(
          option.scheduleDiff.openWindow?.returnBasis,
          "next_place_route",
        );
        assert.equal(
          option.purposePreservation.status,
          "open_window_flow",
          "다음 장소가 있으면 그 장소와의 연결로 설명해야 한다",
        );
        assert.equal(
          option.purposePreservation.originalStopTitle,
          "예약한 저녁 식당",
        );
      }
    },
  );
});

test("원래 계획을 모르면 목적을 유지했다고 주장하지 않는다", async () => {
  await withMockedEnvironment({ near: [600], far: [3_000] }, async () => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      openWindowRequest({
        openWindow: {
          availableUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
          plannedStayMinutes: 60,
        },
      }),
      "open-window-no-claim",
    );

    for (const option of result.options) {
      assert.equal(
        option.purposePreservation.status,
        "open_window_unconstrained",
      );
      assert.equal(
        option.purposePreservation.evidenceSource,
        "none",
        "보존할 목적이 없으면 공사 API를 목적 근거로 표기하지 않아야 한다",
      );
      /* 예전에는 "목적 유지 여부는 판단하지 않았습니다"라는 문장이 있는지
         봤다. 그 문장은 모든 카드에 똑같이 붙는 내부 판정 기록이라 지웠다.
         지켜야 할 것은 문장이 아니라 **주장하지 않는다**는 사실이므로,
         유지했다고 말하지 않는지를 확인한다. */
      assert.ok(
        !/목적을 (유지|보존)|같은 (관광|체험) 목적으로 이어/.test(
          option.purposePreservation.statement,
        ),
        `보존할 목적이 없는데 유지했다고 주장했다: ${option.purposePreservation.statement}`,
      );
    }
    assert.ok(
      !result.warnings.some((warning) =>
        /목적을 (유지|보존)했/.test(warning),
      ),
      "화면 경고에서도 목적 보존을 주장해서는 안 된다",
    );
  });
});

test("입력 스키마는 두 진입 경로를 배타로 강제하고 시간을 30분 격자로 받는다", async () => {
  const { recoveryRequestSchema } = await import(
    "../lib/recovery/schema.ts"
  );
  const base = openWindowRequest();
  const until = new Date(Date.now() + 90 * 60_000).toISOString();

  const neither = recoveryRequestSchema.safeParse(base);
  assert.equal(neither.success, false, "둘 다 없으면 거절해야 한다");

  const both = recoveryRequestSchema.safeParse({
    ...base,
    openWindow: { availableUntil: until, plannedStayMinutes: 60 },
    itinerary: {
      id: "00000000-0000-4000-8000-000000000001",
      title: "일정",
      timezone: "Asia/Seoul",
      audience: "general",
      disruptedNodeId: "a",
      nodes: [
        {
          id: "a",
          type: "visit",
          title: "가",
          startAt: until,
          locked: false,
          reservation: false,
        },
        {
          id: "b",
          type: "reservation",
          title: "나",
          startAt: until,
          locked: true,
          reservation: true,
          location: { latitude: 37.5, longitude: 127, label: "나" },
        },
      ],
    },
  });
  assert.equal(both.success, false, "둘을 함께 보내면 거절해야 한다");

  const offGrid = recoveryRequestSchema.safeParse({
    ...base,
    openWindow: { availableUntil: until, plannedStayMinutes: 45 },
  });
  assert.equal(
    offGrid.success,
    false,
    "체류 시간은 30분 배수만 허용해야 한다",
  );

  const onGrid = recoveryRequestSchema.safeParse({
    ...base,
    openWindow: { availableUntil: until, plannedStayMinutes: 90 },
  });
  assert.equal(onGrid.success, true);

  const departureAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const futureDeparture = recoveryRequestSchema.safeParse({
    ...base,
    openWindow: { departureAt, availableUntil: until, plannedStayMinutes: 60 },
  });
  assert.equal(futureDeparture.success, true);
  const reversedWindow = recoveryRequestSchema.safeParse({
    ...base,
    openWindow: {
      departureAt: until,
      availableUntil: until,
      plannedStayMinutes: 60,
    },
  });
  assert.equal(
    reversedWindow.success,
    false,
    "출발이 종료와 같거나 늦은 창은 거절해야 한다",
  );
});

test("새 탭이 링크·키보드·탭목록 어디에서도 빠지지 않는다", async () => {
  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  /* 탭을 추가할 때 같이 늘려야 하는 세 곳. 하나라도 빠지면 화면은 있는데
     링크나 키보드로는 닿지 않는 상태가 된다. 실제로 구현 중 URL 화이트리스트를
     빼먹어 공유 링크가 조용히 첫 탭으로 떨어졌다. */
  /* 여행자 탭은 둘만 남겼다. `insights`(지역 개선 미션)는 이 앱의 정체성과
     무관하고, `transparency`(데이터 투명성)는 여행 중에 급히 쓰는 화면의 첫
     줄에 있을 내용이 아니다 — 출처와 갱신 시각은 궁금할 때 찾아 보는 것이라
     하단 메뉴가 맞다. 두 화면 모두 없어지지 않았다. */
  assert.match(
    product,
    /const tabs: TabId\[\] = \["recover", "discover"\]/,
    "키보드 좌우 이동 목록에 discover가 없다",
  );
  assert.match(
    product,
    /view === "discover"/,
    "?view=discover 딥링크 화이트리스트에 discover가 없다",
  );
  assert.match(product, /id="tab-discover"/);
  assert.match(product, /id="panel-discover"/);
  assert.match(product, /aria-controls="panel-discover"/);
  assert.match(product, /aria-labelledby="tab-discover"/);
});

test("빈 시간 화면은 선택한 기준시각부터 창 전체를 보존하고 이동시간을 입력받지 않는다", async () => {
  const [panel, picker] = await Promise.all([
    readFile(new URL("../app/DiscoverWindowPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ReferenceTimePicker.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(panel, /STAY_CHOICES = \[30, 60, 90, 120, 150, 180\]/);
  assert.match(panel, /WINDOW_CHOICES = \[60, 90, 120, 150, 180, 240\]/);
  /* 미래 시각까지 기다린 시간을 선택한 창에서 빼지 않는다. 사용자가 고른
     기준시각부터 정확히 N분을 이동·체류·복귀 창으로 만든다. */
  assert.match(
    panel,
    /requestReferenceTime\.timestamp \+ windowMinutes \* 60_000/,
  );
  assert.doesNotMatch(panel, /windowMinutes - departureDelayMinutes/);
  assert.match(panel, /availableUntil: requestWindowEndIso/);
  /* 다음 장소의 도착 시각은 **여행자가 적은 값만** 보낸다.
     예전에는 이 자리에 `requestWindowEndIso`, 즉 자유 시간의 끝을 넣었다. 그러면
     여행자가 말한 적 없는 마감("남은 시간이 끝날 때까지 그 장소에 도착해야 한다")이
     생기고, 그 장소가 조금만 멀면 전국의 모든 후보가 산술적으로 탈락한다. 실측에서
     대전역에서 한빛탑을 고르면 추천 0곳, 같은 조건에서 다음 장소만 비우면 6곳이었다.
     그 결합을 다시 만들지 못하게 두 방향으로 못박는다. */
  assert.match(panel, /arriveBy: requestArriveByIso/);
  assert.doesNotMatch(
    panel,
    /arriveBy: requestWindowEndIso/,
    "화면이 자유 시간의 끝을 다음 장소의 마감으로 만들어 붙이고 있다",
  );
  assert.match(
    panel,
    /formatIsoTime\([\s\S]*?replacementNode\?\.startAt,[\s\S]*?language,[\s\S]*?\)/,
    "English free-time results must not fall back to Korean 오전/오후 formatting",
  );
  assert.doesNotMatch(panel, /getMinutes\(\) % 30/);
  /* 머무는 시간과 창 길이는 빠른 칩으로 유지한다. 정확한 조회 기준은 별도의
     datetime 입력으로 받을 수 있지만 이동시간 숫자를 받지는 않는다. */
  assert.ok(
    !/type="number"/.test(panel),
    "빈 시간 화면에 숫자 입력 필드가 생겼다",
  );
  assert.match(picker, /type="datetime-local"/);
  assert.match(picker, /현재 시각으로 되돌리기/);
  assert.match(panel, /이동 시간은 실제 보행 경로로 계산하므로 따로 입력하지 않습니다/);
  /* 선택 칩은 라디오로 노출되어야 스크린리더가 하나만 고르는 그룹으로 읽는다. */
  assert.match(panel, /role="radiogroup"/);
  assert.match(panel, /role="radio"/);
  assert.match(panel, /aria-checked=/);
});

test("빈 시간 화면은 확인하지 못한 조건과 복귀 기준을 숨기지 않는다", async () => {
  const panel = await readFile(
    new URL("../app/DiscoverWindowPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panel, /공식 확인 전에는 선택할 수 없습니다/);
  assert.match(panel, /cardUnverified/);
  assert.match(panel, /disabled=\{isBlocked\}/);
  assert.match(panel, /safety\.canApply/);
  assert.match(panel, /origin_return_route/);
  assert.match(panel, /복귀 근거/);
  /* outbound를 뒤집어 썼다고 오인할 수 없도록 별도 복귀 조회의 제공자와 거리를
     근거로 밝힌다. 카드가 요약·상세로 나뉜 뒤 이 근거는 상세보기 안에 있는데,
     지우지 않고 한 겹 아래로 옮긴 것이므로 여전히 존재해야 한다. */
  assert.match(
    panel,
    /복귀 근거 · \$\{returnProviderLabel\(window\.returnProvider, language\)\}/,
  );
  assert.match(panel, /returnDistanceMeters/);
  /* 안전 경고만은 접지 않는다. 한 번 더 눌러야 보이면 경고가 아니다. */
  const detailBlock = panel.slice(panel.indexOf("{expanded && ("));
  assert.ok(
    !detailBlock.includes("공식 확인 전에는 선택할 수 없습니다"),
    "선택 불가 경고가 상세보기 안으로 숨었다",
  );
  assert.match(panel, /존재하지 않는 장소를 만들어 추천하지는 않습니다/);
  /* 실패 폐쇄로 제외한 후보의 이유와 수를 결과 아래에 밝혀야 한다. */
  assert.match(panel, /목록에서 제외된 이유/);
  assert.match(panel, /rejectionSummary/);
  assert.match(panel, /aria-live="polite"/);
});

test("빈 시간 추천도 저장에 실패하면 결과를 내주지 않는다", async () => {
  const source = await readFile(
    new URL("../app/api/v1/recover/route.ts", import.meta.url),
    "utf8",
  );
  /* 두 입구가 같은 실행·저장 구간을 공유해야 한다. 복제되면 한쪽만 원자성
     보장을 잃는다. */
  assert.equal(
    source.match(/return await runRecovery\(\{/g)?.length,
    2,
    "일정 복구와 빈 시간 추천이 같은 실행 함수를 호출해야 한다",
  );
  assert.match(source, /markPersistenceStarted\(\)/);
  assert.match(source, /RECOVERY_PERSISTENCE_FAILED/);
  assert.match(source, /OPEN_WINDOW_TOO_SHORT/);
  assert.match(source, /OPEN_WINDOW_TOO_LONG/);
  assert.match(source, /remainingMinutes > MAX_OPEN_WINDOW_MINUTES/);
  assert.ok(
    !/persistRecovery\(\{[\s\S]*persistRecovery\(\{/.test(source),
    "저장 호출이 두 번 복제되어 있으면 안 된다",
  );
  assert.ok(ROOT.length > 0);
});

/* 이 테스트가 지키는 것은 숫자 하나다: **실제로 바깥으로 나가는 호출이 예산을
   넘지 않는다.**

   예산 계량기가 경로 비용을 이동수단만 보고 1건으로 잡던 동안, TMAP 보행
   어댑터는 구간마다 별도 호출을 하고 있었다. 다음 장소가 마감으로 들어오면
   경로는 `현재 → 후보 → 다음 장소` 3지점, 즉 실제 2건인데 1건으로 청구된다.
   계량기는 45건 안이라고 믿고, 실제 호출은 무료 플랜 상한 50건을 넘고, 넘어서
   실패한 경로 조회는 `ROUTE_UNAVAILABLE`로 기록된다 — 화면에서는 "그 장소에는
   갈 길이 없다"로 보인다. 배포본 실측에서 3지점 요청은 요청당 평균 2.7건,
   2지점 요청은 0.2건의 `ROUTE_UNAVAILABLE`이 났다. 13배 차이는 후보의 성질이
   아니라 우리 산수의 결과였다.

   그래서 사유 코드나 추천 개수를 세지 않고 fetch 호출 자체를 센다. 예산 회계가
   다시 어긋나면 어떤 방식으로 어긋나든 이 숫자가 먼저 넘친다. */
test("다음 장소가 있는 보행 요청도 실제 외부 호출이 요청 예산을 넘지 않는다", async () => {
  const PLATFORM_SUBREQUEST_LIMIT = 50;
  const originalKey = process.env.KTO_SERVICE_KEY;
  const originalRouting = process.env.ROUTING_BASE_URL;
  const originalWeather = process.env.WEATHER_API_URL;
  process.env.KTO_SERVICE_KEY = "subrequest-ceiling-key";
  process.env.ROUTING_BASE_URL = "https://managed-routing.test/route";
  process.env.WEATHER_API_URL = "https://managed-weather.test/forecast";

  let fetchCount = 0;
  const routePaths = [];
  const originalFetch = installFetch({
    legSecondsByCandidate: { near: [120, 120], far: [300, 300] },
    routePaths,
  });
  const mocked = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCount += 1;
    return mocked(...args);
  };

  try {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const now = Date.now();
    const result = await recoverTrip(
      openWindowRequest({
        openWindow: {
          availableUntil: new Date(now + 240 * 60_000).toISOString(),
          plannedStayMinutes: 30,
          /* 약속 시각을 준 요청이라 다음 장소가 마감이 되고, 경로는 3지점이
             된다 — 구간 수를 세지 않으면 여기서 예산이 새어 나간다. */
          nextPlace: {
            latitude: 37.5705,
            longitude: 126.9915,
            label: "약속 장소",
            areaCode: "11",
            sigunguCode: "11110",
            arriveBy: new Date(now + 240 * 60_000).toISOString(),
          },
        },
      }),
      "subrequest-ceiling-walk",
      { deadlineAt: now + 20_000 },
    );

    assert.ok(
      fetchCount <= PLATFORM_SUBREQUEST_LIMIT,
      `실제 외부 호출 ${fetchCount}건이 플랫폼 상한 ${PLATFORM_SUBREQUEST_LIMIT}건을 넘었다. 예산 회계가 실제 호출 수와 어긋나 있다.`,
    );
    /* 예산이 넘치지 않았음을 확인하는 것만으로는 부족하다 — 아무것도 조회하지
       않아도 통과하기 때문이다. 실제로 검증까지 갔는지 함께 확인한다. */
    assert.ok(fetchCount > 0, "외부 호출이 한 건도 없었다");
    assert.ok(
      Array.isArray(result.options),
      "옵션 배열이 없으면 검증 단계에 도달하지 않은 것이다",
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = originalKey;
    if (originalRouting === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = originalRouting;
    if (originalWeather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalWeather;
  }
});
