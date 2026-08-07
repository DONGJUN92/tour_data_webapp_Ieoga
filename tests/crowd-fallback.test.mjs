import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/* 집중률은 **관광지 전용 데이터셋**이다. 반경 5km 후보를 유형별로 세어 측정한
 * 매칭률(2026-08-07, 라이브):
 *
 *              대전 중구      서울 종로구
 *   관광지        26% (23곳)    27% (59곳)
 *   음식점         0% (45곳)     0% (86곳)
 *   축제행사/숙박/레포츠  0%            0%
 *
 * 음식점 131곳에서 매칭 0곳이다. 표본이 적어서가 아니라 대상에 없다. 한 축만
 * 두면 그 유형들은 영원히 빈칸이 되므로 두 갈래로 메운다.
 *
 * - 주변 대체: 이미 받아 온 시군구 30일 시계열(종로 3,390행)에서 반경 800m
 *   이웃의 중앙값을 빌린다. 추가 호출 0건.
 * - 연관 관광지 순위: 이미 호출하는 값이다. 측정 커버리지는 음식점 16~35%,
 *   쇼핑 17~60%, 축제행사 26% — 집중률이 못 덮는 유형을 정확히 덮는다. */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

test("주변 대체는 중앙값을 쓰고 최소 표본을 요구한다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  assert.match(engine, /const CROWD_NEIGHBOR_RADIUS_METERS = 800;/);
  assert.match(engine, /const CROWD_NEIGHBOR_MIN_SAMPLES = 2;/);
  /* 평균은 관광지 한 곳의 극단값이 골목 전체를 물들인다. */
  assert.match(engine, /function medianOf\(values: number\[\]\)/);
  assert.match(engine, /crowdRate: medianOf\(near\.map\(/);
  /* 이웃이 한 곳뿐이면 대체하지 않는다 — 한 점을 일대의 값이라 부를 수 없다. */
  assert.match(engine, /if \(near\.length < CROWD_NEIGHBOR_MIN_SAMPLES\) return candidate;/);

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  assert.equal(median([10, 20, 90]), 20, "극단값이 중앙값을 끌고 가면 안 된다");
  assert.equal(median([10, 20]), 15);
});

test("대체는 후보가 모두 모인 뒤에 하고, 점수를 다시 매긴다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 한 곳씩 처리하는 동안에는 주변에 무엇이 있는지 알 수 없다. */
  assert.match(engine, /const withNeighbors = withNeighborCrowd\(preliminary\)\.map/);
  /* 옛 점수로 정렬하면 대체값이 순위에 반영되지 않는다. */
  assert.match(engine, /\.\.\.scoreCandidate\(candidate, input\),\s*\}\)\);/);
  assert.ok(
    engine.indexOf("const withNeighbors") < engine.indexOf("preliminary.sort("),
    "정렬보다 뒤에서 대체하면 순위가 옛 값으로 굳는다",
  );
});

test("빌려 온 값은 직접 잰 값을 이기고 올라가지 않는다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  assert.match(engine, /if \(candidate\.crowdBasis === "nearby"\) score = 50 \+ \(score - 50\) \* 0\.6;/);
  const score = (rate, basis) => {
    let s = 100 - rate * 0.8;
    if (basis === "nearby") s = 50 + (s - 50) * 0.6;
    return Math.round(Math.min(100, Math.max(0, s)));
  };
  /* 같은 집중률이면 직접 잰 쪽이 더 한산하다고 인정받는다. */
  assert.ok(score(20, "place") > score(20, "nearby"));
  /* 방향은 뒤집히지 않는다 — 축소일 뿐 부호를 바꾸지 않는다. */
  assert.ok(score(20, "nearby") > score(80, "nearby"));
});

test("빌려 온 값임을 카드에서 숨기지 않는다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  assert.match(engine, /basis: candidate\.crowdBasis \?\? "place",/);
  assert.match(engine, /candidate\.crowdBasis === "nearby" \? " \(주변 기준\)" : ""/);
  assert.match(engine, /neighborCount: candidate\.crowdNeighborCount,/);
});

test("인기 순위는 붐빔과 다른 축으로 표시한다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  assert.match(engine, /status: "popularity_rank",/);
  /* 임의의 등급을 만들지 않고 순위 자체를 적는다. */
  assert.match(engine, /note: `인기 \$\{candidate\.relatedRank\}위`,/);
  /* 순위가 붐빔 칸을 채웠으면 아래 불릿에 같은 값을 다시 적지 않는다. */
  assert.match(
    engine,
    /if \(candidate\.relatedRank !== undefined && candidate\.crowdRate !== undefined\) \{/,
  );

  const types = await src("../lib/recovery/types.ts");
  assert.match(types, /status: "available" \| "popularity_rank" \| "unavailable";/);

  /* 신호등 아이콘을 쓰면 초록을 "지금 한산하다"로 읽는다. 실제로는 월 단위
     인기 집계다. */
  const flow = await src("../app/flow/FlowApp.tsx");
  assert.match(flow, /if \(record\.status === "popularity_rank"\) return label \? `⭐ \$\{label\}` : "";/);
});
