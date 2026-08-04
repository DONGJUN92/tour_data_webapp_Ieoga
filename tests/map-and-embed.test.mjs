import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

test("경로 지도가 응답의 좌표열을 실제로 소비한다", async () => {
  const product = await src("../app/ProductApp.tsx");
  const discover = await src("../app/DiscoverWindowPanel.tsx");

  /* 엔진이 `routeGeometry`를 보내는데 화면 소비가 0건이었다. 여행자는 "몇 분"만
     보고 그 길이 어디로 가는지 알 수 없었다. */
  assert.match(product, /option\.routeGeometry/);
  assert.match(discover, /option\.routeGeometry/);
  assert.match(product, /<RouteMap/);
  assert.match(discover, /<RouteMap/);

  /* 외부 지도 라이브러리를 붙이지 않는다. 타일 제공자 약관·번들 크기·오프라인
     빈 화면이 모두 늘어난다. */
  const pkg = JSON.parse(await src("../package.json"));
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  for (const banned of ["leaflet", "mapbox-gl", "maplibre-gl", "ol"]) {
    assert.ok(!(banned in deps), `${banned} 의존성이 추가됐다`);
  }
});

test("경로 개요는 지도라고 단정하지 않고 축척을 주장하지 않는다", async () => {
  const map = await src("../app/RouteMap.tsx");
  /* 타일 배경이 없으므로 축척·방위를 보장할 수 없다. 보장하지 않는 것을
     보장하는 것처럼 보이면 그것도 과장이다. */
  assert.match(map, /축척·방위를 보장하는 지도가 아닙니다/);
  assert.match(map, /Not a scaled map/);
  /* 스크린리더는 선 그림을 읽을 수 없다. 문장 요약이 필수다. */
  assert.match(map, /role="img"/);
  assert.match(map, /aria-label=\{summary\}/);
});

test("경로 개요가 종횡비를 보정한다", async () => {
  const map = await src("../app/RouteMap.tsx");
  /* 보정을 빼면 한국 위도에서 동서가 약 20% 늘어나 길이 옆으로 퍼져 보인다. */
  assert.match(map, /Math\.cos\(\(midLat \* Math\.PI\) \/ 180\)/);
  assert.match(map, /lonScale/);
  /* 한 축만 늘리면 경로 모양이 찌그러진다. */
  assert.match(map, /Math\.min\(\s*\(VIEW_WIDTH/);
});

test("수단별 선 모양이 구분되고 애니메이션이 그 패턴을 덮지 않는다", async () => {
  const map = await src("../app/RouteMap.tsx");
  const css = await src("../app/RouteMap.module.css");
  assert.match(map, /MODE_STROKE/);
  assert.match(map, /strokeDasharray=\{MODE_STROKE\[mode\] \|\| undefined\}/);
  /* `stroke-dasharray`로 그려 나가는 연출을 넣으면 수단 구분 패턴을 덮어쓴다. */
  assert.ok(
    !/animation:\s*draw/.test(css),
    "선 그리기 애니메이션이 수단 구분 패턴을 덮어쓴다",
  );
});

test("임베드 위젯이 같은 복구 API를 호출하고 검증 기준을 낮추지 않는다", async () => {
  const widget = await src("../app/embed/recover/EmbedRecoverWidget.tsx");
  /* 별도 엔진을 만들면 "하나의 구현을 여러 증거로 전환"이라는 전제가 깨진다. */
  assert.match(widget, /"\/api\/v1\/recover"/);
  /* 축소판에서도 확인하지 못한 조건을 숨기지 않는다. */
  assert.match(widget, /confirmationRequired/);
  assert.match(widget, /evidenceGaps/);
  assert.match(widget, /출발 전 운영기관 안내를 확인해 주세요/);
  assert.match(widget, /없는 곳을 만들어 추천하지 않습니다/);
  /* 통과하지 못한 후보 수를 밝힌다. */
  assert.match(widget, /조건을 통과하지 못한 후보/);
  /* 경로 출처를 남긴다. */
  assert.match(widget, /attribution/);
});

test("임베드 위젯은 브라우저 좌표를 URL에 넣지 않는다", async () => {
  const widget = await src("../app/embed/recover/EmbedRecoverWidget.tsx");
  /* 본 화면과 같은 규칙: 소수점 다섯 자리로 줄여 POST 본문으로만 보낸다. */
  assert.match(widget, /toFixed\(5\)/);
  assert.match(widget, /"\/api\/v1\/location\/resolve"/);
  const resolveCall = widget.slice(widget.indexOf("location/resolve"));
  assert.match(resolveCall.slice(0, 400), /method: "POST"/);
});

test("파트너가 넘긴 좌표는 서버에서 검증한다", async () => {
  const page = await src("../app/embed/recover/page.tsx");
  /* 클라이언트 효과에서 window.location을 읽으면 서버 렌더와 결과가 갈려
     잘못된 좌표를 한 번 렌더한 뒤 고치는 순서가 된다. */
  assert.match(page, /searchParams/);
  assert.match(page, /function parseOrigin/);
  /* 한반도 범위를 벗어난 좌표는 좌표계 혼동의 신호다. */
  assert.match(page, /latitude < 32/);
  assert.match(page, /longitude > 132/);
  /* 행정구역 코드도 형식을 검사한다. */
  assert.match(page, /\^\\d\{5\}\$/);
  const widget = await src("../app/embed/recover/EmbedRecoverWidget.tsx");
  assert.ok(
    !/window\.location\.search/.test(widget),
    "위젯이 여전히 클라이언트에서 URL을 읽는다",
  );
});

test("임베드 데모가 가상의 파트너임을 명시한다", async () => {
  const demo = await src("../app/embed/demo/page.tsx");
  /* 실제 사업자 이름을 쓰면 제휴가 있는 것처럼 읽히고, 기획 15.7의 "협력의향을
     계약처럼 표현하지 않는다"에 어긋난다. */
  assert.match(demo, /실제로 존재하지 않는 가상의 숙박 사업자/);
  assert.match(demo, /제휴 관계가 있음을 뜻하지 않습니다/);
  assert.match(demo, /심사용 모사 화면/);
  assert.match(demo, /<iframe/);
  /* 삽입 코드가 있어야 파트너가 실제로 쓸 수 있다. */
  assert.match(demo, /삽입 코드/);
  /* 파트너 화면은 검색에 잡히지 않게 한다. */
  assert.match(demo, /robots: \{ index: false/);
});

test("단계가 바뀌면 포커스가 그 단계 제목으로 이동한다", async () => {
  const flow = await src("../app/flow/FlowApp.tsx");
  /* 예전에는 화면이 통째로 바뀌어도 포커스가 body에 남아, 스크린리더 사용자는
     무엇이 바뀌었는지 듣지 못하고 키보드 사용자는 Tab을 처음부터 다시 눌러야
     했다. `/accessibility`가 "상태·오류 실시간 안내"를 명시 목표로 걸었으므로
     자기 선언 위반이기도 했다. */
  assert.match(flow, /stepHeadingRef/);
  assert.match(flow, /heading\.focus\(/);
  /* 제목은 프로그램으로만 포커스를 받고 Tab 순서에는 끼지 않는다. */
  assert.match(flow, /ref=\{stepHeadingRef\} tabIndex=\{-1\}/);
  /* 단계 변경에 반응해야 한다. */
  const effect = flow.slice(flow.indexOf("const stepHeadingRef"));
  assert.match(effect.slice(0, 800), /\}, \[step\]\)/);

  const css = await src("../app/flow/flow.module.css");
  /* 포커스 링이 없으면 이동을 눈으로 확인할 수 없고, 기본 링이 남으면 마우스
     사용자에게 느닷없는 테두리로 보인다. */
  assert.match(css, /\.title:focus-visible/);
});
