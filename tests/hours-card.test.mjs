import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/* 카드에서 "운영 정보"가 실제로 읽히는지에 대한 계약.
 *
 * 화면에서 확인한 것 — `[하절기(3~10월)] · 09:30~17:30 (입장마감 17:00) ·
 * [동절기(11~2월)] · 10:00~17:00 · 휴무 매주 월요일 · 도착 시각과 자동으로
 * 대조하지는 못했습니다. · 확인: 042-610-7610`이 절반 폭 상자 안에서 열 줄로
 * 흘렀다. 어느 시간이 어느 계절의 것인지 세어 가며 읽어야 했고, 정작 옆 칸의
 * `붐빔 정도`는 두 글자만 담고 비어 있었다. */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

test("운영 정보에는 운영시간·요일만 남고 판정 설명과 연락처는 빠진다", async () => {
  const availability = await src("../lib/kto/availability.ts");
  const note = availability.slice(
    availability.indexOf("function hoursLine"),
    availability.indexOf("function parseTimeRanges"),
  );
  assert.match(note, /운영시간 \$\{hours/);
  assert.match(note, /휴무 \$\{rest\}/);
  /* 상자는 "몇 시에 여는가" 하나만 답한다. 아래 셋이 다시 들어오면 그 답이
     다시 문장 더미 속에 묻힌다. */
  for (const banned of [
    "도착 시각과 자동으로 대조하지는 못했습니다.",
    "도착 시각에 문을 엽니다.",
    "확인: ${contact}",
  ]) {
    assert.ok(
      !availability.includes(banned),
      `운영 정보 상자에 '${banned}'가 다시 들어왔다`,
    );
  }
});

test("계절·요일 구간은 줄을 나눠 구분한다", async () => {
  const availability = await src("../lib/kto/availability.ts");
  assert.match(availability, /function splitByCondition/);
  /* 실제 원문으로 재현한다. */
  const split = (value) =>
    value
      .replace(/\s*(\[[^\]]+\])\s*/gu, "\n$1 ")
      .split("\n")
      .map((line) =>
        line.replace(/\s+/gu, " ").replace(/^[·,/\s]+|[·,/\s]+$/gu, ""),
      )
      .filter(Boolean)
      .join("\n");
  const lines = split(
    "[하절기(3~10월)] 09:30~17:30 (입장마감 17:00) [동절기(11~2월)] 10:00~17:00 (입장마감 16:30)",
  ).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[하절기\(3~10월\)\] 09:30~17:30/);
  assert.match(lines[1], /^\[동절기\(11~2월\)\] 10:00~17:00/);
  /* 상시 개방은 한 줄 그대로. "운영시간 상시 개방"은 군더더기다. */
  assert.match(availability, /ALWAYS_OPEN\.test\(hours\) && hours\.length <= 12/);

  /* 줄바꿈이 CSS에서 다시 뭉개지면 갈라 놓은 뜻이 없어진다. */
  const css = await src("../app/flow/flow.module.css");
  assert.match(css, /\.factWide dd,[\s\S]*?white-space: pre-line;/);
});

test("운영 정보 상자는 가로 전체를 쓰고, 검증 칸은 붐빔이 대신한다", async () => {
  const css = await src("../app/flow/flow.module.css");
  assert.match(css, /dl\.factWide[\s\S]*?grid-column: 1 \/ -1;/);

  const flow = await src("../app/flow/FlowApp.tsx");
  assert.match(flow, /fact\.key === "availability" \? styles\.factWide/);
  /* `✓` 하나로는 무엇이 검증됐는지 알 수 없었다. 그 칸은 실제 값으로 채운다. */
  assert.match(flow, /crowdBadgeText\(option\.crowd, language\) \|\| "—"/);
  assert.ok(
    !/tr\("검증", "Status"\)/.test(flow),
    "뜻을 나르지 못하던 검증 칸이 다시 들어왔다",
  );
  /* 붐빔이 위로 갔으므로 아래 근거 상자에서는 빠진다 — 같은 값을 한 카드에
     두 번 적으면 카드만 길어진다. */
  assert.ok(!/ko: "붐빔 정도"/.test(flow), "붐빔이 두 곳에 중복으로 남아 있다");
});

/* 연락처는 한 번 더 옮겼다. 예전에는 근거 불릿의 문장이었는데("운영시간을 도착
   전에 확인하려면 …로 문의할 수 있습니다"), 전화번호는 근거가 아니라 장소
   정보이고 문장으로 감싸면 눌러야 할 번호가 문장 속에 묻힌다. 지금은
   `travelerFacts`의 "문의" 항목이다. 지켜야 할 것은 문장이 아니라 **버리지
   않는다**는 사실이므로, 그것을 확인한다. */
test("연락처는 버리지 않고 여행 정보 항목으로 옮긴다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  assert.match(engine, /availability\?\.contact/);
  const facts = engine.slice(
    engine.indexOf("function buildTravelerFacts"),
    engine.indexOf("function buildWhy"),
  );
  assert.match(facts, /code: "contact"/);
  assert.match(facts, /value: availability\.contact/);
  assert.match(facts, /prominent: true/);
});

test("모든 카드에 똑같이 붙던 목적 연속성 문장은 비운다", async () => {
  const engine = await src("../lib/recovery/engine.ts");
  const block = engine.slice(
    engine.indexOf('status: "supported_visit_category"'),
    engine.indexOf('status: "changed_visit_category"'),
  );
  assert.ok(
    !/같은 관광·체험 목적으로 이어지는 공식 관광 콘텐츠입니다/.test(block),
    "모든 후보에 동일하게 붙는 문장이 되살아났다",
  );
  assert.match(block, /statement: "",/);
  /* 목적이 **바뀐** 경우의 문장은 남아야 한다 — 그때는 카드마다 다르다. */
  assert.match(
    engine.slice(engine.indexOf('status: "changed_visit_category"')),
    /statement: `/,
  );
});
