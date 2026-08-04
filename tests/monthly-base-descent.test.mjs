import assert from "node:assert/strict";
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

/* 공사 월 단위 API의 실제 동작을 모사한다. 아직 발행되지 않은 기준월은 오류가
   아니라 HTTP 200 + `resultMsg: OK` + 0건으로 온다. 그래서 오류 처리로는 잡히지
   않고 "데이터 공백"으로 보인다. */
async function withMonthlyUpstream(publishedMonths, run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  process.env.KTO_SERVICE_KEY = "monthly-descent-test-key";
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const baseYm = url.searchParams.get("baseYm");
    const [, service] = url.pathname.match(/\/B551011\/([^/]+)\//) ?? [];
    asked.push({ service, baseYm });
    const published = publishedMonths[service] ?? [];
    return Response.json(
      ktoEnvelope(
        published.includes(baseYm)
          ? [{ tAtsNm: "기준점", rlteTatsNm: "연관지", hubTatsNm: "중심지", baseYm }]
          : [],
      ),
    );
  };
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = originalKey;
  }
}

function previousMonthOf(date = new Date()) {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1),
  );
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBefore(baseYm) {
  const year = Number(baseYm.slice(0, 4));
  const month = Number(baseYm.slice(4, 6));
  const d = new Date(Date.UTC(year, month - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

test("직전 달이 아직 발행되지 않으면 이전 달로 내려가 실제 데이터를 찾는다", async () => {
  const current = previousMonthOf();
  const published = monthBefore(current);
  await withMonthlyUpstream(
    { TarRlteTarService1: [published] },
    async (asked) => {
      const { getRelatedTourism, resetResolvedBaseMonths } = await import(
        "../lib/kto/adapters.ts"
      );
      resetResolvedBaseMonths();
      const result = await getRelatedTourism({
        regionCode: "26",
        districtCode: "26350",
      });
      assert.ok(
        result.items.length >= 1,
        "발행된 달의 데이터를 찾지 못했다 — 하강 폴백이 동작하지 않는다",
      );
      const months = asked
        .filter((entry) => entry.service === "TarRlteTarService1")
        .map((entry) => entry.baseYm);
      assert.deepEqual(
        months,
        [current, published],
        "직전 달을 먼저 묻고, 비었을 때만 한 달 내려가야 한다",
      );
    },
  );
});

test("중심 관광지도 같은 규칙으로 내려간다", async () => {
  const current = previousMonthOf();
  const published = monthBefore(current);
  await withMonthlyUpstream(
    { LocgoHubTarService1: [published] },
    async (asked) => {
      const { getHubTourism, resetResolvedBaseMonths } = await import(
        "../lib/kto/adapters.ts"
      );
      resetResolvedBaseMonths();
      const result = await getHubTourism({
        regionCode: "26",
        districtCode: "26350",
      });
      assert.ok(result.items.length >= 1);
      assert.deepEqual(
        asked
          .filter((entry) => entry.service === "LocgoHubTarService1")
          .map((entry) => entry.baseYm),
        [current, published],
      );
    },
  );
});

test("한 번 확인한 기준월은 재사용해 하강 비용을 반복하지 않는다", async () => {
  const current = previousMonthOf();
  const published = monthBefore(current);
  await withMonthlyUpstream(
    { TarRlteTarService1: [published] },
    async (asked) => {
      const { getRelatedTourism, resetResolvedBaseMonths } = await import(
        "../lib/kto/adapters.ts"
      );
      resetResolvedBaseMonths();
      await getRelatedTourism({ regionCode: "26", districtCode: "26350" });
      const afterFirst = asked.length;
      /* 두 번째 요청은 다른 지역으로 보낸다. 응답 캐시가 아니라 기준월 학습이
         동작하는지를 봐야 한다. */
      await getRelatedTourism({ regionCode: "11", districtCode: "11110" });
      const second = asked.slice(afterFirst).map((entry) => entry.baseYm);
      assert.deepEqual(
        second,
        [published],
        "학습한 기준월에서 바로 시작해야 한다",
      );
    },
  );
});

test("세 달 모두 비어 있으면 지어내지 않고 현재 기준월의 빈 결과를 남긴다", async () => {
  const current = previousMonthOf();
  await withMonthlyUpstream({ TarRlteTarService1: [] }, async (asked) => {
    const { getRelatedTourism, resetResolvedBaseMonths } = await import(
      "../lib/kto/adapters.ts"
    );
    resetResolvedBaseMonths();
    const result = await getRelatedTourism({
      regionCode: "26",
      districtCode: "26350",
    });
    assert.equal(result.items.length, 0);
    assert.equal(
      asked.filter((e) => e.service === "TarRlteTarService1").length,
      3,
      "세 달까지만 시도해야 한다",
    );
    /* 원장에는 우리가 현재 기준월로 본 달을 요청했다는 사실이 남아야 한다. */
    assert.equal(
      asked.filter((e) => e.service === "TarRlteTarService1")[0].baseYm,
      current,
    );
    assert.equal(result.audit.status, "empty");
  });
});

test("호출자가 기준월을 지정하면 그 달만 조회한다", async () => {
  await withMonthlyUpstream({ TarRlteTarService1: [] }, async (asked) => {
    const { getRelatedTourism, resetResolvedBaseMonths } = await import(
      "../lib/kto/adapters.ts"
    );
    resetResolvedBaseMonths();
    await getRelatedTourism({
      regionCode: "26",
      districtCode: "26350",
      baseYm: "202512",
    });
    assert.deepEqual(
      asked.filter((e) => e.service === "TarRlteTarService1").map((e) => e.baseYm),
      ["202512"],
      "지정한 달을 조용히 바꾸면 화면 표기와 실제 조회가 달라진다",
    );
  });
});
