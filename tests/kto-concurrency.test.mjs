import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

const { callKto } = await import("../lib/kto/client.ts");

/* The portal queues concurrent requests per account. Measured against the live
   service, three simultaneous calls each return in about 0.2s while eight push
   most responses past 3.4s — long enough to blow the 2.5s detail-lookup budget
   and lose the opening-hours evidence entirely. The client therefore caps
   in-flight requests, and that cap is load-bearing rather than cosmetic. */

function ktoEnvelope(items) {
  return {
    response: {
      header: { resultCode: "0000", resultMsg: "OK" },
      body: {
        items: items.length ? { item: items } : "",
        totalCount: items.length,
        pageNo: 1,
        numOfRows: items.length,
      },
    },
  };
}

async function withFetch(fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.KTO_SERVICE_KEY;
  process.env.KTO_SERVICE_KEY = "concurrency-test-key";
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = previousKey;
  }
}

test("KTO client caps concurrent upstream requests", async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  let completed = 0;

  await withFetch(
    async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      completed += 1;
      return new Response(JSON.stringify(ktoEnvelope([{ contentid: "1" }])), {
        status: 200,
      });
    },
    async () => {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          callKto("KorService2", "detailIntro2", {
            contentId: `content-${index}`,
            contentTypeId: 14,
          }),
        ),
      );
    },
  );

  assert.equal(completed, 12, "every request still runs");
  assert.ok(
    peakInFlight <= 3,
    `at most three concurrent upstream calls, saw ${peakInFlight}`,
  );
  assert.ok(peakInFlight > 1, "requests are not fully serialised");
});

/* A leaked slot would wedge the client after enough failures, so the release
   has to cover the throwing path too. */
test("failed requests release their concurrency slot", async () => {
  let peakInFlight = 0;
  let inFlight = 0;

  await withFetch(
    async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response("upstream exploded", { status: 500 });
    },
    async () => {
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          callKto(
            "KorService2",
            "detailIntro2",
            { contentId: "x", contentTypeId: 14 },
            { retry: false },
          ),
        ),
      );
      assert.ok(
        settled.every((entry) => entry.status === "rejected"),
        "all requests report the upstream failure",
      );
    },
  );

  assert.ok(peakInFlight <= 3, "cap holds while failing");

  /* If a slot had leaked, this follow-up would never reach the network. */
  let reached = false;
  await withFetch(
    async () => {
      reached = true;
      return new Response(JSON.stringify(ktoEnvelope([{ contentid: "2" }])), {
        status: 200,
      });
    },
    async () => {
      await callKto("KorService2", "detailIntro2", {
        contentId: "after-failures",
        contentTypeId: 14,
      });
    },
  );
  assert.ok(reached, "client still accepts work after a burst of failures");
});

/* 월 단위 데이터셋은 지난달이 아직 발행되지 않을 수 있다. 실측에서 8월 초의
   최신 기준월은 202606이었고 202607은 모든 지표가 0건이었다. 점검이 기준월
   하나만 보고 끝내면 발행 지연이 데이터 공백으로 보고되어, 화면에는 공사
   8종 중 5종이 `데이터 없음`으로 남는다. */
test("the health check looks past a base month the portal has not published yet", async () => {
  const { checkAllKtoServices } = await import("../lib/kto/health.ts");
  const requestedMonths = new Set();
  const publishedMonth = "202606";

  await withFetch(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const baseYm = url.searchParams.get("baseYm");
    if (baseYm) requestedMonths.add(baseYm);

    if (url.pathname.includes("ldongCode2")) {
      return new Response(
        JSON.stringify(ktoEnvelope([{ code: "110", name: "종로구" }])),
        { status: 200 },
      );
    }
    if (url.pathname.includes("tatsCnctrRatedList")) {
      return new Response(
        JSON.stringify(ktoEnvelope([{ tAtsCd: "x", baseYmd: "20260804" }])),
        { status: 200 },
      );
    }
    /* 발행된 달에만 행이 있다. 그 이후 달은 정상 응답에 0건이다. */
    return new Response(
      JSON.stringify(
        baseYm === publishedMonth
          ? ktoEnvelope([{ baseYm, areaCd: "11", signguCd: "11110" }])
          : ktoEnvelope([]),
      ),
      { status: 200 },
    );
  }, async () => {
    const result = await checkAllKtoServices();

    assert.equal(result.sources.length, 8);
    const notLive = result.sources.filter((source) => source.status !== "live");
    assert.deepEqual(
      notLive.map((source) => `${source.apiName}:${source.status}`),
      [],
      "발행된 달에 데이터가 있으면 8종이 모두 live여야 한다",
    );
    assert.equal(result.overall, "ready");
    /* 지난달을 먼저 묻고, 비어 있을 때만 이전 달로 물러난다. */
    assert.ok(requestedMonths.size > 1, "기준월 하나만 조회하고 끝내면 안 된다");
    assert.ok(requestedMonths.has(publishedMonth));
  });
});

test("a genuinely empty dataset is still reported as empty, not retried forever", async () => {
  const { checkAllKtoServices } = await import("../lib/kto/health.ts");
  const monthsPerService = new Map();

  await withFetch(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const baseYm = url.searchParams.get("baseYm");
    if (baseYm) {
      const key = url.pathname.split("/")[2];
      monthsPerService.set(key, (monthsPerService.get(key) ?? 0) + 1);
    }
    if (url.pathname.includes("ldongCode2")) {
      return new Response(
        JSON.stringify(ktoEnvelope([{ code: "110", name: "종로구" }])),
        { status: 200 },
      );
    }
    if (url.pathname.includes("tatsCnctrRatedList")) {
      return new Response(JSON.stringify(ktoEnvelope([{ tAtsCd: "x" }])), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(ktoEnvelope([])), { status: 200 });
  }, async () => {
    const result = await checkAllKtoServices();
    const empties = result.sources.filter((source) => source.status === "empty");
    assert.ok(empties.length > 0, "데이터가 정말 없으면 empty로 남아야 한다");
    /* 창은 유한하다. 무한히 과거로 내려가며 쿼터를 태우지 않는다. */
    for (const [service, calls] of monthsPerService) {
      assert.ok(calls <= 3, `${service}가 기준월을 ${calls}번 조회했다`);
    }
  });
});
