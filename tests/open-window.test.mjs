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

function installFetch({ legSecondsByCandidate }) {
  const originalFetch = globalThis.fetch;
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
      const isFar = coordinates.includes("126.995");
      const durations = isFar
        ? legSecondsByCandidate.far
        : legSecondsByCandidate.near;
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
      items = [{ usetimeculture: "00:00~23:59", infocenter: "02-000-0000" }];
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
  const originalFetch = installFetch({ legSecondsByCandidate });
  try {
    return await run();
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
    /* 가까운 후보는 왕복 10분+10분, 먼 후보는 왕복 50분+50분. 창은 90분,
       체류 60분이므로 먼 후보만 넘친다. */
    { near: [600], far: [3_000] },
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const now = Date.now();
      const result = await recoverTrip(
        openWindowRequest({
          openWindow: {
            availableUntil: new Date(now + 90 * 60_000).toISOString(),
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
          window.leftoverMinutes >= 0,
          "창을 넘긴 후보가 제시되어서는 안 된다",
        );
        assert.equal(window.returnBasis, "same_route_reversed");
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
      assert.match(
        option.purposePreservation.statement,
        /목적 유지 여부는 판단하지 않았습니다/,
      );
    }
    assert.ok(
      result.warnings.some((warning) =>
        warning.includes("목적 유지 여부는 판단하지 않았습니다"),
      ),
      "화면 경고에도 같은 한계가 적혀야 한다",
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
});

test("새 탭이 링크·키보드·탭목록 어디에서도 빠지지 않는다", async () => {
  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  /* 탭을 추가할 때 같이 늘려야 하는 세 곳. 하나라도 빠지면 화면은 있는데
     링크나 키보드로는 닿지 않는 상태가 된다. 실제로 구현 중 URL 화이트리스트를
     빼먹어 공유 링크가 조용히 첫 탭으로 떨어졌다. */
  assert.match(
    product,
    /const tabs: TabId\[\] = \["recover", "discover", "insights", "transparency"\]/,
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

test("빈 시간 화면은 30분 격자만 제공하고 이동시간을 입력받지 않는다", async () => {
  const panel = await readFile(
    new URL("../app/DiscoverWindowPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panel, /STAY_CHOICES = \[30, 60, 90, 120, 150, 180\]/);
  assert.match(panel, /WINDOW_CHOICES = \[60, 90, 120, 150, 180, 240\]/);
  /* 30분 격자에 올리는 계산이 실제로 있어야 한다. */
  assert.match(panel, /getMinutes\(\) % 30/);
  /* 여행자가 분 단위 숫자를 타이핑하는 입력이 새로 생기면 이 화면의 목적이
     사라진다. 숫자·시간 입력 필드를 두지 않는다. */
  assert.ok(
    !/type="number"/.test(panel),
    "빈 시간 화면에 숫자 입력 필드가 생겼다",
  );
  assert.ok(
    !/type="time"/.test(panel),
    "빈 시간 화면에 분 단위 시간 입력이 생겼다",
  );
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
  assert.match(panel, /공식 정보로 확인하지 못한 조건/);
  assert.match(panel, /cardUnverified/);
  /* 복귀 시간의 근거를 밝히되, 수단에 따라 "보행"·"자동차"가 갈린다. 자차로
     계산한 결과에 "보행 경로 기준"이라고 적히면 근거 표기가 거짓이 된다. */
  assert.match(
    panel,
    /돌아오는 시간은 같은 \$\{byCar \? "자동차" : "보행"\} 경로 기준입니다/,
  );
  assert.match(panel, /존재하지 않는 장소를 만들어 추천하지는 않습니다/);
  /* 통과하지 못한 후보 수를 결과 아래에 밝혀야 한다. */
  assert.match(panel, /조건을 통과하지 못한 후보/);
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
  assert.ok(
    !/persistRecovery\(\{[\s\S]*persistRecovery\(\{/.test(source),
    "저장 호출이 두 번 복제되어 있으면 안 된다",
  );
  assert.ok(ROOT.length > 0);
});
