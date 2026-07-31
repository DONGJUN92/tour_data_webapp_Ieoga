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
