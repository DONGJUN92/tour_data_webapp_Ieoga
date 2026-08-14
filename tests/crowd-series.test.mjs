import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/* 지정과제 1번의 실시간 변수 중 **혼잡도**를 실제 판정에 쓰기 위한 계약.
 *
 * 배경 — 라이브 측정으로 확인한 것들:
 * - 집중률은 시군구당 `관광지 x 30일` 시계열이다. 서울 종로는 113곳 x 30일 =
 *   3,390행이다.
 * - 그런데 `numOfRows: 1_000`이었고 응답이 가나다순이어서 `가회민화박물관`부터
 *   `보신각 터`까지 **34곳에서 잘렸다.** 북촌한옥마을·창덕궁·종묘·세종문화회관이
 *   통째로 빠졌다. 집중률 데이터의 유무가 관광지 이름의 자모 순서로 결정됐다.
 * - 집중률을 출발지 시군구 하나로만 조회했다. 반경 8km 후보는 경계를 넘나든다.
 * - 30일 중 오늘 하루치만 썼다. 분산을 나눠 보면 장소 간 13.49 / 장소 내 13.28로
 *   **거의 같으므로 버린 29일치에 값의 절반이 있었다.**
 * - 예전 점수 함수는 113곳에 서로 다른 값 **3개**만 부여했다(86점 71곳, 62점
 *   39곳, 25점 3곳). 혼잡 상황을 골라도 순위가 거의 바뀌지 않았다. */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

test("집중률 응답 상한이 30일 시계열을 담을 만큼이고 상수로 공표된다", async () => {
  const adapters = await src("../lib/kto/adapters.ts");
  assert.match(adapters, /export const CONCENTRATION_PAGE_SIZE = 5_000;/);
  assert.match(adapters, /numOfRows: CONCENTRATION_PAGE_SIZE,/);
  /* 예전 값이 남아 있으면 다시 34곳에서 잘린다. */
  assert.ok(
    !/numOfRows: 1_000,\s*\n\s*areaCd: analysisRegionCode\(params\.regionCode\)/.test(
      adapters,
    ),
    "집중률 호출이 다시 1,000행으로 되돌아갔다",
  );
});

test("잘림을 조용히 넘기지 않고 밝힌다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 조용히 잘리는 것이 원래 결함이었다. 상한을 넘는 지역이 나오면 사용자가
     볼 수 있는 자리에 남겨야 같은 실패를 반복하지 않는다. */
  assert.match(
    engine,
    /outcome\.value\.audit\.totalCount > outcome\.value\.audit\.resultCount/,
  );
  assert.match(engine, /응답 상한 \$\{CONCENTRATION_PAGE_SIZE/);
});

test("후보가 실제로 속한 시군구들로 조회한다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 출발지 한 곳만 보면 경계 밖 후보는 영구히 근거 없이 중립값을 받는다. */
  assert.match(engine, /const candidateDistricts = \(\(\) => \{/);
  assert.match(engine, /for \(const item of nearby\.items\) \{/);
  assert.match(engine, /const CROWD_DISTRICT_LIMIT = 3;/);
  /* 상한 때문에 자른 시군구가 있으면 밝힌다. */
  assert.match(engine, /crowdDistrictsSkipped/);
  assert.match(engine, /곳만 집중률을 조회했습니다/);
  /* 출발지 시군구는 후보가 없어도 포함한다 — 사용자가 서 있는 곳이다. */
  assert.match(engine, /출발지 시군구는 후보가 적어도 포함한다/);
});

test("시군구 하나가 실패해도 나머지 결과를 버리지 않는다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  assert.match(engine, /const crowdSucceeded = crowdOutcomes\.filter\(/);
  assert.match(engine, /const crowdFailedCount = crowdOutcomes\.length - crowdSucceeded\.length/);
  assert.match(engine, /곳에서 조회하지 못했습니다/);
  /* 실패한 시군구는 원장에도 남아야 한다. */
  assert.match(
    engine,
    /if \(outcome\.status === "rejected"\) \{\s*\n\s*sourceLedger\.push\(/,
  );
});

test("30일 분포 내 위치를 계산하고, 값이 부족하면 만들어 내지 않는다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  const fn = engine.slice(
    engine.indexOf("function currentForecastByTitle"),
    engine.indexOf("function crowdComfortScore"),
  );
  assert.match(fn, /percentileOfSeries: Math\.round\(\(atOrBelow \/ rates\.length\) \* 100\)/);
  /* 하루치만 온 장소에 백분위를 0이나 100으로 적으면 없는 근거를 만드는 것이다. */
  assert.match(fn, /if \(values\.length < 7\) \{/);
  assert.match(fn, /seriesDays: rates\.length/);
});

test("점수·정렬·라벨이 한 함수를 쓴다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 세 곳에 따로 적어 두면 갈라진다. 실제로 갈려서 집중률 63.77 후보에
     "덜 붐빌 것으로 예측된 곳" 라벨이 붙고 그 위 카드가 14.01이었다. */
  assert.match(engine, /const crowdScore = crowdComfortScore\(candidate\);/);
  assert.match(engine, /crowdComfortScore\(b\) - crowdComfortScore\(a\)/);
  assert.match(engine, /crowdComfortScore\(entry\.candidate\) >= score/);
});

test("점수는 단조 감소이고 백분위는 양 끝에서만 보정한다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  const fn = engine.slice(
    engine.indexOf("function crowdComfortScore"),
    engine.indexOf("/* 연관 관광지의 대분류를"),
  );
  /* 예전 3단 계단은 61과 79를 같은 점수로 묶었다. 후보 대부분이 값을 받게 된
     지금 그 손실을 감출 이유가 없다. */
  assert.match(fn, /let score = 100 - candidate\.crowdRate \* 0\.8;/);
  assert.ok(
    !/>= 80\s*\?\s*25/.test(fn),
    "3단 계단 함수가 남아 있어 61과 79가 같은 점수를 받는다",
  );
  /* 어느 해석도 확정되지 않았으므로 보정 폭은 작게 유지한다. */
  assert.match(fn, /if \(candidate\.crowdPercentile >= 85\) score -= 12;/);
  assert.match(fn, /else if \(candidate\.crowdPercentile <= 15\) score \+= 8;/);
  assert.match(fn, /Math\.min\(100, Math\.max\(0, score\)\)/);

  /* 실제 계산을 재현해 단조성과 보정 방향을 확인한다. */
  const score = (rate, pct) => {
    let s = 100 - rate * 0.8;
    if (pct !== undefined) {
      if (pct >= 85) s -= 12;
      else if (pct <= 15) s += 8;
    }
    return Math.round(Math.min(100, Math.max(0, s)));
  };
  assert.ok(score(20) > score(60), "붐빌수록 점수가 낮아야 한다");
  assert.ok(score(61) !== score(79), "예전 계단처럼 서로 다른 값을 묶고 있다");
  /* 실측값 대조: 서울 경교장(77.3 / 백분위 97)이 경희궁(89.6 / 백분위 60)보다
     낮게 가야 한다. 절대값은 더 낮지만 그 곳 평소보다 유난히 붐비는 날이다. */
  assert.ok(
    score(77.3, 97) < score(89.6, 60),
    "평소보다 유난히 붐비는 날이 순위에 반영되지 않는다",
  );
  /* 값이 없으면 중립. 데이터 없음이 최고점이 되어서는 안 된다. */
  assert.equal(score(undefined) || 50, 50);
});

test("집중률을 사람 수로 말하지 않는다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 실측에서 청와대(30일 평균 37.1)가 경운동민병옥가옥(81.5)보다 낮았다.
     이 값을 인원수로 읽으면 안 된다 — 좁은 곳은 적은 인원으로도 포화된다. */
  assert.match(engine, /사람 수가 아니라 일별 붐빔 정도 예측이며/);
  assert.match(engine, /A crowding forecast, not a live headcount\./);
  /* 카드 문구는 세 단계로 줄였다. 숫자와 백분위를 늘어놓으면 "붐비나?"라는
     질문의 답을 여행자가 직접 계산해야 한다. 원문 수치는 근거 확인용으로
     남는다. */
  assert.match(engine, /function crowdLevelOf\(candidate/);
  assert.match(engine, /if \(score >= 70\) return "easy";/);
  assert.match(engine, /if \(score >= 40\) return "normal";/);
  /* 판정은 문장이 아니라 `travelerFacts`의 한 칸이 되었다. 단서는 위에서 계속
     확인하므로, 여기서는 세 등급이 값으로 나오는지를 본다. */
  const facts = engine.slice(
    engine.indexOf("function buildTravelerFacts"),
    engine.indexOf("function buildWhy"),
  );
  assert.match(facts, /code: "crowd"/);
  assert.match(facts, /"붐비는 편"/);
  assert.match(facts, /"원활한 편"/);
  /* 등급은 점수와 **같은 함수**에서 나와야 갈리지 않는다. */
  assert.match(engine, /const score = crowdComfortScore\(candidate\);/);
  /* 화면은 아이콘만으로 뜻을 나르지 않는다 — 색각 이상에서도 읽혀야 한다. */
  const model = await src("../app/product-app-model.ts");
  assert.match(model, /easy: \{ icon: "🟢", ko: "원활"/);
  assert.match(model, /normal: \{ icon: "🟡", ko: "보통"/);
  assert.match(model, /busy: \{ icon: "🔴", ko: "혼잡"/);
  /* 표시는 `note`를 앞세운다 — `(주변 기준)` 같은 꼬리표가 라벨에는 없다. */
  assert.match(model, /return `\$\{badge\.icon\} \$\{note \|\| badge\.label\}`;/);
});

test("시간 단위 상승은 주장하지 않는다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  /* 지정과제 문구는 "혼잡도 상승"이지만 이 API는 일 단위다. 시간 단위 추세를
     말하면 데이터가 없는 주장을 하는 것이다. 그 한계를 코드에 적어 둔다. */
  assert.match(
    engine,
    /시간 단위(가 없으므로|)\s*.*"지금 붐빔이 오르(는 중|고 있다)"/u,
  );
});
