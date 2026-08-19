import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 추천코스를 여행 일정으로 삼는 경로.
 *
 * 왜 두 갈래인가 — 2026-08-19 공사 API 실측:
 *   · 공식 추천코스(contentTypeId 25)는 16개 시·도 중 11곳에만 있고 전국 53건이다.
 *     서울·대전·울산·제주·세종은 **0건**이다.
 *   · 그 지역 여행자에게 "없습니다"만 돌려주면 기능이 아니다.
 *
 * 그래서 없는 지역에서는 그 지역의 **실제 공사 장소**로 하루 코스를 엮는다.
 * 형태는 공식 코스 22건을 측정해 배웠다: 지점 중앙값 7, 관광지↔식당 교차 패턴.
 * 거리는 배우지 않았다 — 공식 코스는 35~430km 광역 드라이브이고 1박2일·3박이상이
 * 흔해서, 그대로 흉내내면 "도시 안에서 다음 약속을 지킨다"는 이 앱의 상황에서
 * 쓸 수 없다. 그래서 12km 안으로 묶는다.
 *
 * 웹 검색으로 코스를 지어내지 않는다. 지점·좌표·운영시간이 모두 공사 데이터여야
 * 근거 원장에 남길 수 있고, 복구 엔진이 그대로 다시 쓸 수 있다. */

const KST = "+09:00";

function place(id, typeId, title, lat, lng) {
  return {
    contentid: id,
    contenttypeid: typeId,
    title,
    mapy: String(lat),
    mapx: String(lng),
    addr1: `${title} 주소`,
  };
}

test("공식 코스가 없는 지역은 실제 공사 장소로 엮되, 형태를 지킨다", async () => {
  const { assembleLocalCourse } = await import("../lib/course/plan.ts");

  /* 서울 종로 근처 좌표로 실측과 같은 밀도를 만든다. */
  const plan = assembleLocalCourse({
    sights: [
      place("1", "12", "와룡공원", 37.5912, 126.9902),
      place("2", "12", "북촌 8경", 37.5791, 126.9863),
      place("3", "12", "이화벽화마을", 37.5787, 127.0051),
    ],
    meals: [place("4", "39", "달 카페", 37.5838, 126.982)],
    regionName: "서울특별시",
    regionCode: "11",
    districtCode: "11110",
  });

  assert.ok(plan, "엮을 수 있는 장소가 있는데 코스를 만들지 못했다");
  assert.equal(plan.source, "assembled");
  assert.equal(plan.contentId, undefined, "우리가 엮은 코스에 공사 코스 ID를 붙여서는 안 된다");
  /* 실측 패턴: 관광지 → 식당 → 관광지. 식당이 두 번째 자리에 온다. */
  assert.equal(plan.stops[1].contentTypeId, "39");
  assert.ok(plan.stops.length >= 3);
  /* 같은 곳을 두 번 넣지 않는다. */
  const ids = plan.stops.map((stop) => stop.contentId);
  assert.equal(new Set(ids).size, ids.length);
});

test("멀리 떨어진 장소는 하루 코스에 넣지 않는다", async () => {
  const { assembleLocalCourse } = await import("../lib/course/plan.ts");

  /* 공식 코스는 35~430km를 넘나든다. 그것을 그대로 흉내내면 "지금 비어 있는
     시간에 다녀올 곳"이 아니라 1박2일 드라이브가 된다. */
  const plan = assembleLocalCourse({
    sights: [
      place("1", "12", "서울 기준점", 37.5665, 126.978),
      place("2", "12", "부산 태종대", 35.0537, 129.0857),
    ],
    meals: [place("3", "39", "부산 식당", 35.1, 129.03)],
    regionName: "서울특별시",
    regionCode: "11",
  });
  /* 기준점 하나만 남으므로 최소 두 곳을 못 채운다 — 억지로 엮지 않고 포기한다. */
  assert.equal(plan, undefined);
});

test("장소가 모자라면 코스를 지어내지 않는다", async () => {
  const { assembleLocalCourse } = await import("../lib/course/plan.ts");
  assert.equal(
    assembleLocalCourse({ sights: [], meals: [], regionName: "제주" }),
    undefined,
  );
  /* 좌표가 없는 항목은 장소로 세지 않는다. */
  assert.equal(
    assembleLocalCourse({
      sights: [{ contentid: "1", contenttypeid: "12", title: "좌표 없음" }],
      meals: [],
      regionName: "제주",
    }),
    undefined,
  );
});

test("코스 일정 노드는 등록 계약을 지킨다", async () => {
  const { courseItineraryNodes } = await import("../lib/course/plan.ts");

  const plan = {
    source: "official",
    contentId: "2765713",
    title: "부천 코스",
    regionCode: "41",
    districtCode: "41190",
    stops: [
      { contentId: "130527", contentTypeId: "14", title: "부천 물 박물관", latitude: 37.5073, longitude: 126.8193 },
      { contentId: "407030", contentTypeId: "39", title: "부천 식당", latitude: 37.5056, longitude: 126.8157 },
      { contentId: "407031", contentTypeId: "12", title: "부천식물원", latitude: 37.5056, longitude: 126.8157 },
    ],
  };
  const start = Date.parse(`2026-08-19T11:00:00${KST}`);
  const nodes = courseItineraryNodes(plan, start);

  assert.equal(nodes.length, 3);
  /* 노드 ID는 `[a-zA-Z0-9_-]`만 허용된다. 공사 contentid에 접두어를 붙여 쓴다. */
  for (const node of nodes) assert.match(node.id, /^[a-zA-Z0-9_-]{1,64}$/);
  /* ID와 순서는 서로 달라야 한다. */
  assert.equal(new Set(nodes.map((n) => n.id)).size, 3);
  assert.equal(new Set(nodes.map((n) => n.sequence)).size, 3);
  /* 시작 시각은 순서대로 **엄격히 증가**하고, 앞 일정이 끝난 뒤에 시작한다. */
  for (let i = 1; i < nodes.length; i += 1) {
    const previousEnd = Date.parse(nodes[i - 1].endAt);
    const currentStart = Date.parse(nodes[i].startAt);
    assert.ok(currentStart > Date.parse(nodes[i - 1].startAt));
    assert.ok(currentStart >= previousEnd, "앞 일정이 끝나기 전에 시작한다");
  }
  /* 오프셋이 있는 ISO만 계약이 받는다. */
  for (const node of nodes) {
    assert.match(node.startAt, /\+09:00$/);
    assert.match(node.endAt, /\+09:00$/);
  }
  /* 잠금 일정이 정확히 하나이고, 좌표를 가진다. 전부 잠그면 복구가 바꿀 수 있는
     곳이 없어져 "한 곳만 바꿔 약속을 지킨다"가 성립하지 않는다. */
  const locked = nodes.filter((node) => node.locked);
  assert.equal(locked.length, 1);
  assert.equal(locked[0].id, nodes[nodes.length - 1].id);
  assert.ok(locked[0].location.latitude && locked[0].location.longitude);
  /* 식당은 `meal`로 둔다 — 복구 엔진이 "식사 대신 식사"를 목적 유지로 읽는다. */
  assert.equal(nodes[1].type, "meal");
  assert.equal(nodes[0].type, "visit");
  /* 체류 시간은 계약 범위(10~720분) 안이어야 한다. */
  for (const node of nodes) {
    assert.ok(node.durationMinutes >= 10 && node.durationMinutes <= 720);
  }
});

test("화면은 두 출처를 섞어 적지 않는다", async () => {
  const wizard = await readFile(
    new URL("../app/plan/PlanWizard.tsx", import.meta.url),
    "utf8",
  );
  /* 공사가 만든 코스와 우리가 엮은 코스는 다른 물건이다. 그 차이를 화면이
     말하지 않으면 여행자는 둘 다 공사 코스로 읽는다. */
  assert.match(wizard, /공사 공식 추천코스/);
  assert.match(wizard, /이어가가 엮은 하루 코스/);
  assert.match(wizard, /공사 공식 추천코스가 아닙니다/);
  /* 지점별 체류 시간은 우리가 정한 값이라는 사실도 밝힌다. */
  /* 간격은 재서 정한 값이다 — 90분이면 복구가 0곳이고 120분이면 19곳이다. */
  assert.match(wizard, /공사가 제공하지 않아 이어가가 2시간 간격으로 잡았습니다/);
  assert.match(wizard, /const COURSE_STOP_GAP_MINUTES = 120;/);
  /* 빈 지역에서 코스를 지어내지 않는다고 적는다. */
  assert.match(wizard, /없는 코스를 만들어 드리지는 않습니다/);

  /* 단계 배열은 진행 표시와 뒤로가기 규칙이 함께 걸려 있어 건드리지 않았다. */
  assert.match(
    wizard,
    /const STEPS: Step\[\] = \["date", "start", "appointment", "confirm"\];/,
  );
});

test("코스 조회는 시·도 없이는 추측하지 않는다", async () => {
  const route = await readFile(
    new URL("../app/api/v1/courses/route.ts", import.meta.url),
    "utf8",
  );
  /* 행정구역이 조회 조건이다. 없으면 전국 검색이 되어 반경 밖 코스가 돌아온다. */
  assert.match(route, /REGION_REQUIRED/);
  /* 요청당 외부 조회 상한을 넘기지 않도록 지점 수를 제한하고, 잘랐다면 밝힌다. */
  assert.match(route, /MAX_RESOLVED_STOPS/);
  assert.match(route, /좌표를 확인했습니다/);
  /* 두 갈래를 상태로 구별해 돌려준다. */
  for (const status of ['"official"', '"assembled"', '"empty"']) {
    assert.ok(route.includes(status), `${status} 상태가 없다`);
  }
});

test("코스 미리보기는 동선 한 장과 지점 카드로 보여 준다", async () => {
  const preview = await readFile(
    new URL("../app/plan/CoursePreview.tsx", import.meta.url),
    "utf8",
  );

  /* "구봉산 → 오백돈 → 장태산…"처럼 이름을 화살표로 이은 한 줄로는 고를 수 없다.
     어디에 있고 몇 시에 여는지, 어떻게 가는지를 하나도 알 수 없기 때문이다. */
  assert.match(preview, /RouteMap/);
  assert.match(preview, /PlacePhoto/);
  assert.match(preview, /운영시간/);
  assert.match(preview, /앞 지점에서/);
  /* 첫 화면이 동선이므로 화면 수는 지점 수 + 1이다. */
  assert.match(preview, /total=\{stops\.length \+ 1\}/);
  /* 대안 목록과 같은 캐러셀을 쓴다 — 조작을 새로 배우지 않게 한다. */
  assert.match(preview, /OptionCarousel/);
  assert.match(preview, /perView=\{1\}/);

  /* 그려진 선을 실제 경로로 오해하지 않게 한다. 경로 조회는 복구 시점에 한다. */
  assert.match(preview, /실제 이동 경로가 아니며/);
  assert.match(preview, /직선거리 기준/);
  /* 운영시간이 없으면 없다고 적는다 — 빈칸과 "정보에 없다"는 다른 뜻이다. */
  assert.match(preview, /공사 정보에 없어요/);
});

test("코스 추천은 앞 단계에서 정한 위치로도 조회한다", async () => {
  const [wizard, picker] = await Promise.all([
    readFile(new URL("../app/plan/PlanWizard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ManualLocationPicker.tsx", import.meta.url), "utf8"),
  ]);

  /* 앞 단계에서 이미 위치를 정했으므로 이 화면에서 지역을 또 고르게 하지 않는다.
     버튼은 시·군·구 선택과 무관하게 눌릴 수 있어야 한다. */
  assert.match(picker, /disabled=\{courseBusy\}/);
  assert.doesNotMatch(picker, /disabled=\{!districtCode \|\| courseBusy\}/);

  /* 고른 값이 없으면 앞 단계의 행정구역으로 대신 조회한다. */
  assert.match(wizard, /area\.regionCode \|\| start\?\.areaCode/);
  assert.match(wizard, /area\.districtCode \|\| start\?\.sigunguCode/);
  /* 그 사실을 화면이 밝힌다. 조사는 저장소 도우미로 붙인다. */
  assert.match(wizard, /withParticle\(start\.title, "을\/를"\)/);
  /* 여행자 위치를 서버에 함께 보내 가장 가까운 곳을 기준점으로 삼게 한다. */
  assert.match(wizard, /latitude: start\?\.latitude/);
  /* 둘 다 없으면 추측하지 않고 시·도를 청한다. */
  assert.match(wizard, /코스를 추천하려면 시·도를 골라 주세요/);
});

test("코스는 여행자 위치에서 가장 가까운 곳을 기준점으로 삼는다", async () => {
  const { assembleLocalCourse } = await import("../lib/course/plan.ts");

  /* 같은 시·군·구 안이라도 목록의 첫 장소가 여행자에게서 멀 수 있다. 그때 첫
     장소를 기준으로 잡으면 "근처 하루 코스"가 거짓이 된다. */
  const plan = assembleLocalCourse({
    sights: [
      place("far", "12", "먼 곳", 37.70, 127.10),
      place("near", "12", "가까운 곳", 37.5670, 126.9785),
      place("mid", "12", "중간 곳", 37.5750, 126.9850),
    ],
    meals: [place("m", "39", "근처 식당", 37.5680, 126.9800)],
    regionName: "서울특별시",
    origin: { latitude: 37.5665, longitude: 126.978 },
    originLabel: "서울시청",
  });
  assert.ok(plan);
  assert.equal(plan.stops[0].contentId, "near", "가장 가까운 곳이 첫 지점이어야 한다");
  assert.equal(plan.title, "서울시청 근처 하루 코스");
  /* 구간 정보가 채워져 카드가 이동 수단을 말할 수 있다. */
  assert.equal(plan.stops[0].legMeters, undefined, "첫 지점에는 앞 구간이 없다");
  assert.ok(plan.stops[1].legMeters > 0);
  assert.ok(["walk", "transit", "car"].includes(plan.stops[1].legMode));
});

test("이동 수단은 직선거리로만 권한다", async () => {
  const { legModeFor } = await import("../lib/course/plan.ts");
  /* 경로 조회는 요청당 외부 조회 예산을 쓴다. 계획 단계에서 지점마다 쓸 값어치가
     없으므로 직선거리로 권하고, 그 사실을 화면이 밝힌다. */
  assert.equal(legModeFor(300), "walk");
  assert.equal(legModeFor(1_500), "walk");
  assert.equal(legModeFor(1_501), "transit");
  assert.equal(legModeFor(10_000), "transit");
  assert.equal(legModeFor(10_001), "car");
});

test("캐러셀의 끝 판정은 한 칸 폭을 기준으로 한다", async () => {
  const carousel = await readFile(
    new URL("../app/OptionCarousel.tsx", import.meta.url),
    "utf8",
  );
  /* 12px 고정값이던 시절, 끝에서 처음으로 즉시 옮기면 스크롤 스냅 보정으로
     `scrollLeft`가 21px에 앉았다. 12보다 크므로 "처음이 아니다"로 읽혀 왼쪽
     화살표가 마지막으로 넘어가지 못했다(실측). 한 칸 폭을 기준으로 재면 여백·
     소수점·스냅 보정을 함께 흡수한다. */
  assert.match(carousel, /const edgeTolerance = \(step: number\)/);
  assert.match(carousel, /Math\.max\(12, step \* 0\.4\)/);
  assert.doesNotMatch(carousel, /SCROLL_EDGE_TOLERANCE/);
});

test("검색으로 고른 장소도 행정구역 코드를 들고 온다", async () => {
  const picker = await readFile(
    new URL("../app/ManualLocationPicker.tsx", import.meta.url),
    "utf8",
  );
  /* 장소 검색 응답은 `regionCode`/`districtCode`로 준다(실측: 대전역 동광장
     regionCode "30", districtCode "30110"). 예전에는 `areaCode`/`sigunguCode`만
     읽어서 검색으로 고른 장소는 늘 행정구역이 없는 것으로 취급됐고, 코스 추천이
     시·도를 다시 물었다 — 코드는 응답에 처음부터 있었는데 이름이 달라 못 읽었다. */
  assert.match(picker, /typeof item\.regionCode === "string"/);
  assert.match(picker, /typeof item\.districtCode === "string"/);
  /* 시·군·구 직접 선택 경로는 우리가 만든 객체를 넘기고 그쪽은 areaCode를 쓰므로
     두 이름을 모두 받아야 한다. */
  assert.match(picker, /typeof item\.areaCode === "string"/);
});

test("코스가 하나뿐이면 다른 코스 보기를 두지 않는다", async () => {
  const [preview, wizard] = await Promise.all([
    readFile(new URL("../app/plan/CoursePreview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plan/PlanWizard.tsx", import.meta.url), "utf8"),
  ]);
  /* 돌아갈 목록이 없는데 버튼이 있으면 눌러도 같은 화면으로 돌아온다. */
  assert.match(preview, /\{canGoBack && \(/);
  assert.match(wizard, /canGoBack=\{courses\.length > 1\}/);
});

test("출발지는 코스 지점으로 다시 세지 않는다", async () => {
  const { assembleLocalCourse } = await import("../lib/course/plan.ts");

  /* 2026-08-19 실측 결함. 대전역 동광장을 출발지로 정하고 코스를 받으면, 그
     좌표에서 가장 가까운 장소가 대전역 동광장 자신이었다. 그것이 기준점이 되면서
     코스의 1번째 지점으로 올라가, 등록된 일정에 09:00 대전역 동광장과 18:00
     대전역 동광장이 나란히 들어갔다. 여행자는 이미 그곳에 있는데 두 시각에 두 번
     가라는 일정이 만들어진 것이다.

     원인은 한 값이 두 역할을 겸한 것이다 — 기준점("어디를 중심으로 찾을지")과
     지점("가야 할 곳"). 역할을 나눈다: 기준점으로는 계속 쓰고 목록에서만 뺀다. */
  /* 좌표는 실측값이다. 모두 대전역 동광장에서 12km(ASSEMBLED_MAX_SPAN_METERS)
     안에 둔다 — 반경 밖 후보를 섞으면 지점 수가 반경 때문에 줄어, 이 시험이
     보려는 것(출발지를 뺐다고 줄지는 않는다)을 가린다. */
  const origin = { latitude: 36.3342294989, longitude: 127.4362194451 };
  const sights = [
    place("1", "12", "대전역 동광장", 36.3342294989, 127.4362194451),
    place("2", "12", "식장산 문화공원", 36.3023172606, 127.4805721964),
    place("3", "12", "대청호", 36.3999, 127.4899),
    place("4", "12", "보문산공원", 36.2905, 127.4041),
  ];
  const meals = [place("9", "39", "평양숨두부", 36.3012086, 127.4567106)];

  const plan = assembleLocalCourse({
    sights,
    meals,
    regionName: "동구",
    origin,
    originLabel: "대전역 동광장",
  });

  assert.ok(plan);
  const titles = plan.stops.map((stop) => stop.title);
  assert.ok(
    !titles.includes("대전역 동광장"),
    `출발지가 지점으로 남았다: ${titles.join(" → ")}`,
  );

  /* 뺐다고 지점 수가 줄지 않는다 — 형태의 첫 칸부터 채우므로. 같은 자료로 출발지만
     주지 않은 경우와 나란히 두어 "줄지 않는다"를 눈에 보이게 잠근다. */
  const anonymous = assembleLocalCourse({ sights, meals, regionName: "동구" });
  assert.ok(anonymous);
  assert.equal(anonymous.stops[0].title, "대전역 동광장");
  assert.equal(plan.stops.length, anonymous.stops.length);

  /* 제목은 여전히 참이다. 그 근처에서 찾은 것은 사실이므로. */
  assert.match(plan.title, /대전역 동광장 근처/);
});

test("출발지를 주지 않으면 기준점을 그대로 첫 지점으로 쓴다", async () => {
  const { assembleLocalCourse } = await import("../lib/course/plan.ts");
  /* 코스만 받고 들어온 여행자에게는 첫 지점이 출발지가 된다. 그 경로를 위에서
     함께 망가뜨리지 않았음을 잠근다. */
  const plan = assembleLocalCourse({
    sights: [
      place("1", "12", "구봉산", 36.29, 127.35),
      place("2", "12", "장태산자연휴양림", 36.2295, 127.3327),
      place("3", "12", "평송청소년문화센터", 36.35, 127.38),
    ],
    meals: [place("9", "39", "오백돈", 36.3, 127.36)],
    regionName: "서구",
  });
  assert.ok(plan);
  assert.equal(plan.stops[0].title, "구봉산");
});

test("같은 곳 판별은 좁게 잡는다", async () => {
  const { isSameSpot, SAME_SPOT_METERS } = await import("../lib/geo.ts");

  /* 이름이 같으면 같은 곳이다 — 공사 자료는 같은 장소를 같은 콘텐츠로 준다. */
  assert.equal(
    isSameSpot(
      { title: "대전역 동광장", latitude: 36.3342, longitude: 127.4362 },
      { title: "대전역 동광장", latitude: 36.3345, longitude: 127.437 },
    ),
    true,
  );
  /* 이름이 갈려도 같은 자리면 같은 곳이다("대전역" vs "대전역 동광장"). */
  assert.equal(
    isSameSpot(
      { title: "대전역", latitude: 36.3342, longitude: 127.4362 },
      { title: "대전역 동광장", latitude: 36.33423, longitude: 127.43622 },
    ),
    true,
  );
  /* 넓히면 안 된다. 200m 떨어진 다른 식당까지 묶이면 멀쩡한 후보가 사라진다. */
  assert.equal(
    isSameSpot(
      { title: "평양숨두부", latitude: 36.3012, longitude: 127.4567 },
      { title: "다른 식당", latitude: 36.3030, longitude: 127.4567 },
    ),
    false,
  );
  assert.equal(SAME_SPOT_METERS, 60);
});

test("하루에 못 담은 지점을 말없이 버리지 않는다", async () => {
  const wizard = await readFile(
    new URL("../app/plan/PlanWizard.tsx", import.meta.url),
    "utf8",
  );
  /* 2026-08-19 15:50 KST 실측: 오늘 날짜로 4곳 코스를 등록하면 첫 지점이 18:00이
     되어 네 번째 지점(대청호)이 24:00을 넘겨 사라졌다. 화면은 "4곳"이라 했는데
     등록된 일정은 3곳이었고, 어디가 왜 빠졌는지는 어디에도 없었다. */
  assert.match(wizard, /\{ entries: PlanEntry\[\]; dropped: number \}/);
  assert.match(wizard, /dropped \+= 1;/);
  assert.match(wizard, /자정을 넘겨서 빼 두었습니다/);
  /* 오류 자리에 쓰지 않는다 — 붉은 글씨는 못 넘어간다는 뜻으로 읽힌다. */
  assert.match(wizard, /setPlanNote\(/);
  assert.match(wizard, /className=\{styles\.summaryNote\} role="status"/);
});

test("공식 코스에도 출발지 겹침 방어를 둔다", async () => {
  const wizard = await readFile(
    new URL("../app/plan/PlanWizard.tsx", import.meta.url),
    "utf8",
  );
  /* 엮은 코스는 서버가 기준점을 빼 주지만, 공사 공식 추천코스의 지점은 우리가
     고른 것이 아니어서 출발지와 겹칠 수 있다. 미리 보기에 들어오는 자리에서
     걸러야 "코스는 4곳인데 일정은 3개"가 되지 않는다. */
  assert.match(wizard, /function withoutOrigin\(/);
  assert.match(wizard, /!isSameSpot\(origin, stop\)/);
  assert.match(wizard, /coursePlanEntries\(\s*withoutOrigin\(stops\),/);
  /* 다 걸러져 빈 목록이 되면 빈 화면을 열지 않는다. */
  assert.match(wizard, /지금 출발지로 정한 곳과 같습니다/);
});

test("저장이 막힌 이유를 화면이 버리지 않는다", async () => {
  const wizard = await readFile(
    new URL("../app/plan/PlanWizard.tsx", import.meta.url),
    "utf8",
  );
  /* 실측: 같은 IP로 1분에 20번을 넘기면 서버는 429 `RATE_LIMITED`와 "일정 저장
     요청이 많습니다. 잠시 후 다시 시도해 주세요."를 돌려준다. 예전 화면은 요청
     ID만 붙이고 그 메시지를 버려서, 한도 초과든 계약 위반이든 똑같이 "일정을
     저장하지 못했습니다."만 떴다 — 여행자는 다시 눌러야 하는지 무엇을 고쳐야
     하는지 알 수 없었고, 신고를 받은 우리도 원인을 좁힐 수 없었다. */
  assert.match(wizard, /error\?: \{ code\?: string; message\?: string; requestId\?: string \}/);
  assert.match(wizard, /const detail = payload\?\.error\?\.message\?\.trim\(\);/);
  assert.match(wizard, /const code = payload\?\.error\?\.code\?\.trim\(\);/);
});
