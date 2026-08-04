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

/* `mode` 로 상류의 행동을 고른다.
   - "empty": 공사가 정상 응답하면서 0건을 준다 (진짜 데이터 공백)
   - "error": 우리 호출이 실패한다 (우리 문제) */
async function withPolicyUpstream(mode, run) {
  const originalFetch = globalThis.fetch;
  const savedKey = process.env.KTO_SERVICE_KEY;
  process.env.KTO_SERVICE_KEY = "policy-gap-test-key";
  globalThis.fetch = async () => {
    if (mode === "error") return new Response("upstream down", { status: 500 });
    return Response.json(envelope([]));
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    process.env.KTO_SERVICE_KEY = savedKey;
  }
}

test("우리 호출이 실패하면 공사 데이터 공백으로 단정하지 않는다", async () => {
  await withPolicyUpstream("error", async () => {
    const { buildPolicyInsight } = await import("../lib/insights/service.ts");
    const payload = await buildPolicyInsight({
      areaCode: "26",
      districtCode: "26350",
    });
    assert.equal(
      payload.status,
      "upstream_unavailable",
      "조회 실패를 data_gap으로 표기하면 있는 데이터를 없다고 공사에 보고한다",
    );
    assert.ok(
      payload.warnings.some((warning) =>
        warning.includes("한국관광공사에 해당 데이터가 없다는 뜻이 아닙니다"),
      ),
      "화면 경고가 원인을 우리 쪽으로 밝히지 않는다",
    );
  });
});

test("공사가 정상 응답으로 0건을 주면 그때는 데이터 공백으로 본다", async () => {
  await withPolicyUpstream("empty", async () => {
    const { buildPolicyInsight } = await import("../lib/insights/service.ts");
    const payload = await buildPolicyInsight({
      areaCode: "26",
      districtCode: "26350",
    });
    assert.equal(payload.status, "data_gap");
    assert.ok(
      !payload.warnings.some((warning) =>
        warning.includes("한국관광공사에 해당 데이터가 없다는 뜻이 아닙니다"),
      ),
    );
  });
});

test("기준월 하강이 끝나도 감사 기록을 버리지 않는다", async () => {
  const adapters = await readFile(
    new URL("../lib/kto/adapters.ts", import.meta.url),
    "utf8",
  );
  /* 예전 구현은 세 달을 다 쓰면 `results: []`를 돌려주며 감사까지 버렸고,
     호출자는 실패와 공백을 구분할 수 없었다. */
  assert.ok(
    !/return \{ baseYm, results: \[\] \}/.test(adapters),
    "감사 기록을 버리는 빈 배열 반환이 남아 있다",
  );
  assert.match(adapters, /upstreamFailed/);
  assert.match(adapters, /return \{ baseYm, results: lastResults, upstreamFailed \}/);
});

test("조회 실패만으로는 공사 대상 개선 미션을 만들지 않는다", async () => {
  const missions = await readFile(
    new URL("../lib/insights/missions.ts", import.meta.url),
    "utf8",
  );
  assert.match(missions, /function emptyPolicySources/);
  assert.match(missions, /function erroredPolicySources/);
  /* 미션 활성 조건이 error를 근거로 삼으면 안 된다. */
  assert.ok(
    !/const policyActive =\s*\n\s*missingMetrics\.length > 0 \|\| incompleteSources\.length > 0 \|\| retrievalFailures/.test(
      missions,
    ),
  );
  assert.match(missions, /hubAudit\?\.status !== "error" &&/);
  assert.match(missions, /retrievalFailures,/);
});
