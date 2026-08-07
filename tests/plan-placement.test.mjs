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

test("출발지 자리는 어느 경로로도 빼앗기지 않는다", async () => {
  const app = await src("../app/ProductApp.tsx");
  /* `[fresh(), ...stops]`로 넣었더니 고른 여행지가 1번을 차지하고 출발지가
     뒤로 밀렸다. 1번은 출발지이고, 거기에 여행지가 들어가면 "지금 있는 곳에서
     출발한다"는 전제가 깨져 이동 시간이 0으로 잡힌다. */
  assert.ok(
    !/\[fresh\(\), \.\.\.previous\.stops\]/.test(app),
    "prepend가 다시 출발지보다 앞에 넣는다",
  );
  assert.match(app, /const afterOrigin = previous\.stops\.length \? 1 : 0;/);

  /* 빈 초안에서도 1번은 현재 위치다. */
  assert.match(app, /title: originLabel \|\| "지금 있는 곳"/);

  /* "대신 넣기" 목록에서도 출발지는 빠진다. */
  assert.match(app, /stops=\{journeyDraft\.stops\.slice\(1\)\.map/);
  /* 다만 지역 판정에는 출발지도 넣는다 — 출발지가 대전이면 대전 대안은 같은
     지역이다. */
  assert.match(app, /areaStops=\{journeyDraft\.stops\.map/);

  const insert = (stops, kind) => {
    const next = [...stops];
    next.splice(kind === "prepend" ? (stops.length ? 1 : 0) : next.length, 0, "고른곳");
    return next;
  };
  assert.deepEqual(insert(["출발지", "약속"], "prepend"), ["출발지", "고른곳", "약속"]);
  assert.deepEqual(insert(["출발지", "약속"], "append"), ["출발지", "약속", "고른곳"]);
  assert.deepEqual(insert([], "prepend"), ["고른곳"]);
});

test("랜딩은 로고와 버튼 셋만 두고, 직행 링크는 건너뛴다", async () => {
  const landing = await src("../app/page.tsx");
  /* 설명 문구를 붙이기 시작하면 랜딩이 아니라 소개 페이지가 된다. 이 화면을
     보는 사람은 읽으러 온 것이 아니라 다음 행동을 고르러 왔다. */
  assert.match(landing, /지금 어떤 상황인가요\?/);
  for (const [href, label] of [
    ["/app", "일정이 틀어졌어요"],
    [String.raw`/app\?view=discover`, "시간이 비었어요"],
    ["/plan", "여행 일정을 등록할래요"],
  ]) {
    assert.match(landing, new RegExp(href));
    assert.match(landing, new RegExp(label));
  }
  /* 앱 본체는 `/app`으로 옮겼다. `/`가 곧 앱이면 처음 온 사람이 이 앱이 뭘
     해 주는지 알기 전에 일정 입력 폼부터 읽어야 한다. */
  const appPage = await src("../app/app/page.tsx");
  assert.match(appPage, /import \{ ProductApp \}/);
  assert.ok(
    !/ProductApp/.test(landing),
    "랜딩이 다시 앱 본체를 띄운다",
  );
});

test("일정 등록은 한 화면에 한 질문만 묻는다", async () => {
  const wizard = await src("../app/plan/PlanWizard.tsx");
  assert.match(wizard, /const STEPS: Step\[\] = \["date", "start", "appointment", "confirm"\];/);
  /* 언제든 뒤로 갈 수 있어야 한다. 되돌릴 수 없는 마법사는 폼보다 나쁘다. */
  assert.match(wizard, /const back = \(\) => \{/);
  assert.match(wizard, /role="progressbar"/);
  /* 저장 실패는 삼키지 않는다 — 서버가 실어 보낸 원인까지 보여 준다. */
  assert.match(wizard, /payload\.error\?\.cause/);
  /* 약속 시각은 30분 단위. 여행자는 분 단위로 계획하지 않는다. */
  assert.match(wizard, /HALF_HOUR_TIMES/);
});
