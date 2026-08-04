import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

test("모든 탈락 사유에 사람이 읽는 라벨이 있다", async () => {
  const types = await src("../lib/recovery/types.ts");
  const flow = await src("../app/flow/FlowApp.tsx");

  const union = types
    .slice(
      types.indexOf("export type RejectionReasonCode"),
      types.indexOf("export type RejectedCandidate"),
    )
    .match(/"([A-Z_]+)"/g)
    .map((entry) => entry.replace(/"/g, ""));
  assert.ok(union.length >= 14, `사유 코드가 너무 적다: ${union.length}`);

  const labels = flow.slice(
    flow.indexOf("const REJECTION_LABELS"),
    flow.indexOf("function knownRejectionSummary"),
  );
  for (const code of union) {
    assert.ok(
      labels.includes(`${code}: {`),
      `${code}의 라벨이 없다 — 0건 화면에 내부 코드가 그대로 찍힌다`,
    );
  }
  /* 사전을 유니온으로 좁혀야 다음에 사유를 추가할 때 컴파일이 막힌다. */
  assert.match(flow, /Record<\s*RejectionReasonCode,/);
});

test("응답의 미지 사유 코드는 화면에 원시 문자열로 나가지 않는다", async () => {
  const flow = await src("../app/flow/FlowApp.tsx");
  /* 렌더에 fallback이 남아 있으면 라벨 없는 코드가 그대로 표시된다. */
  assert.ok(
    !/REJECTION_LABELS\[entry\.reasonCode\]\?\.\[language\] \?\?/.test(flow),
    "라벨 미존재 시 내부 코드를 출력하는 fallback이 남아 있다",
  );
  assert.match(flow, /function knownRejectionSummary/);
  assert.match(flow, /code in REJECTION_LABELS/);
  assert.match(flow, /setRejectionSummary\(knownRejectionSummary\(/);
});

test("0건 화면이 실측 최다 사유를 이름으로 설명한다", async () => {
  const flow = await src("../app/flow/FlowApp.tsx");
  /* 실측 탈락 1·2위였는데 둘 다 일반 문구로 떨어져 원인을 말하지 못했다. */
  for (const code of [
    "INDOOR_UNVERIFIED",
    "TRAVEL_PURPOSE_MISMATCH",
    "ACCESSIBILITY_UNVERIFIED",
    "OPEN_WINDOW_OVERFLOW",
  ]) {
    assert.ok(
      flow.includes(`top === "${code}"`),
      `${code}가 최다 사유일 때의 안내 문구가 없다`,
    );
  }
});
