import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 2026-08-05 AI 가상 페르소나 조사(23명, 실호출 43회)가 찾은 S1 치명 결함의
   회귀 방지. 각 테스트는 조사에서 실제로 관측된 값을 그대로 쓴다. */

const audit = {
  apiName: "KorService2",
  operation: "detailIntro2",
  status: "live",
  latencyMs: 10,
  resultCount: 1,
  totalCount: 1,
  fieldsUsed: [],
  httpStatus: 200,
};

function at(hour, minute = 0) {
  /* KST 기준으로 그 시각을 만든다. 판정이 한국 시간대로 계산되므로 UTC로 환산. */
  return new Date(Date.UTC(2026, 7, 5, hour - 9, minute));
}

test("S1-3 표기가 자세한 곳이 검사를 건너뛰지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  /* 조사에서 07:2x~07:3x 호출에 1순위로 올라온 실제 값들. 모두
     `official_hours_unstructured`로 통과했다. */
  const cases = [
    { usetimeculture: "[평일] 10:00~19:00 (입장 마감 18:00) / [주말] 10:00~20:00" },
    { usetimeculture: "09:00~18:00 (입장 마감 17:30)" },
    { usetimeculture: "화요일~일요일 10:00~18:30 (매표 마감 18:00)" },
    { usetime: "11:00~19:00" },
  ];
  for (const item of cases) {
    const evidence = evaluateAvailabilityItem(
      item,
      audit,
      at(7, 40),
      at(9, 10),
    );
    assert.equal(
      evidence.status,
      "confirmed_closed",
      `개관 전 시각인데 걸러지지 않았다: ${JSON.stringify(item)} → ${evidence.status}`,
    );
  }
});

test("S1-3 열려 있는 시각은 여전히 단정하지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  /* 어느 요일 규칙이 적용되는지 모르는 상태에서 "열려 있다"고 말하는 것은 근거를
     넘어서는 주장이다. 구간 안이면 미확정으로 남겨야 한다. */
  const evidence = evaluateAvailabilityItem(
    { usetimeculture: "[평일] 10:00~19:00 / [주말] 10:00~20:00" },
    audit,
    at(13, 0),
    at(14, 0),
  );
  assert.equal(evidence.status, "official_hours_unstructured");

  /* 표기가 명확한 단일 구간이면 그때는 열려 있다고 확정한다. */
  const clear = evaluateAvailabilityItem(
    { usetime: "09:00~18:00" },
    audit,
    at(13, 0),
    at(14, 0),
  );
  assert.equal(clear.status, "confirmed_open");
});

test("S1-2 대여 정보 한 줄이 내부 이동 확인으로 승격되지 않는다", async () => {
  const { evaluateAccessibility } = await import(
    "../lib/recovery/engine.ts"
  ).then((module) => module).catch(() => ({}));
  /* `evaluateAccessibility`가 내부 함수라면 소스로 계약을 고정한다. */
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  void evaluateAccessibility;
  assert.match(engine, /function rentalOnlyAccessibility/);
  /* 대여만 말하는 값은 필수 항목 충족에서 빠진다. */
  assert.match(engine, /const confirmedForRequired = new Set\(/);
  assert.match(
    engine,
    /\.filter\(\(entry\) => !rentalOnlyAccessibility\(entry\.value\)\)/,
  );
  /* 같은 문장에 동선 표현이 함께 있으면 인정한다 — 정보를 버리는 게 아니다. */
  const fn = engine.slice(
    engine.indexOf("function rentalOnlyAccessibility"),
    engine.indexOf("function accessibilityFields"),
  );
  assert.match(fn, /mentionsMobility/);
  for (const word of ["대여", "렌탈", "보유"]) {
    assert.ok(fn.includes(word), `대여 표현 ${word}이 목록에 없다`);
  }
  for (const word of ["경사", "단차", "엘리베이터"]) {
    assert.ok(fn.includes(word), `동선 표현 ${word}이 목록에 없다`);
  }
});

test("S1-2 장애물이 없다는 진술을 부정으로 읽지 않는다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* `단차 없음`을 부정으로 처리하면 동선을 가장 정확하게 적어 둔 곳이 버려지고
     `대여 가능`만 남은 곳이 등급을 얻는다. 같은 역선택의 다른 얼굴이다. */
  const fn = engine.slice(
    engine.indexOf("function positiveAccessibility"),
    engine.indexOf("/* 무장애 필드의 값이"),
  );
  assert.match(fn, /withoutBarrierAbsence/);
  for (const word of ["단차", "문턱", "계단", "장애물"]) {
    assert.ok(fn.includes(word), `장애물 표현 ${word}이 목록에 없다`);
  }
  /* `해당 없음`·`엘리베이터 없음`은 여전히 부정이어야 한다. */
  assert.ok(fn.includes("해당\\s*없음"), "기존 부정 판정이 사라졌다");
});

test("S1-4 집중률 라벨이 자기 카드의 수치와 모순되지 않는다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* 조사 관측: 이 카드 63.77, 위 카드 14.01인데 라벨이 "덜 붐빌 것으로 예측된
     곳"이었다. 최저 후보가 앞 카드에 쓰이면 차순위가 라벨을 물려받았다. */
  /* 점수 계산 분기가 아니라 라벨을 만드는 블록을 본다. */
  const branch = engine.slice(
    engine.indexOf('"comfortable",'),
    engine.indexOf("} else {\n    addFirstUnused("),
  );
  assert.ok(
    branch.length > 0 && branch.length < 3000,
    `라벨 블록을 찾지 못했다 (${branch.length}자)`,
  );
  assert.match(branch, /const lowerAlreadyShown = selected\.some\(/);
  /* 판정 축은 절대값에서 `crowdComfortScore`로 옮겼다 — 점수·정렬·라벨이
     한 함수를 쓰지 않으면 다시 갈린다. 불변식은 그대로다: 더 덜 붐비는
     후보가 이미 보였으면 "덜 붐빌" 라벨을 쓰지 않는다. */
  assert.match(branch, /crowdComfortScore\(entry\.candidate\) >= score/);
  const engineAll = engine;
  for (const site of [
    /const crowdScore = crowdComfortScore\(candidate\);/,
    /crowdComfortScore\(b\) - crowdComfortScore\(a\)/,
  ]) {
    assert.match(
      engineAll,
      site,
      `점수·정렬 중 하나가 공통 함수를 쓰지 않는다: ${site}`,
    );
  }
  /* 더 낮은 후보가 이미 보였으면 다른 문구를 쓴다. */
  assert.match(branch, /집중률 예측을 확인한 곳/);
  /* 예측값이 아예 없으면 그것도 밝힌다. */
  assert.match(branch, /집중률 예측을 확인하지 못한 곳/);
});

test("S1-5 접근성 미확인이 추천 이유에 반드시 나온다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* 조사 관측: grade X · 필수 항목 전부 missing인 후보가 유일 추천인데 `why`
     다섯 문장에 접근성 문장이 0개였다. `evidenceGaps`는 "자동 복구안에서
     제외합니다"라고 적혀 있는데 화면은 추천으로 보여주는 상태였다. */
  assert.match(engine, /} else if \(input\.audience !== "general"\) \{/);
  assert.match(engine, /요청한 이동 조건 중 \$\{missing\.join/);
  assert.match(engine, /출발 전에 직접 확인해 주세요/);
  /* 무엇이 확인되지 않았는지 이름을 대야 한다. */
  assert.match(engine, /requiredChecks\s*\n?\s*\.filter\(\(check\) => check\.status === "missing"\)/);
});
