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

/* 유아차 동반 여행자 시나리오. 후보는 주변 무장애 *목록*에는 없지만
   `detailWithTour2`가 유아차 필수 항목을 확인해 준다. 예전 구현은 목록 부재로
   붙인 공백을 지우지 않아, 확인된 곳조차 영구히 미확인으로 남았다. */
async function withStrollerUpstream(
  run,
  { detailConfirms = true, detailOverrides = {} } = {},
) {
  const originalFetch = globalThis.fetch;
  const saved = {
    kto: process.env.KTO_SERVICE_KEY,
    tmap: process.env.TMAP_APP_KEY,
    routing: process.env.ROUTING_BASE_URL,
    weather: process.env.WEATHER_API_URL,
  };
  process.env.KTO_SERVICE_KEY = "a11y-test-key";
  process.env.TMAP_APP_KEY = "a11y-tmap";
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
            properties: { totalDistance: 600, totalTime: 540 },
          },
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [126.978, 37.5665],
                [126.9805, 37.5672],
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
      items = [
        {
          contentid: "a11y-1",
          contenttypeid: "14",
          title: "확인되는 문화관",
          addr1: "서울특별시 종로구",
          mapx: "126.9805",
          mapy: "37.5672",
          dist: "600",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
      ];
    } else if (service === "KorService2" && operation === "detailIntro2") {
      items = [{ usetimeculture: "00:00~23:59" }];
    } else if (service === "KorWithService2" && operation === "detailWithTour2") {
      /* 유아차 필수 동선을 공식 데이터가 확인해 주는 응답. */
      items = detailConfirms
        ? [
            {
              /* 유아차가 **안에서 다닐 수 있다**고 말하는 값이어야 한다.
                 `대여 가능`은 유아차를 빌려준다는 뜻이고 동선을 확인해 주지
                 않는다 — S1-2가 그 혼동이었다. */
              stroller: "유아차 통행 가능 (전 구간 단차 없음)",
              elevator: "있음",
              restroom: "기저귀 교환대 있음",
              exit: "주출입구 경사로",
              parking: "가능",
              route: "단차 없음",
              publictransport: "지하철 3호선 안국역",
              ...detailOverrides,
            },
          ]
        : [];
    }
    /* 주변 무장애 목록에는 이 후보가 없다 — 목록 부재가 출발 조건이다. */
    return Response.json(ktoEnvelope(items));
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

function strollerRequest(offset = 0) {
  return {
    origin: {
      latitude: 37.5665,
      longitude: 126.978 + offset,
      label: "현재 위치",
      areaCode: "11",
      sigunguCode: "11110",
    },
    incident: "delay",
    availableMinutes: 180,
    maxDistanceMeters: 5_000,
    audience: "stroller",
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
  };
}

test("상세 조회가 접근성을 확인하면 목록 부재로 붙은 공백을 지운다", async () => {
  await withStrollerUpstream(async () => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(strollerRequest(0), "a11y-verified");
    assert.ok(result.options.length >= 1, "후보가 남아야 한다");
    const option = result.options[0];
    assert.equal(option.accessibility.status, "verified");
    assert.ok(
      !(option.evidenceGaps ?? []).some(
        (gap) => gap.code === "ACCESSIBILITY_UNVERIFIED",
      ),
      "확인된 접근성인데 미확인 공백이 남아 있다",
    );
    assert.equal(
      option.confirmationRequired,
      false,
      "확인된 후보가 확인 요구 상태로 남아 유아차 여행자의 전환이 막힌다",
    );
  });
});

test("상세 조회가 확인하지 못하면 공백은 유지되되 후보는 남는다", async () => {
  await withStrollerUpstream(
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(strollerRequest(0.01), "a11y-unverified");
      assert.ok(
        result.options.length >= 1,
        "미확인이라도 후보를 지워버리면 안 된다",
      );
      const option = result.options[0];
      assert.notEqual(option.accessibility.status, "verified");
      assert.ok(
        (option.evidenceGaps ?? []).some(
          (gap) => gap.code === "ACCESSIBILITY_UNVERIFIED",
        ),
        "확인하지 못한 사실은 그대로 남아야 한다",
      );
      assert.equal(option.confirmationRequired, true);
      /* 확인되지 않은 후보에 "조건이 가장 잘 맞는 곳"이라고 쓰면 같은 카드의
         경고와 모순된다. */
      for (const entry of result.options) {
        if (entry.accessibility.status !== "verified") {
          assert.ok(
            !/조건이 가장 잘 맞는/.test(entry.strategyLabel),
            `미확인 후보에 단정 라벨이 붙었다: ${entry.strategyLabel}`,
          );
        }
      }
    },
    { detailConfirms: false },
  );
});

test("확인되지 않은 조건은 하드 차단이 아니라 명시적 동의로 열린다", async () => {
  const flow = await readFile(
    new URL("../app/flow/FlowApp.tsx", import.meta.url),
    "utf8",
  );
  /* 기획 5.4는 "제외하거나 사용자 확인을 요구한다"이고, 예전 구현은 후자가
     없어 전환율이 구조적으로 0이었다. */
  assert.match(flow, /acknowledgedOptionId/);
  assert.match(flow, /selectedNeedsAcknowledgement/);
  assert.match(flow, /확인되지 않은 조건을 알고 이어갑니다/);
  /* 동의 없이는 여전히 막혀야 한다. */
  assert.match(
    flow,
    /needsAcknowledgement && acknowledgedOptionId !== selectedOption\.id/,
  );
  /* 후보를 바꾸면 동의가 따라가서는 안 된다. */
  assert.match(flow, /setAcknowledgedOptionId\(""\)/);
  /* 공유는 완전 검증된 결과에만 허용한다 — 증명서는 다른 등급의 산출물이다. */
  const share = flow.slice(flow.indexOf("const shareSelectedOption"));
  assert.match(
    share.slice(0, 600),
    /confirmationRequired \|\|/,
    "공유 게이트가 함께 풀려 미확인 결과의 증명서가 공유된다",
  );
});

test("대여 정보만 있는 값은 내부 동선 확인으로 승격되지 않는다", async () => {
  /* S1-2 회귀 방지의 동작 검증. 조사에서 관측한 값은 `wheelchair='대여가능'`
     하나로 등급이 A까지 올라가고 확인 요구가 풀린 상태였다. 유아차를 빌려주는
     것과 유아차가 안에서 다닐 수 있는 것은 다른 사실이고, 후자를 확인하지 않은
     채 전자로 대신하면 현장에서 계단을 만나는 쪽이 대가를 치른다. */
  await withStrollerUpstream(
    async () => {
      const { recoverTrip } = await import("../lib/recovery/engine.ts");
      const result = await recoverTrip(
        strollerRequest(0.02),
        "a11y-rental-only",
      );
      assert.ok(result.options.length >= 1, "후보 자체는 남아야 한다");
      const option = result.options[0];
      assert.notEqual(
        option.accessibility.status,
        "verified",
        "대여 문구 하나로 필수 동선이 확인된 것으로 처리됐다",
      );
      assert.ok(
        (option.evidenceGaps ?? []).some(
          (gap) => gap.code === "ACCESSIBILITY_UNVERIFIED",
        ),
        "확인되지 않은 사실이 공백으로 남지 않았다",
      );
      assert.equal(option.confirmationRequired, true);
    },
    {
      detailOverrides: {
        stroller: "대여 가능",
        route: "",
        exit: "",
        elevator: "",
      },
    },
  );
});
