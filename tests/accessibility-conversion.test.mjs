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
      items = [{ usetimeculture: "24시간", restdateculture: "연중무휴" }];
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

test("확인되지 않은 필수 조건은 UI에서도 fail-closed로 적용·공유를 막는다", async () => {
  const flow = await readFile(
    new URL("../app/flow/FlowApp.tsx", import.meta.url),
    "utf8",
  );
  /* 접근성처럼 **필수 조건**의 근거가 빠진 후보는 동의만으로 열리지 않는다.
     동의가 여는 문은 운영시간 하나뿐이고, 그때도 검증된 것으로 승격하지
     않는다 — 근거 공백은 그대로 남고 공유는 계속 막힌다.

     "확인하지 못했다"를 따로 다루는 이유는 그것이 덜 중요해서가 아니라,
     "닫혀 있다고 확인했다"와 다른 사실이기 때문이다. 앞의 것은 원문을 읽거나
     전화 한 통으로 풀리고, 그 판단은 여행자가 할 수 있다. */
  assert.match(flow, /optionApplicationSafety\(option, language\)/);
  assert.match(
    flow,
    /isBlocked \|\| \(needsSelfConfirmation && !selfConfirmed\)/,
  );

  const apply = flow.slice(flow.indexOf("const applySelectedOption"));
  const applyHead = apply.slice(0, 1_600);
  /* 동의는 남은 이유가 모두 "확인하지 못했다"일 때만 성립한다. */
  assert.match(applyHead, /safety\.selfConfirmable/);
  assert.match(applyHead, /acknowledgedOptionId === selectedOption\.id/);
  assert.match(applyHead, /if \(!safety\.canApply && !acknowledged\)/);

  /* 공유는 열리지 않는다. 적용은 내가 감수하는 선택이고, 공유는 남에게 건네는
     검증 증명서다.

     흐름 화면의 공유 경로는 이후에 지웠다 — 여행자가 증명 링크를 만들 이유가 없었다.
     그래서 이 불변식은 공유가 남아 있는 화면에서 확인한다. 검사를 없애지 않는 이유는
     불변식이 사라진 것이 아니라 자리만 옮겼기 때문이다. */
  assert.doesNotMatch(flow, /const shareSelectedOption/);
  const productSource = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  const share = productSource.slice(
    productSource.indexOf("async function shareRecoveryOption"),
  );
  assert.ok(share.length > 100, "공유 경로를 찾지 못했다");
  assert.match(share.slice(0, 1_200), /const safety = optionApplicationSafety\(option, language\);/);
  assert.match(share.slice(0, 1_200), /if \(!safety\.canApply\)/);
  assert.ok(
    !/selfConfirmable|acknowledged/.test(share.slice(0, 1_200)),
    "공유에까지 동의로 예외를 열어서는 안 된다",
  );

  /* 동의해도 근거 공백 자체는 사라지지 않는다. */
  const safety = await readFile(
    new URL("../app/traveler-safety.ts", import.meta.url),
    "utf8",
  );
  assert.match(safety, /selfConfirmable:\s*\n?\s*reasons\.length > 0/);
  assert.match(safety, /availabilityStatus !== "confirmed_closed"/);
  /* 화면이 자기 목록을 따로 들면 서버 계약과 어긋난다. 같은 상수를 본다. */
  assert.match(safety, /SELF_CONFIRMABLE_GAP_CODES\.has\(gap\.code\)/);

  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(product, /공식 확인 전에는 선택할 수 없습니다|모든 안전 조건을 확인하기 전에는 적용할 수 없어요/);
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
