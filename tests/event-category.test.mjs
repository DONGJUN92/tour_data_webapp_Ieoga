import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

/* `@/lib` 경로 별칭을 노드가 풀 수 있게 한다. 다른 단위 테스트와 같은 훅이다. */
register(new URL("./alias-loader.mjs", import.meta.url));

/* 축제·공연·행사(contentTypeId 15)는 기간이 있는 콘텐츠다. 다른 분류와 같은 길로
   찾으면 틀린다.
 *
 * 2026-08-19 공사 API 실측:
 *  - `locationBasedList2`(contentTypeId=15, 대전역 반경 20km): 10건이 돌아왔고
 *    응답에 `eventstartdate`/`eventenddate`가 **없다.** 상세조회로 확인한 표본
 *    6건이 전부 이미 끝난 행사였다(20250829~20250831 등).
 *  - 그 결과 프로덕션에서 이 분류만 고르면 `OFFICIALLY_CLOSED: 3`, 후보 0곳.
 *    끝난 행사를 추천하지는 않았지만(다행) 화면은 백지였고, 끝난 행사 하나를
 *    알아내는 데 외부 조회를 한 건씩 썼다.
 *  - `searchFestival2`(eventStartDate=오늘): 대전 3건·서울 32건, 이미 끝난 행사
 *    0건, 기간과 좌표가 목록에 함께 옴.
 *
 * 그래서 행사만은 전용 조회를 쓴다. 이 파일은 그 선택이 코드에 남아 있는지와,
 * 날짜 판정이 목록 데이터만으로 이뤄지는지를 고정한다. */

test("행사는 위치 목록이 아니라 기간을 주는 전용 조회로 찾는다", async () => {
  const adapters = await readFile(
    new URL("../lib/kto/adapters.ts", import.meta.url),
    "utf8",
  );
  assert.match(adapters, /searchFestival2/);
  assert.match(adapters, /eventStartDate: params\.eventStartDate/);
  /* 기간을 실제로 받아 와야 한다. 공개 목록에 없으면 우리가 그 값을 쓴다고
     말할 수 없다. */
  assert.match(adapters, /"eventstartdate"/);
  assert.match(adapters, /"eventenddate"/);

  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  assert.match(engine, /getFestivals\(/);
  /* 여행자가 행사를 골랐을 때, 또는 분류를 고르지 않았을 때만 부른다.
     다른 분류만 골랐다면 이 조회는 결과에 쓰이지 않으므로 예산을 쓰지 않는다. */
  assert.match(engine, /input\.tourismCategories\.includes\("EVENT"\)/);
  /* 지역 단위 조회이므로 반경은 우리가 판정한다. */
  assert.match(engine, /candidateRadiusMeters/);
  /* 실패해도 전체 조회를 무너뜨리지 않는다. */
  assert.match(engine, /auditFromFailure\("KorService2", "searchFestival2"/);

  /* 지역 코드가 없으면 전국 검색이 된다. 나머지 파이프라인과 같은 대체 경로를
     쓴다. */
  assert.match(engine, /input\.origin\.areaCode \?\?[\s\S]{0,40}normalizeAnalysisCodes/);

  /* 한 페이지로 잘렸으면 그 사실을 밝힌다 — 집중률 조회에서 이미 겪은 잘림이다. */
  assert.match(engine, /festivals\.totalCount > festivals\.items\.length/);
});

test("행사는 위치 목록보다 먼저 담고, 날짜 없는 사본은 버린다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );

  /* 순서가 곧 정확도다. 중복 제거는 먼저 들어온 것을 남기므로, 위치 목록을 먼저
     담으면 같은 행사의 **날짜 없는** 사본이 남는다. 공짜로 얻은 기간 증거를
     그대로 버리고, 후보마다 상세조회를 한 건씩 써서 "작년에 끝났다"를 다시
     알아내게 된다. 이 순서가 뒤집히면 그 낭비가 조용히 되살아나므로 고정한다. */
  const festivalAppend = engine.indexOf("appendDiscoveryPage(running)");
  /* 위치 목록을 담는 자리. 인자 첫 줄이 `festivalSourceUsed`인 호출이다. */
  const listAppend = engine.search(
    /appendDiscoveryPage\(\s*\n\s*festivalSourceUsed/,
  );
  assert.ok(festivalAppend > 0, "행사 후보를 담는 자리가 없다");
  assert.ok(listAppend > 0, "위치 목록을 담는 자리가 없다");
  assert.ok(
    festivalAppend < listAppend,
    "행사를 위치 목록보다 먼저 담아야 날짜 있는 사본이 남는다",
  );

  /* 전용 조회가 성공했으면 위치 목록의 행사는 버린다 — 그쪽에는 기간이 없다.
     실패했을 때만 남겨 두어 상세조회 단계에서 날짜를 본다. */
  assert.match(engine, /FESTIVAL_CONTENT_TYPE_ID = "15"/);
  assert.match(
    engine,
    /festivalSourceUsed[\s\S]{0,220}?contenttypeid\) !== FESTIVAL_CONTENT_TYPE_ID/,
  );
  /* 이후 페이지에도 같은 규칙이 걸려야 한다. 한 곳만 걸면 2페이지부터 날짜 없는
     행사가 다시 들어온다. */
  const filterHits = engine.match(/!== FESTIVAL_CONTENT_TYPE_ID/g) ?? [];
  assert.equal(
    filterHits.length,
    2,
    "첫 페이지와 이후 페이지 두 곳 모두에서 걸러야 한다",
  );
});

test("행사 기간 판정은 목록 데이터만으로 하고 외부 조회를 더 쓰지 않는다", async () => {
  const { eventRunsOnDate, koreaCompactDateString } = await import(
    "../lib/kto/availability.ts"
  );

  const day = new Date("2026-08-19T02:00:00Z"); // KST 2026-08-19 11:00
  assert.equal(koreaCompactDateString(day), "20260819");

  /* 진행 중 */
  assert.deepEqual(
    eventRunsOnDate({ eventstartdate: "20260814", eventenddate: "20261211" }, day),
    { runs: true, start: 20260814, end: 20261211 },
  );
  /* 하루짜리 행사, 바로 그날 */
  assert.equal(
    eventRunsOnDate({ eventstartdate: "20260819", eventenddate: "20260819" }, day)
      ?.runs,
    true,
  );
  /* 이미 끝남 — 실측에서 이 형태가 대부분이었다 */
  assert.equal(
    eventRunsOnDate({ eventstartdate: "20250829", eventenddate: "20250831" }, day)
      ?.runs,
    false,
  );
  /* 아직 시작 안 함 */
  assert.equal(
    eventRunsOnDate({ eventstartdate: "20260912", eventenddate: "20260913" }, day)
      ?.runs,
    false,
  );

  /* 기간을 모르면 모른다고 한다. 모름을 "열린다"로 바꿔 적으면 끝난 행사가
     후보로 올라가고, "닫힌다"로 바꿔 적으면 멀쩡한 콘텐츠가 사라진다. */
  assert.equal(eventRunsOnDate({}, day), undefined);
  assert.equal(
    eventRunsOnDate({ eventstartdate: "20260814" }, day),
    undefined,
  );
  assert.equal(eventRunsOnDate({ eventenddate: "잘못된값" }, day), undefined);
});

test("열리지 않는 행사는 휴무와 다른 사유로 적는다", async () => {
  const types = await readFile(
    new URL("../lib/recovery/types.ts", import.meta.url),
    "utf8",
  );
  assert.match(types, /"EVENT_NOT_RUNNING"/);

  /* 세 화면과 정책 집계가 모두 이 사유를 사람 말로 옮길 수 있어야 한다.
     한 곳이라도 빠지면 여행자나 담당자가 코드값을 그대로 본다. */
  for (const [file, pattern] of [
    ["../app/DiscoverWindowPanel.tsx", /EVENT_NOT_RUNNING: \{/],
    ["../app/flow/FlowApp.tsx", /EVENT_NOT_RUNNING: \{/],
    ["../lib/insights/regional-gaps.ts", /EVENT_NOT_RUNNING: \{/],
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, pattern, `${file}에 사유 문구가 없다`);
  }

  /* 휴무 문구를 그대로 쓰지 않는다. "휴무"라고 적으면 여행자는 다른 날에 가면
     된다고 읽지만, 끝난 행사는 다시 열리지 않는다. */
  const discover = await readFile(
    new URL("../app/DiscoverWindowPanel.tsx", import.meta.url),
    "utf8",
  );
  const block = discover.slice(
    discover.indexOf("EVENT_NOT_RUNNING: {"),
    discover.indexOf("EVENT_NOT_RUNNING: {") + 200,
  );
  assert.ok(!/휴무|폐점/.test(block), "열리지 않는 행사를 휴무라고 적어서는 안 된다");
});

test("행사 요금 필드를 운영시간으로 읽지 않는다", async () => {
  /* `usetimefestival`은 이름과 달리 이용요금이다 — 2026-08-19 실측값 "무료".
     운영시간으로 읽으면 카드의 운영시간 자리에 요금이 적힌다. 행사의 실제
     운영시간은 `playtime`("11:00~22:00")이다. */
  const availability = await readFile(
    new URL("../lib/kto/availability.ts", import.meta.url),
    "utf8",
  );
  const hoursBlock = availability.slice(
    availability.indexOf("const OPERATING_HOURS_FIELDS"),
    availability.indexOf("const REST_DATE_FIELDS"),
  );
  assert.ok(
    !/usetimefestival/.test(hoursBlock),
    "요금 필드를 운영시간 목록에 두어서는 안 된다",
  );
  assert.match(hoursBlock, /"playtime"/);

  const feeBlock = availability.slice(
    availability.indexOf("fee: ["),
    availability.indexOf("fee: [") + 120,
  );
  assert.match(feeBlock, /usetimefestival/);
});
