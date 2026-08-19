import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 유형마다 `detailIntro2`가 다른 것을 준다. 이름만 보고 매핑하면 카드가 거짓을
   적는다 — 행사(15)의 `usetimefestival`이 요금이었던 것과 같은 함정이 둘 더
   있었다.
 *
 * 2026-08-19 공사 API 실측:
 *  - 숙박(32) 더 플라자 호텔 서울: `checkintime: "15:00"`, `checkouttime: "11:00"`.
 *    운영시간 필드는 하나도 없다. 그런데 `checkintime`을 운영시간으로 읽고 있어
 *    카드에 "운영시간 15:00"이 찍혔고, `placeFacts`가 같은 값이라며 입실 사실을
 *    버렸으며, `"15:00"`에는 구간이 없어 판정이 영원히 대조 불가에 머물렀다.
 *  - 추천코스(25) "상상 그 이상의 판타지아! 부천으로 고고씽~": 값이 있는 필드가
 *    `distance: "11.69km"`, `schedule: "기타"`, `taketime: "7시간"`, `theme` 넷뿐.
 *    운영시간·휴무가 아예 없고, 7시간짜리 코스를 우리는 30분 체류로 계획했다. */

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

test("숙박의 입실 시각을 운영시간으로 읽지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );

  /* 실표본 그대로. */
  const evidence = evaluateAvailabilityItem(
    {
      contenttypeid: "32",
      checkintime: "15:00",
      checkouttime: "11:00",
      infocenterlodging: "02-771-2200",
      parkinglodging: "가능",
    },
    audit,
  );

  /* 호텔은 15시에 문을 여는 곳이 아니다. */
  assert.equal(
    evidence.operatingHours,
    undefined,
    "입실 시각이 운영시간 자리에 들어가면 카드가 거짓을 적는다",
  );
  /* 정작 필요한 값이 살아 있어야 한다 — 예전에는 운영시간과 같은 값이라며
     버려졌다. */
  assert.equal(evidence.placeFacts?.checkIn, "15:00");
  assert.equal(evidence.placeFacts?.checkOut, "11:00");
  /* 전화번호는 유형별 필드에서 제대로 읽는다. */
  assert.equal(evidence.contact, "02-771-2200");
  /* 운영 판정은 미확인으로 남는다. 그것이 사실이고, 여행자는 직접 확인해서
     고를 수 있다. 없는 운영시간을 지어내지 않는다. */
  assert.equal(evidence.status, "unknown");
});

test("추천코스의 공식 소요시간과 길이를 사실로 싣는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );

  const evidence = evaluateAvailabilityItem(
    {
      contenttypeid: "25",
      taketime: "7시간",
      distance: "11.69km",
      schedule: "기타",
    },
    audit,
  );

  assert.equal(evidence.placeFacts?.courseDuration, "7시간");
  assert.equal(evidence.placeFacts?.courseDistance, "11.69km");
  /* 코스에는 운영시간이 없다. 없는 것을 있다고 하지 않는다. */
  assert.equal(evidence.operatingHours, undefined);
  assert.equal(evidence.status, "unknown");
});

test("코스 고유 필드는 다른 유형에서 읽지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );

  /* `distance`라는 이름은 다른 유형에서 다른 뜻일 수 있다. 그때 "코스 길이"라고
     적으면 거짓이 된다. 유형을 확인하고 읽는다. */
  const evidence = evaluateAvailabilityItem(
    { contenttypeid: "12", usetime: "09:00~18:00", distance: "3km", taketime: "1시간" },
    audit,
  );
  assert.equal(evidence.placeFacts?.courseDuration, undefined);
  assert.equal(evidence.placeFacts?.courseDistance, undefined);
  assert.equal(evidence.operatingHours, "09:00~18:00");
});

test("코스 카드는 계획한 시간이 코스 전체가 아님을 밝힌다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );

  /* 계산은 틀리지 않았다 — "N분 머물고 약속에 늦지 않는다"는 참이다. 틀린 것은
     읽히는 방식이었다. 7시간 코스를 30분 계획으로 제시하면서 그 차이를 적지
     않으면 여행자는 완주 계획으로 읽는다. */
  assert.match(engine, /courseDuration/);
  assert.match(engine, /코스 전체가 아니라 시작 지점 주변을 둘러보는 시간/);
  /* 경로도 시작 지점 하나로만 계산한다는 사실을 함께 밝힌다. */
  assert.match(engine, /코스의 시작 지점 좌표로 계산했습니다/);
  /* 카드에 공식 규모를 싣는 자리도 있어야 한다. */
  assert.match(engine, /code: "course_scale"/);

  const types = await readFile(
    new URL("../lib/recovery/types.ts", import.meta.url),
    "utf8",
  );
  assert.match(types, /"course_scale"/);
});

test("운영시간 필드 목록에 다른 뜻의 필드가 다시 들어오지 않는다", async () => {
  const availability = await readFile(
    new URL("../lib/kto/availability.ts", import.meta.url),
    "utf8",
  );
  /* 배열 본문만 본다. 무엇을 왜 뺐는지 적어 둔 주석에 그 이름이 나오는 것은
     되살아난 것이 아니라 기록이다. */
  const start = availability.indexOf("const OPERATING_HOURS_FIELDS = [");
  const hoursBlock = availability.slice(
    start,
    availability.indexOf("] as const;", start),
  );

  /* 이름이 시간처럼 생겼지만 뜻이 다른 필드들. 한 번씩 다 들어왔다가 카드에
     거짓을 적게 만들었다. */
  for (const trap of ["usetimefestival", "checkintime", "checkouttime", "taketime"]) {
    assert.ok(
      !hoursBlock.includes(trap),
      `${trap}은(는) 운영시간이 아니다`,
    );
  }
  /* 진짜 운영시간 필드는 남아 있어야 한다. */
  for (const real of ["usetime", "usetimeculture", "opentimefood", "playtime"]) {
    assert.ok(hoursBlock.includes(real), `${real}이(가) 빠졌다`);
  }
});
