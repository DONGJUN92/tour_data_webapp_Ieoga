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
  assert.match(wizard, /function back\(\) \{/);
  assert.match(wizard, /role="progressbar"/);
  /* DB 원문은 노출하지 않고 공개 request id로 운영 로그와 연결한다. */
  assert.doesNotMatch(wizard, /payload\.error\?\.cause/);
  assert.match(wizard, /response\.headers\.get\("x-request-id"\)/);
  /* 약속 시각은 30분 단위. 여행자는 분 단위로 계획하지 않는다. */
  assert.match(wizard, /HALF_HOUR_TIMES/);
});

test("여행지를 원하는 만큼 이어 붙일 수 있다", async () => {
  const wizard = await src("../app/plan/PlanWizard.tsx");
  /* 약속 하나로 끝나지 않는다. */
  assert.match(wizard, /place: ManualPlace; time: string; locked: boolean/);
  assert.match(wizard, /일정 검토하기/);
  assert.match(wizard, /번째로 갈 곳이 있나요/);

  /* 고른 곳과 시각은 **검색창보다 위에** 둔다. 아래에 두었더니 장소를 고른
     뒤에도 화면 끝에 가려 다음에 무엇을 할지 보이지 않았다. */
  assert.ok(
    wizard.indexOf("몇 시 약속인가요") < wizard.indexOf("setPending(place);"),
    "시각 블록이 다시 검색창 아래로 내려갔다",
  );

  /* 잠금은 담을 때 고른다. 마지막을 자동으로 잠갔더니 마지막 여행지가
     예약이 아닌 경우에도 복구가 손댈 수 없는 곳이 되었다. */
  assert.match(wizard, /locked: entry\.locked,/);
  assert.match(wizard, /이 일정은 못 바꿔요/);
  assert.ok(
    !/const last = entryIndex === plan\.length - 1;/.test(wizard),
    "마지막을 자동으로 잠그는 규칙이 되살아났다",
  );
  /* 기본값은 켜 둔다 — 잠긴 곳이 하나도 없으면 이 앱이 지킬 대상이 없다. */
  assert.match(wizard, /useState\(true\);/);
});

test("뒤로 가기는 한 걸음씩 되돌린다", async () => {
  const wizard = await src("../app/plan/PlanWizard.tsx");
  /* 단계 전체를 비웠더니, 세 번째 여행지를 넣다가 뒤로 갔을 때 출발지가
     통째로 사라지고 담아 둔 목록만 남았다 — 화면에 1번이 없고 2번만 남았다. */
  assert.match(wizard, /setPlan\(\(previous\) => previous\.slice\(0, -1\)\);/);
  assert.ok(
    !/if \(target === "appointment"\) setPlan\(\[\]\);/.test(wizard),
    "뒤로 가기가 다시 담은 목록을 통째로 비운다",
  );
  /* 담는 중이던 것이 먼저 취소된다. */
  assert.match(wizard, /if \(pending\) \{[\s\S]{0,120}?return;/);
  /* 앞 단계의 답을 유지해야 뒤로 갔다 다시 와도 출발지를 재검색하지 않는다. */
  assert.doesNotMatch(wizard, /setStart\(null\)/);
  assert.match(wizard, /setStep\(target\);/);
});

test("여행지 번호가 목록과 제목에서 어긋나지 않는다", async () => {
  const wizard = await src("../app/plan/PlanWizard.tsx");
  /* 1번은 출발지이므로 `plan[0]`이 이미 2번이다. `+1`이면 목록에 2번이
     보이는데 제목은 `2번째로 갈 곳`이라고 물었다. */
  assert.match(wizard, /\$\{plan\.length \+ 2\}번째로 갈 곳이 있나요\?/);
  assert.match(wizard, /<span>\{entryIndex \+ 2\}<\/span>/);
  assert.ok(
    !/\$\{plan\.length \+ 1\}번째로/.test(wizard),
    "제목 번호가 다시 목록보다 하나 작아졌다",
  );

  /* 실제 번호를 재현한다: 담은 것이 1개면 다음은 3번째다. */
  const heading = (count) => count + 2;
  const listNumber = (index) => index + 2;
  assert.equal(listNumber(0), 2);
  assert.equal(heading(1), 3, "2번을 담았으면 다음은 3번이다");
  assert.equal(heading(0), 2);
});

test("화면에서 숨기는 텍스트가 실제로 숨겨진다", async () => {
  const css = await src("../app/globals.css");
  /* 이 클래스가 없어서 뒤로가기 버튼의 `처음으로`가 44px 원 안에 그대로
     그려졌고, 글자가 세로로 한 줄씩 흘러 화면이 깨졌다. */
  assert.match(css, /\.sr-only \{[\s\S]*?clip: rect\(0, 0, 0, 0\);/);
});

test("고르개 문구가 그 화면이 묻는 것과 맞는다", async () => {
  const picker = await src("../app/ManualLocationPicker.tsx");
  /* 이 고르개는 세 자리에서 쓴다: 지금 있는 곳, 출발지, 지켜야 할 약속.
     문구를 `현재 장소`로 고정해 두었더니 약속을 고르는 화면에도 `현재 장소
     직접 입력`이 떴다 — 무엇을 묻는지가 화면마다 다른데 안내가 하나였다. */
  assert.match(picker, /heading\?: string;/);
  assert.match(picker, /areaHint\?: string;/);
  assert.match(picker, /heading \?\? tr\("현재 장소 직접 입력"/);

  const wizard = await src("../app/plan/PlanWizard.tsx");
  assert.match(wizard, /heading=\{tr\("출발지 찾기"/);
  assert.equal((wizard.match(/purpose="saved_stop"/g) ?? []).length, 2);
  assert.match(wizard, /"약속 장소 찾기"/);
  assert.match(wizard, /"갈 곳 찾기"/);
  /* 마법사 어디에도 `현재 장소`가 남으면 안 된다. */
  assert.ok(
    !/현재 장소/.test(wizard),
    "일정 등록 화면에 다시 `현재 장소` 문구가 들어왔다",
  );

  /* 실제로 현재 위치를 묻는 두 화면은 기본 문구를 그대로 쓴다. */
  for (const rel of ["../app/ProductApp.tsx", "../app/DiscoverWindowPanel.tsx"]) {
    const source = await src(rel);
    assert.ok(
      !/heading="/.test(source.slice(source.indexOf("<ManualLocationPicker"))),
      `${rel}는 현재 위치를 묻는 자리라 기본 문구를 써야 한다`,
    );
  }
});
