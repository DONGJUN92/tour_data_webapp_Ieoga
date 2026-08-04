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

/* 세 보조 서비스가 모두 값을 주는 상태를 만든다. 그래야 하나씩 끌 때 무엇이
   사라지는지 수치로 보인다. */
async function withAllSources(run, offset = 0) {
  const originalFetch = globalThis.fetch;
  const saved = {
    kto: process.env.KTO_SERVICE_KEY,
    tmap: process.env.TMAP_APP_KEY,
    routing: process.env.ROUTING_BASE_URL,
    weather: process.env.WEATHER_API_URL,
  };
  process.env.KTO_SERVICE_KEY = "ablation-key";
  process.env.TMAP_APP_KEY = "ablation-tmap";
  process.env.ROUTING_BASE_URL = "none";
  process.env.WEATHER_API_URL = "none";

  const called = new Set();
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "apis.openapi.sk.com") return Response.json(tmap(600, 540));
    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    if (service) called.add(service);
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      items = [
        {
          contentid: "abl-1",
          contenttypeid: "12",
          title: "연관 관광지",
          addr1: "서울특별시 종로구",
          mapx: String(126.9805 + offset),
          mapy: "37.567",
          dist: "600",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260716",
        },
      ];
    } else if (service === "KorService2" && operation === "detailIntro2") {
      items = [{ usetime: "상시 개방", restdate: "연중무휴" }];
    } else if (service === "TarRlteTarService1") {
      items = [
        {
          tAtsNm: "원래 관광지",
          rlteTatsNm: "연관 관광지",
          rlteCtgryLclsNm: "관광지",
          rlteCtgryMclsNm: "자연관광",
          rlteRank: "1",
          baseYm: "202606",
        },
      ];
    } else if (service === "TatsCnctrRateService") {
      items = [
        { tAtsNm: "연관 관광지", cnctrRate: "31.5", baseYmd: "20260804" },
      ];
    } else if (service === "KorWithService2" && operation === "locationBasedList2") {
      items = [{ contentid: "abl-1", contenttypeid: "12", dist: "600" }];
    } else if (service === "KorWithService2" && operation === "detailWithTour2") {
      items = [
        {
          stroller: "대여 가능",
          elevator: "있음",
          restroom: "기저귀 교환대 있음",
          exit: "주출입구 경사로",
          parking: "가능",
          route: "단차 없음",
          publictransport: "지하철 3호선",
        },
      ];
    }
    return Response.json(envelope(items));
  };

  try {
    return await run(called);
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

function request({ disabledSources, offset = 0 }) {
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
      startAt: new Date(now + 220 * 60_000).toISOString(),
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
  const body = {
    origin: {
      latitude: 37.5665,
      longitude: 126.978 + offset,
      label: "현재 위치",
      areaCode: "11",
      sigunguCode: "11110",
    },
    incident: "crowd",
    availableMinutes: 180,
    maxDistanceMeters: 5_000,
    audience: "stroller",
    indoorOnly: false,
    travelMode: "walk",
    radiusMeters: 8_000,
    safetyBufferMinutes: 15,
    minimumStayMinutes: 60,
    analyticsConsent: false,
    itinerary: {
      title: "제거실험 일정",
      timezone: "Asia/Seoul",
      audience: "stroller",
      occurredAt: new Date(now).toISOString(),
      disruptedNodeId: "n1",
      nextFixedNodeId: "n2",
      nodes,
    },
  };
  if (disabledSources) body.disabledSources = disabledSources;
  return body;
}

test("전체 사용에서는 세 근거가 모두 잡힌다", async () => {
  await withAllSources(async () => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(request({ offset: 0 }), "abl-full");
    assert.ok(result.options.length >= 1);
    const ablation = result.ablation;
    assert.ok(ablation, "ablation 요약이 없다");
    assert.deepEqual(ablation.disabledSources, []);
    assert.equal(ablation.relatedEvidenceCount, 1);
    assert.equal(ablation.crowdEvidenceCount, 1);
    assert.equal(ablation.accessibilityVerifiedCount, 1);
  });
});

test("연관 관광지를 끄면 호출하지 않고 의도 보존 근거가 사라진다", async () => {
  await withAllSources(async (called) => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      request({ disabledSources: ["TarRlteTarService1"], offset: 0.01 }),
      "abl-related",
    );
    /* 호출해 놓고 결과만 버리면 "없을 때 무엇이 깨지는가"를 보여 주는 것이
       아니라 같은 호출량으로 같은 답을 내는 것이 된다. */
    assert.ok(
      !called.has("TarRlteTarService1"),
      "끈 서비스를 여전히 호출했다",
    );
    assert.deepEqual(result.ablation.disabledSources, ["TarRlteTarService1"]);
    assert.equal(result.ablation.relatedEvidenceCount, 0);
    assert.match(
      result.ablation.lostCapabilities.join(" "),
      /의도 보존/,
    );
    /* 다른 근거는 그대로 남아야 한다 — 하나만 끈 실험이므로. */
    assert.equal(result.ablation.crowdEvidenceCount, 1);
  }, 0.01);
});

test("집중률을 끄면 혼잡 근거가 사라진다", async () => {
  await withAllSources(async (called) => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      request({ disabledSources: ["TatsCnctrRateService"], offset: 0.02 }),
      "abl-crowd",
    );
    assert.ok(!called.has("TatsCnctrRateService"));
    assert.equal(result.ablation.crowdEvidenceCount, 0);
    assert.equal(result.ablation.relatedEvidenceCount, 1);
  }, 0.02);
});

test("무장애 정보를 끄면 모든 후보가 접근성 미확인이 된다", async () => {
  await withAllSources(async (called) => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      request({ disabledSources: ["KorWithService2"], offset: 0.03 }),
      "abl-a11y",
    );
    assert.ok(!called.has("KorWithService2"));
    assert.equal(result.ablation.accessibilityVerifiedCount, 0);
    /* 유아차 조건이므로 확인 요구 후보가 되어야 한다. */
    assert.ok(result.ablation.confirmationRequiredCount >= 1);
    assert.equal(result.ablation.verifiedOptionCount, 0);
  }, 0.03);
});

test("국문 관광정보는 끌 수 없다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const parsed = recoveryRequestSchema.safeParse({
    ...request({ offset: 0 }),
    disabledSources: ["KorService2"],
  });
  /* 후보 자체를 만드는 유일한 원천이라 끄면 비교가 아니라 빈 결과가 된다. */
  assert.equal(parsed.success, false);
});

test("제거실험이 capabilities와 화면에 공표된다", async () => {
  const caps = await readFile(
    new URL("../app/api/v1/capabilities/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(caps, /sourceAblation/);
  assert.match(caps, /disableableSources/);
  assert.match(caps, /alwaysRequired: \["KorService2"\]/);

  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(product, /ABLATION_SOURCES/);
  assert.match(product, /disabledSources: disabledSources\.length/);
  /* 끈 사실이 결과와 함께 남아야 한다. */
  assert.match(product, /제거실험 진행 중/);

  const model = await readFile(
    new URL("../app/product-app-model.ts", import.meta.url),
    "utf8",
  );
  for (const id of [
    "TarRlteTarService1",
    "TatsCnctrRateService",
    "KorWithService2",
  ]) {
    assert.ok(model.includes(id), `${id}가 토글 목록에 없다`);
  }
});

test("자기 선언한 색 대비 기준을 위반하는 하드코딩이 없다", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  /* #3182f6은 흰 텍스트와 3.71:1로 WCAG 1.4.3 실패다. 같은 파일의 토큰
     주석이 --accent를 5.4:1로 적어 두었으므로 자기 체계 위반이었다. */
  assert.ok(
    !/background:\s*#3182f6/.test(css),
    "대비 미달 색이 배경으로 하드코딩되어 있다",
  );
});

test("끈 호출을 오류로 기록하지 않는다", async () => {
  await withAllSources(async () => {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      request({
        disabledSources: [
          "TarRlteTarService1",
          "TatsCnctrRateService",
          "KorWithService2",
        ],
        offset: 0.04,
      }),
      "abl-audit-status",
    );
    /* 의도적으로 건너뛴 호출을 `error`로 적으면, 그 상태는 "공사 데이터 공백"
       판정의 근거로도 쓰이는 값이므로 제거실험이 곧 거짓 공백 신고가 된다. */
    for (const name of [
      "TarRlteTarService1",
      "TatsCnctrRateService",
      "KorWithService2",
    ]) {
      const entries = (result.sourceLedger ?? []).filter(
        (entry) => entry.apiName === name,
      );
      assert.ok(entries.length >= 1, `${name} 감사 기록이 없다`);
      assert.ok(
        entries.every((entry) => entry.status !== "error"),
        `${name}을 끈 호출이 오류로 기록됐다`,
      );
      assert.ok(
        entries.some(
          (entry) =>
            entry.status === "not_required" &&
            entry.errorCode === "DISABLED_FOR_ABLATION",
        ),
        `${name}에 제거실험 사유가 남지 않았다`,
      );
    }
  }, 0.04);
});
