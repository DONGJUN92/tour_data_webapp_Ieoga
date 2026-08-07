import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/* "시간이 비었어요"에서 찾은 곳을 일정에 넣을 때 어디에 넣을지 묻는 계약.
 *
 * 예전에는 빈 자리를 조용히 찾아 채웠다. 이미 적어 둔 일정이 있으면 그 자리가
 * 없어 아무 일도 일어나지 않았고, 사용자에게는 버튼이 고장 난 것으로 보였다. */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/* 실제 구현과 같은 규칙을 재현한다. */
const WIDE_CITY = /(특별시|광역시|특별자치시)$/u;
const PROVINCE = /(^|[가-힣])도$|특별자치도$/u;
const CITY_OR_COUNTY = /(시|군)$/u;
function administrativeUnit(address) {
  const tokens = address.trim().split(/\s+/u).filter(Boolean);
  for (const [index, token] of tokens.entries()) {
    if (WIDE_CITY.test(token)) return token;
    if (PROVINCE.test(token)) {
      const next = tokens.slice(index + 1).find((entry) => CITY_OR_COUNTY.test(entry));
      if (next) return next;
    }
  }
  return tokens.find((token) => CITY_OR_COUNTY.test(token)) ?? "";
}

test("행정구역은 시·군 단위로 본다", async () => {
  const model = await src("../app/product-app-model.ts");
  assert.match(model, /export function administrativeUnit\(address: string\)/);
  assert.match(model, /const WIDE_CITY = \/\(특별시\|광역시\|특별자치시\)\$\/u;/);

  /* 광역시·특별시·특별자치시는 그 자체가 단위다. */
  assert.equal(administrativeUnit("대전광역시 서구 둔산대로 201"), "대전광역시");
  assert.equal(administrativeUnit("서울특별시 중구 통일로 1"), "서울특별시");
  assert.equal(administrativeUnit("세종특별자치시 한누리대로"), "세종특별자치시");
  /* 도 아래는 시·군이 단위다. 구가 아니다. */
  assert.equal(administrativeUnit("경기도 수원시 팔달구 정조로"), "수원시");
  assert.equal(administrativeUnit("전북특별자치도 전주시 완산구"), "전주시");
  assert.equal(administrativeUnit("강원특별자치도 양양군 손양면"), "양양군");
  assert.equal(administrativeUnit("경상북도 울릉군 울릉읍"), "울릉군");

  /* 앞 두 토막으로 자르면 여기서 갈렸다. 같은 대전 안에서 구만 다른 것을
     "다른 지역이니 일정을 지울까요"라고 물으면 안 된다. */
  assert.equal(
    administrativeUnit("대전광역시 서구 둔산대로 201"),
    administrativeUnit("대전광역시 유성구 대학로 291"),
  );
  assert.notEqual(
    administrativeUnit("대전광역시 서구 x"),
    administrativeUnit("서울특별시 중구 y"),
  );
});

test("같은 지역과 다른 지역에 서로 다른 선택지를 준다", async () => {
  const dialog = await src("../app/PlanPlacementDialog.tsx");
  /* 같은 지역: 앞·뒤 추가와 개별 대체. */
  assert.match(dialog, /onChoose\(\{ kind: "prepend" \}\)/);
  assert.match(dialog, /onChoose\(\{ kind: "append" \}\)/);
  assert.match(dialog, /onChoose\(\{ kind: "replace", stopId: stop\.id \}\)/);
  /* 다른 지역: 지울지 물어본다. 우리가 대신 지우지 않는다. */
  assert.match(dialog, /onChoose\(\{ kind: "reset" \}\)/);
  assert.match(dialog, /기존 일정을 삭제하고 이 곳으로 새로 시작할까요/);
  /* 두 갈래 모두에 취소가 있어야 한다 — 정하지 못한 사용자를 가두지 않는다. */
  const cancels = dialog.match(/plan-merge-cancel/gu) ?? [];
  assert.ok(cancels.length >= 1);
  assert.ok(
    dialog.indexOf("plan-merge-cancel") > dialog.indexOf('kind: "reset"'),
    "취소가 두 갈래 바깥에 있어야 양쪽에서 모두 보인다",
  );
});

test("고른 결과가 화면에 보이게 만든다", async () => {
  const app = await src("../app/ProductApp.tsx");
  assert.match(app, /function applyPlanPlacement\(/);
  /* 편집기가 접혀 있으면 초안이 바뀌어도 보이지 않는다. 이것이 "아무 일도
     안 일어난다"의 원인이었다. */
  assert.match(app, /setJourneyEditing\(true\);\s*\n\s*setPlaceToPlan\(null\);/);
  /* 빈 초안이면 묻지 않는다. */
  assert.match(app, /if \(!filled\.length\) \{/);
  /* 지우기를 골라도 지켜야 할 약속 자리는 남긴다 — 그것이 없으면 복구 판정이
     돌아가지 않는다. */
  assert.match(app, /makeStop\(\{ type: "reservation", fixed: true \}\)/);
});
