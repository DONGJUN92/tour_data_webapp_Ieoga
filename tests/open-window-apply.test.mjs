import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/* 가상 페르소나 조사에서 찾은 S1-1의 회귀 방지.
 *
 * `지금 갈 곳 찾기`의 적용이 구조적으로 열리지 않았다. 화면은 동의 체크박스와
 * 적용 CTA를 정상 노출하는데, 서버는 `itineraryId`·`disruptedNodeId`·
 * `nextFixedNodeId`가 없다는 이유로 항상 409 INVALID_STATE를 돌려줬다.
 * 세 지역·세 runId·네 번의 시도가 모두 그렇게 끝났다. 동의까지 통과시킨 뒤
 * 마지막 클릭에서 반드시 실패하는 흐름이었고, 이 탭에서는 기획 14.2의
 * `적용 완료` 계열 지표를 아예 산출할 수 없었다.
 *
 * 실행 계약이 D1 스키마와 얽혀 있어 단위 테스트로 왕복을 재현하기 어렵다.
 * 대신 다시 깨질 수 있는 지점을 소스에서 고정한다. 실제 왕복은 로컬 운영
 * 서버에서 확인했다: 적용 HTTP 201 activated → 진행 조회 200 → 도착 확인 200
 * `completed`. */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

test("빈 시간 추천은 일정 3종 값이 없다는 이유로 적용을 막지 않는다", async () => {
  const repo = await src("../lib/db/repository.ts");
  /* 모드를 읽어야 구분할 수 있다. */
  assert.match(repo, /recoveryMode: recoveryRuns\.recoveryMode/);
  assert.match(repo, /const insertOnly = run\.recoveryMode === "open_window"/);
  /* 예전 조건이 그대로 남아 있으면 다시 409가 된다. */
  assert.match(
    repo,
    /!insertOnly &&\s*\n?\s*\(!run\.itineraryId \|\| !run\.disruptedNodeId \|\| !run\.nextFixedNodeId\)/,
  );
  /* 일정 소유권 확인과 노드 인덱스 검증도 함께 우회해야 한다. */
  assert.match(repo, /if \(!insertOnly && !itineraryRows\[0\]\)/);
  assert.match(repo, /const disruptedIndex = insertOnly\s*\n?\s*\? -1/);
});

test("끼워 넣기의 실행 계획은 그 한 곳 한 단계다", async () => {
  const repo = await src("../lib/db/repository.ts");
  /* 이어 붙일 경유지가 없으므로 단계를 만들어 낼 것도 없다. */
  assert.match(
    repo,
    /\.\.\.\(insertOnly \? \[\] : nodeRows\.slice\(disruptedIndex \+ 1\)\)/,
  );
  /* 완주 확인 시점의 기준이 필요하다 — 알려 준 다음 장소가 있으면 그 도착
     시각, 없으면 체류 종료 시각. */
  assert.match(repo, /const nextFixedStepSequence = insertOnly/);
  assert.match(repo, /openWindowNextArrival/);
  assert.match(repo, /replacement\.endAt/);
});

test("적용 시점에 한 곳짜리 일정을 같은 원자 배치로 만든다", async () => {
  const repo = await src("../lib/db/repository.ts");
  /* `base_itinerary_id`는 필수 컬럼이다. 널 허용으로 바꾸면 "적용했는데 기준
     일정이 없는 실행"이라는 상태가 생기고 진행 화면이 그것을 따로 다뤄야 한다.
     실제로 생긴 일정을 저장하는 편이 데이터와 사실이 맞는다. */
  assert.match(repo, /const insertOnlyItineraryId = insertOnly \? crypto\.randomUUID\(\) : undefined/);
  assert.match(repo, /clientNodeId: "inserted-stop"/);
  assert.match(
    repo,
    /baseItineraryId: insertOnlyItineraryId \?\? \(run\.itineraryId as string\)/,
  );

  /* 원자성이 깨지면 기준 일정 없는 실행이 남는다. 일정·노드·실행이 모두 같은
     writes 배열에 들어가야 한다. */
  const activate = repo.slice(repo.indexOf("const insertOnly = run.recoveryMode"));
  const batch = activate.slice(0, activate.indexOf("const writes: D1WriteBatch"));
  assert.ok(
    !/await db\s*\n?\s*\.insert\(itineraries\)/.test(batch),
    "일정 생성이 배치 밖에서 즉시 실행된다",
  );
  assert.match(activate, /writes\.push\(\s*\n?\s*db\.insert\(itineraries\)/);
  assert.match(activate, /writes\.push\(\s*\n?\s*db\.insert\(itineraryNodes\)/);
});

test("만들어진 일정도 세션 만료·삭제 규칙을 따른다", async () => {
  const repo = await src("../lib/db/repository.ts");
  const block = repo.slice(
    repo.indexOf("const insertOnlyItineraryId"),
    repo.indexOf("db.insert(journeyExecutions)"),
  );
  /* 복구 실행과 같은 만료 시각을 쓴다. 별도 보관 기간을 만들면 개인정보
     처리방침에 적힌 기간과 실제가 갈린다. */
  assert.match(block, /expiresAt: run\.expiresAt/);
  assert.match(block, /sessionId: params\.sessionId/);
  /* 세션 삭제는 sessions FK의 cascade로 함께 지워진다. */
  const schema = await src("../db/schema.ts");
  const itineraryTable = schema.slice(
    schema.indexOf("export const itineraries = sqliteTable"),
  );
  assert.match(
    itineraryTable.slice(0, 400),
    /references\(\(\) => sessions\.id, \{ onDelete: "cascade" \}\)/,
  );
});
