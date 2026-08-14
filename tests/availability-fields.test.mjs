import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

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

/* 2026-08-04 부산·서울 실표본에서 확인한 유형별 필드 이름. 공통
   `usetime`/`restdate`만 읽던 구현은 문화시설·레포츠의 값이 있는데도 "운영시간
   항목이 비어 있음"으로 판정하고, 그 후보를 확인 요구 없이 제시했다. */
const SAMPLES = [
  {
    label: "관광지(12)",
    item: { usetime: "09:00~18:00", restdate: "연중무휴" },
  },
  {
    label: "문화시설(14)",
    item: {
      usetimeculture: "화요일~일요일 10:00~18:30",
      restdateculture: "매주 월요일",
      infocenterculture: "02-2020-1880",
    },
  },
  {
    label: "레포츠(28)",
    item: { usetimeleports: "09:00~22:00", restdateleports: "매주 월요일" },
  },
  {
    label: "쇼핑(38)",
    item: { opentime: "10:00~21:00", restdateshopping: "연중무휴" },
  },
  {
    label: "음식점(39)",
    item: { opentimefood: "07:30~23:00", restdatefood: "연중무휴" },
  },
  { label: "행사(15)", item: { playtime: "18:00~23:00" } },
  { label: "숙박(32)", item: { checkintime: "15:00" } },
];

test("유형별 운영시간 필드를 모두 읽어 '정보 없음'으로 오판하지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  for (const sample of SAMPLES) {
    const evidence = evaluateAvailabilityItem(sample.item, audit);
    assert.notEqual(
      evidence.status,
      "unknown",
      `${sample.label}: 공식 응답에 운영시간이 있는데 unknown으로 판정했다`,
    );
    assert.ok(
      evidence.operatingHours,
      `${sample.label}: 운영시간 문자열을 읽지 못했다`,
    );
  }
});

test("행사의 usetimefestival은 이용요금이므로 운영시간으로 읽지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  /* 실표본에서 `usetimefestival`의 값은 "무료"였다. 이것을 운영시간으로 읽으면
     화면의 운영시간 자리에 요금이 들어간다. */
  const evidence = evaluateAvailabilityItem(
    { usetimefestival: "무료" },
    audit,
  );
  assert.equal(evidence.status, "unknown");
  assert.equal(evidence.operatingHours, undefined);
});

test("문화시설 휴관일이 방문일과 겹치면 운영 불가로 판정한다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  /* 2026-08-03은 월요일이다. `restdateculture`를 읽지 못하던 구현은 이 표본을
     unknown으로 흘려보내 휴관일 후보를 확인 요구 없이 제시했다. */
  const monday = new Date("2026-08-03T05:00:00Z");
  const evidence = evaluateAvailabilityItem(
    {
      usetimeculture: "화요일~일요일 10:00~18:30",
      restdateculture: "매주 월요일 / 1월 1일",
    },
    audit,
    monday,
    monday,
  );
  assert.equal(evidence.status, "confirmed_closed");
  assert.match(evidence.note, /휴무/);
});

test("상시 개방·연중무휴 공식 표기는 체류 구간 전체의 운영 확인으로 인정한다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  const startAt = new Date("2026-08-09T10:00:00+09:00");
  const endAt = new Date("2026-08-09T12:00:00+09:00");
  const evidence = evaluateAvailabilityItem(
    { usetime: "상시 개방", restdate: "연중무휴" },
    audit,
    startAt,
    endAt,
  );
  assert.equal(evidence.status, "confirmed_open");
});

test("자정을 넘는 체류는 일반 시간표로 확정하지 않고 24시간·연중무휴일 때만 운영 확인한다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  const startAt = new Date("2026-08-09T23:30:00+09:00");
  const endAt = new Date("2026-08-10T00:30:00+09:00");

  const singleDateHours = evaluateAvailabilityItem(
    {
      usetimeculture: "00:00~23:59",
      restdateculture: "연중무휴",
    },
    audit,
    startAt,
    endAt,
  );
  assert.equal(singleDateHours.status, "official_hours_unstructured");

  const alwaysOpen = evaluateAvailabilityItem(
    {
      usetimeculture: "24시간",
      restdateculture: "연중무휴",
    },
    audit,
    startAt,
    endAt,
  );
  assert.equal(alwaysOpen.status, "confirmed_open");
});

test("상시 개방이어도 체류가 자정을 넘어 공식 휴무일과 겹치면 실패 폐쇄한다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  const evidence = evaluateAvailabilityItem(
    { usetime: "상시 개방", restdate: "매주 월요일 휴무" },
    audit,
    new Date("2026-08-09T23:30:00+09:00"),
    new Date("2026-08-10T00:30:00+09:00"),
  );
  assert.equal(evidence.status, "confirmed_closed");
  assert.match(evidence.note, /체류 구간/);
});

test("원장에 적는 필드 목록이 실제로 읽는 필드를 포함한다", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../lib/kto/adapters.ts", import.meta.url), "utf8"),
  );
  const intro = source.slice(source.indexOf('"detailIntro2"'));
  for (const field of [
    "usetimeculture",
    "restdateculture",
    "usetimeleports",
    "restdateleports",
    "playtime",
  ]) {
    assert.ok(
      intro.includes(`"${field}"`),
      `기여 원장의 fieldsUsed에 ${field}가 없다`,
    );
  }
  /* 원장은 이제 `usetimefestival`도 적는다 — 행사의 **이용요금**으로 읽기
     때문이고, 원장은 읽은 것을 전부 적어야 한다. 지켜야 할 것은 원장의 목록이
     아니라 그 필드를 **운영시간으로 읽지 않는다**는 사실이므로, 판정이 실제로
     쓰는 목록에서 확인한다. 이름과 달리 값이 요금 문자열("무료")이라 운영시간
     자리에 들어가면 그대로 시간표인 척한다. */
  const availability = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../lib/kto/availability.ts", import.meta.url), "utf8"),
  );
  const hoursList = availability.slice(
    availability.indexOf("const OPERATING_HOURS_FIELDS"),
    availability.indexOf("const REST_DATE_FIELDS"),
  );
  assert.ok(
    !hoursList.includes('"usetimefestival"'),
    "이용요금 필드를 운영시간 판정에 써서는 안 된다",
  );
  const feeList = availability.slice(
    availability.indexOf("  fee: ["),
    availability.indexOf("  reservation: ["),
  );
  assert.ok(
    !feeList.includes('"usetimeleports"'),
    "레포츠 운영시간 필드를 이용요금으로 읽어서는 안 된다",
  );
});
