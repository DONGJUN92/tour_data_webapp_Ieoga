import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 2026-08-05 AI 가상 페르소나 조사가 찾은 S1-6·S1-7의 회귀 방지.
 *
 * S1-6: 미션 목록의 기본 호출이 100건에서 잘리는데 응답은 그 길이를
 *       `missionCount`로만 발표했다. 상태별 분포도 같은 잘린 페이지에서 셌다.
 *       전국 미션이 100건을 넘는 순간 "전국 N건"이 조용히 틀리고, 틀렸다는
 *       사실이 응답 어디에도 없다. 기획 15.7이 금지한 형태다.
 * S1-7: 담당 제안이 `한국관광공사 관광데이터 담당 부서`로 찍힌 미션의 같은
 *       지역 원장에 우리 `NETWORK_ERROR`가 남아 있었다. 공사에 보완을 요구하는
 *       문서에서 이 혼동은 그대로 오귀속이 된다. */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

function policyPayload({ metrics, ledger }) {
  return {
    areaCode: "11",
    districtCode: "11110",
    regionName: "서울특별시",
    districtName: "종로구",
    status: "live",
    coverage: { percent: 50, available: 4, expected: 8, meaning: "" },
    baseYm: "202605",
    metrics,
    hubs: [],
    sourceLedger: ledger,
    warnings: [],
    generatedAt: "2026-08-05T00:00:00.000Z",
    calculationVersion: "test",
  };
}

function metric(key, service, operation, value) {
  return {
    key,
    label: key,
    officialName: key,
    value,
    valueRaw: value === null ? "" : String(value),
    source: service,
    operation,
    baseYm: "202605",
  };
}

function audit(apiName, operation, status) {
  return {
    apiName,
    operation,
    status,
    latencyMs: 5,
    resultCount: status === "live" ? 1 : 0,
    totalCount: status === "live" ? 1 : 0,
    fieldsUsed: [],
    httpStatus: status === "error" ? 0 : 200,
    ...(status === "error" ? { errorCode: "NETWORK_ERROR" } : {}),
  };
}

test("S1-7 우리 호출이 실패한 지표를 공사 데이터 공백으로 세지 않는다", async () => {
  const { buildMissionCandidates } = await import(
    "../lib/insights/missions.ts"
  );
  /* 지표 2개는 값이 나왔고, 2개는 우리 호출이 실패해 비었다. 공사에 요구할
     공백은 0건이어야 한다. */
  const candidates = buildMissionCandidates(
    policyPayload({
      metrics: [
        metric("a", "AreaTarDivService", "opA", 12),
        metric("b", "AreaTarDivService", "opA", 8),
        metric("c", "AreaTarDemDsService", "opB", null),
        metric("d", "AreaTarDemDsService", "opB", null),
      ],
      ledger: [
        audit("AreaTarDivService", "opA", "live"),
        audit("AreaTarDemDsService", "opB", "error"),
      ],
    }),
  );
  const policy = candidates.find(
    (candidate) => candidate.missionType === "policy_evidence_gap",
  );
  assert.ok(policy, "정책 근거 미션 후보가 없다");
  assert.deepEqual(
    policy.evidence.missingMetrics,
    [],
    "우리 조회 실패가 공사 데이터 공백 목록에 섞였다",
  );
  assert.deepEqual(policy.evidence.unverifiableMetrics, ["c", "d"]);
  assert.equal(
    policy.active,
    false,
    "우리 실패만으로 공사 대상 개선 미션이 활성화됐다",
  );
  /* 분모에서도 빠져야 한다. 2/4가 아니라 2/2다. */
  assert.equal(policy.evidence.verifiableMetricCount, 2);
  assert.equal(policy.currentValue, 100);
  /* 본문이 두 사실을 구분해 말해야 한다. */
  assert.match(policy.summary, /이어가의 조회가 실패해 판정하지 못했습니다/);
  assert.match(policy.summary, /공사 데이터 공백이 아니며/);
});

test("S1-7 실제 공백은 그대로 공사 대상 미션이 된다", async () => {
  const { buildMissionCandidates } = await import(
    "../lib/insights/missions.ts"
  );
  /* 원천이 정상 응답으로 값을 주지 않은 경우는 공백이 맞다. 이 방향을 함께
     묶어 두지 않으면 오귀속을 고치다가 실제 공백을 놓친다. */
  const candidates = buildMissionCandidates(
    policyPayload({
      metrics: [
        metric("a", "AreaTarDivService", "opA", 12),
        metric("b", "AreaTarDivService", "opA", null),
      ],
      ledger: [audit("AreaTarDivService", "opA", "live")],
    }),
  );
  const policy = candidates.find(
    (candidate) => candidate.missionType === "policy_evidence_gap",
  );
  assert.deepEqual(policy.evidence.missingMetrics, ["b"]);
  assert.deepEqual(policy.evidence.unverifiableMetrics, []);
  assert.equal(policy.active, true);
  assert.equal(
    policy.actionContract.ownerOrganization,
    "한국관광공사 관광데이터 담당 부서(제안)",
  );
});

test("S1-7 전부 조회 실패면 완성도를 0%가 아니라 미측정으로 둔다", async () => {
  const { buildMissionCandidates } = await import(
    "../lib/insights/missions.ts"
  );
  const candidates = buildMissionCandidates(
    policyPayload({
      metrics: [
        metric("a", "AreaTarDivService", "opA", null),
        metric("b", "AreaTarDivService", "opA", null),
      ],
      ledger: [audit("AreaTarDivService", "opA", "error")],
    }),
  );
  const policy = candidates.find(
    (candidate) => candidate.missionType === "policy_evidence_gap",
  );
  /* 분모가 0인 비율을 0으로 발표하면 우리 조회 실패가 최악의 데이터 품질로
     보인다. */
  assert.equal(policy.currentValue, null);
  assert.match(policy.summary, /완성도를 판정하지 못했습니다/);
});

test("S1-6 총계와 상태 분포를 잘린 페이지에서 세지 않는다", async () => {
  const missions = await src("../lib/insights/missions.ts");
  /* 전체 집합을 대상으로 한 별도 집계 질의가 있어야 한다. */
  assert.match(missions, /db\s*\n?\s*\.select\(\{ value: count\(\) \}\)/);
  assert.match(missions, /\.groupBy\(resilienceMissions\.status\)/);
  /* 페이지 질의에만 커서가 붙고, 집계에는 붙지 않는다. */
  assert.match(missions, /\.where\(pageWhere\)/);
  const aggregates = missions.match(/\.where\(scope\)/g) ?? [];
  assert.equal(
    aggregates.length,
    2,
    "총계·분포 중 하나가 커서가 걸린 조건을 쓰고 있다",
  );
  /* 활성 미션 수도 페이지가 아니라 전체 분포에서 센다. */
  assert.match(missions, /page\.byStatus\.in_progress \?\? 0/);
  assert.ok(
    !/activeCount: missions\.filter\(/.test(missions),
    "활성 미션 수가 다시 페이지 길이에서 계산된다",
  );
});

test("S1-6 응답이 잘렸다는 사실과 이어 받을 위치를 함께 준다", async () => {
  const route = await src("../app/api/v1/insights/missions/route.ts");
  assert.match(route, /total: page\.total/);
  assert.match(route, /truncated: page\.truncated/);
  assert.match(route, /nextCursor: page\.nextCursor/);
  /* `missionCount`의 뜻을 응답 안에서 밝힌다 — 이 값이 총계로 재사용된 것이
     S1-6의 실제 경로였다. */
  assert.match(route, /countingRule/);
  assert.match(route, /missionCountMeaning: "이번 응답에 담긴 미션 수"/);
  assert.match(route, /byStatusMeaning/);
  /* 깨진 커서는 조용히 첫 페이지를 주지 않고 거절한다. */
  assert.match(route, /INVALID_MISSION_CURSOR/);
});

test("S1-6 커서는 offset이 아니라 정렬 키를 담는다", async () => {
  const { decodeMissionCursor } = await import(
    "../lib/insights/missions.ts"
  );
  /* 크론이 :17마다 미션을 갱신하므로 offset 페이징은 페이지 사이에서 항목을
     건너뛰거나 중복시킨다. */
  assert.equal(decodeMissionCursor("!!!not-base64!!!"), null);
  assert.equal(decodeMissionCursor(""), null);
  assert.equal(
    decodeMissionCursor(Buffer.from("[1,2,3]", "utf8").toString("base64url")),
    null,
    "타입이 다른 커서를 받아들였다",
  );
  const valid = Buffer.from(
    JSON.stringify([95, "2026-08-05T00:00:00.000Z", "mission-1"]),
    "utf8",
  ).toString("base64url");
  assert.deepEqual(decodeMissionCursor(valid), {
    priority: 95,
    lastEvaluatedAt: "2026-08-05T00:00:00.000Z",
    id: "mission-1",
  });

  const missions = await src("../lib/insights/missions.ts");
  /* 동순위 타이브레이커가 없으면 커서가 항목을 건너뛴다. */
  assert.match(missions, /asc\(resilienceMissions\.id\)/);
  /* 다음 페이지 존재 여부는 한 건 더 읽어 판단한다. */
  assert.match(missions, /\.limit\(pageSize \+ 1\)/);
  assert.match(missions, /const hasMore = rows\.length > pageSize/);
});
