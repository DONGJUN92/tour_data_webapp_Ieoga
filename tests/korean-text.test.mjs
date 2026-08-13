import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const { particleFor, withParticle, quotedWithParticle } = await import(
  "../lib/text/korean.ts"
);
const { statusLabel, isMappedStatus, sourceLabelText } = await import(
  "../lib/text/status-labels.ts"
);
const { parseBranchQuery, branchAffinity, matchesBase } = await import(
  "../lib/location/branch-query.ts"
);
const {
  containsInternalKtoName,
  sanitizeTravelerText,
  travelerErrorText,
  travelerSourceLabel,
} = await import("../lib/text/traveler-facing.ts");

const source = (relative) =>
  readFile(new URL(relative, `file://${ROOT}`), "utf8");

test("조사는 받침을 실제로 계산해서 고른다", () => {
  // 받침 있음 / 없음
  assert.equal(withParticle("성심당", "을/를"), "성심당을");
  assert.equal(withParticle("화폐박물관", "을/를"), "화폐박물관을");
  assert.equal(withParticle("녹원간장게장", "을/를"), "녹원간장게장을");
  assert.equal(withParticle("대전컨벤션센터", "을/를"), "대전컨벤션센터를");

  // 괄호로 끝나는 이름: 괄호 안 마지막 글자로 판정해야 한다.
  // 이 케이스가 화면에 `대전컨벤션센터(DCC)을`을 만들었다.
  assert.equal(
    withParticle("대전컨벤션센터(DCC)", "을/를"),
    "대전컨벤션센터(DCC)를",
  );
  assert.equal(withParticle("국립중앙과학관(과학관)", "을/를"), "국립중앙과학관(과학관)을");

  // 으로/로: 받침 없음 또는 ㄹ 받침이면 `로`
  assert.equal(withParticle("대전", "으로/로"), "대전으로");
  assert.equal(withParticle("서울", "으로/로"), "서울로");
  assert.equal(withParticle("화폐박물관", "으로/로"), "화폐박물관으로");
  assert.equal(withParticle("대전컨벤션센터(DCC)", "으로/로"), "대전컨벤션센터(DCC)로");

  // 숫자·로마자로 끝나는 이름도 읽는 소리로 판정한다.
  assert.equal(particleFor("카페 5", "을/를"), "를"); // 오
  assert.equal(particleFor("게이트 1", "을/를"), "을"); // 일
  assert.equal(particleFor("스타벅스 R", "을/를"), "을"); // 아르
  assert.equal(particleFor("타워 B", "을/를"), "를"); // 비

  assert.equal(
    quotedWithParticle("성심당", "을/를"),
    "‘성심당’을",
  );
});

test("상태 코드는 절대 화면으로 새지 않는다", () => {
  // 예전에 그대로 노출됐던 값들
  assert.equal(statusLabel("confirmed_open"), "운영시간 확인됨");
  assert.match(statusLabel("official_hours_unstructured"), /공식 운영시간/);
  assert.match(statusLabel("bounded"), /일부만 사용/);
  assert.equal(statusLabel("low"), "낮음");
  assert.equal(statusLabel("medium"), "보통");

  // 매핑에 없는 코드도 내부 이름을 노출하지 않는다.
  for (const unknown of [
    "some_new_server_code",
    "WEIRD-CODE",
    "camelCaseThing",
  ]) {
    const label = statusLabel(unknown);
    assert.doesNotMatch(label, /_/, `${unknown} leaked an internal code`);
    assert.notEqual(label, unknown);
  }

  // 이미 한국어 문장이면 그대로 통과시킨다.
  assert.equal(statusLabel("정상 응답"), "정상 응답");
  assert.equal(isMappedStatus("confirmed_open"), true);
  assert.equal(isMappedStatus("nope_not_here"), false);

  // 영어 화면에서 출처가 한국어로 남지 않는다.
  assert.match(
    sourceLabelText("한국관광공사 국문 관광정보", "en"),
    /Korea Tourism Organization/,
  );
  assert.equal(
    sourceLabelText("한국관광공사 국문 관광정보", "ko"),
    "한국관광공사 국문 관광정보",
  );
});

test("여행자 화면은 한국관광공사 내부 API 이름을 숨기고 요청 ID는 남긴다", () => {
  const requestId = "ca907366-6da2-4bf1-8ec1-11cc2774717f";
  const raw = `KorService2.locationBasedList2 호출에 실패했습니다. · Request ID ${requestId}`;

  assert.equal(containsInternalKtoName(raw), true);
  const ko = travelerErrorText(
    new Error(raw),
    "ko",
    "Could not load recommendations.",
    "추천을 불러오지 못했습니다.",
  );
  assert.match(ko, /한국관광공사/);
  assert.match(ko, new RegExp(requestId));
  assert.doesNotMatch(ko, /KorService2|locationBasedList2/);

  const en = travelerErrorText(
    new Error(raw),
    "en",
    "Could not load recommendations.",
    "추천을 불러오지 못했습니다.",
  );
  assert.match(en, /Korea Tourism Organization/);
  assert.match(en, new RegExp(requestId));
  assert.doesNotMatch(en, /KorService2|locationBasedList2|[가-힣]/u);

  assert.equal(
    travelerSourceLabel("KorService2", "ko"),
    "한국관광공사",
  );
  assert.equal(
    travelerSourceLabel("locationBasedList2", "en"),
    "Korea Tourism Organization",
  );
});

test("한국관광공사 경고의 유용한 설명은 유지하고 operation만 지운다", () => {
  const raw =
    "후보 탐색은 한국관광공사 locationBasedList2가 제공하는 최대 반경 20km 안에서 수행합니다.";
  const safe = sanitizeTravelerText(raw, "ko");
  assert.equal(
    safe,
    "후보 탐색은 한국관광공사가 제공하는 최대 반경 20km 안에서 수행합니다.",
  );
  assert.doesNotMatch(safe, /locationBasedList2/);
  const safeEn = sanitizeTravelerText(raw, "en");
  assert.match(safeEn, /Korea Tourism Organization/);
  assert.match(safeEn, /20 km/);
  assert.doesNotMatch(safeEn, /locationBasedList2|[가-힣]/u);
  assert.equal(
    sanitizeTravelerText(
      "한국관광공사 futureNearbyList3 응답이 지연되고 있습니다.",
      "ko",
    ),
    "한국관광공사 응답이 지연되고 있습니다.",
  );
  assert.equal(
    sanitizeTravelerText(
      "후보 탐색은 한국관광공사가 제공하는 관광정보의 최대 검색 범위 20km 안에서 수행합니다.",
      "en",
    ),
    "Candidates are checked within the maximum 20 km search range supported by Korea Tourism Organization data.",
  );

  const generic = travelerErrorText(
    new Error("요청에 실패했습니다. (503) · Request ID req-503"),
    "ko",
    "Could not load recommendations.",
    "추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
  );
  assert.equal(
    generic,
    "추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. · 요청 ID req-503",
  );
});

test("503 upstream_unavailable 응답은 HTTP 문구 대신 재시도 안내와 요청 ID를 보여 준다", async () => {
  const originalFetch = globalThis.fetch;
  const requestId = "ca907366-6da2-4bf1-8ec1-11cc2774717f";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: "upstream_unavailable",
        sourceLedger: [
          {
            apiName: "KorService2",
            operation: "locationBasedList2",
            status: "error",
          },
        ],
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
      },
    );
  try {
    const { fetchJson } = await import("../app/product-app-model.ts");
    let caught;
    try {
      await fetchJson("/api/v1/recover", { method: "POST", body: "{}" });
    } catch (error) {
      caught = error;
    }
    const copy = travelerErrorText(
      caught,
      "ko",
      "Could not load recommendations. Please try again shortly.",
      "추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
    assert.equal(
      copy,
      `추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. · 요청 ID ${requestId}`,
    );
    assert.doesNotMatch(copy, /503|KorService2|locationBasedList2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("시간이 비었어요와 일정 복구가 공용 여행자 오류 경계를 사용한다", async () => {
  const [discover, product, model] = await Promise.all([
    source("app/DiscoverWindowPanel.tsx"),
    source("app/ProductApp.tsx"),
    source("app/product-app-model.ts"),
  ]);
  assert.match(discover, /travelerErrorText\(/);
  assert.match(discover, /travelerSourceLabel\(source, language\)/);
  assert.doesNotMatch(discover, /\{operation \? ` · \$\{operation\}`/);
  assert.match(product, /travelerErrorText\(/);
  assert.match(model, /containsInternalKtoName\(message\)/);
});

test("지점명이 붙은 검색어를 기저명과 지점 단서로 쪼갠다", () => {
  const dcc = parseBranchQuery("성심당 DCC점");
  assert.equal(dcc.base, "성심당");
  assert.equal(dcc.branch, "DCC");
  assert.equal(dcc.hasBranchSuffix, true);

  const lotte = parseBranchQuery("성심당 롯데백화점점");
  assert.equal(lotte.base, "성심당");
  assert.equal(lotte.branch, "롯데백화점");

  const bracket = parseBranchQuery("성심당(DCC점)");
  assert.equal(bracket.base, "성심당");
  assert.equal(bracket.branch, "DCC");

  const station = parseBranchQuery("스타벅스 대전역점");
  assert.equal(station.base, "스타벅스");
  assert.equal(station.branch, "대전역");

  // 지점 표기가 없어도 마지막 토큰이 시설이면 지점 단서로 본다.
  const noSuffix = parseBranchQuery("성심당 롯데백화점");
  assert.equal(noSuffix.base, "성심당");
  assert.equal(noSuffix.branch, "롯데백화점");

  // 본점은 지점 단서가 없다.
  const main = parseBranchQuery("성심당 본점");
  assert.equal(main.base, "성심당");
  assert.equal(main.branch, undefined);

  // 지점이 없는 일반 검색어는 예전과 같이 동작한다.
  const plain = parseBranchQuery("국립중앙과학관");
  assert.equal(plain.base, "국립중앙과학관");
  assert.equal(plain.branch, undefined);

  // 지점 단서가 제목에 있으면 1, 주소에만 있으면 0.6.
  assert.equal(branchAffinity(dcc, "성심당 DCC점", "대전 유성구"), 1);
  assert.equal(
    branchAffinity(dcc, "성심당", "대전컨벤션센터(DCC) 1층"),
    0.6,
  );
  assert.equal(branchAffinity(dcc, "다른 가게", "다른 주소"), 0);
  assert.equal(matchesBase(dcc, "성심당 과학관점"), true);
  assert.equal(matchesBase(dcc, "화폐박물관"), false);
});

test("흰 배경에 흰색을 그리던 규칙이 되살아나지 않는다", async () => {
  const css = await source("app/globals.css");

  // 다크 테마 시절 별칭이 흰색으로 재매핑돼 있다는 사실 자체는 유지되지만,
  // 라이트 표면에 쓰이던 자리는 모두 덮여 있어야 한다.
  for (const selector of [
    "body .saved-timeline li.is-locked",
    "body .saved-timeline li.is-locked::before",
    "body .option-card.is-applied",
    "body .option-continuity-summary b",
    "body .why-list li::before",
    "body .decision-contribution li b",
    "body .route-attribution",
    "body .loading-ring",
  ]) {
    assert.ok(
      css.includes(selector),
      `${selector} override is missing — a white-on-white regression is possible`,
    );
  }

  // 구분선 토큰이 다시 밝아지면 카드 경계가 사라진다.
  const lineToken = css.match(/--line:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(lineToken, "--line token not found");
  const hex = lineToken[1].toLowerCase();
  assert.notEqual(hex, "#e5e8eb");
  const channels = [1, 3, 5].map((index) =>
    Number.parseInt(hex.slice(index, index + 2), 16),
  );
  assert.ok(
    Math.max(...channels) <= 0xd8,
    `--line ${hex} is too light to be visible on white`,
  );

  // 한국어 줄바꿈 정책이 남아 있어야 한다.
  assert.match(css, /word-break:\s*keep-all/);
  assert.match(css, /text-wrap:\s*pretty/);
});

test("사용자 화면에 내부 코드명과 시크릿 이름이 남지 않는다", async () => {
  const [evidence, productApp, flowApp] = await Promise.all([
    source("lib/release/evidence.ts"),
    source("app/ProductApp.tsx"),
    source("app/flow/FlowApp.tsx"),
  ]);

  for (const secret of [
    "SESSION_SIGNING_KEY",
    "OPS_API_KEY",
    "RELEASE_AUDITOR_API_KEY",
  ]) {
    assert.doesNotMatch(
      evidence,
      new RegExp(secret),
      `${secret} appears in a user-facing readiness string`,
    );
  }

  // 조사 폴백 표기가 다시 들어오면 실패한다.
  for (const fallback of ["(으)로", "을(를)", "이(가)"]) {
    for (const [name, text] of [
      ["ProductApp", productApp],
      ["FlowApp", flowApp],
    ]) {
      assert.ok(
        !text.includes(fallback),
        `${name} still renders the particle fallback ${fallback}`,
      );
    }
  }
});

test("영어 화면에 한국어 근거 문장이 남지 않도록 두 언어를 함께 만든다", async () => {
  const [engine, availability, flowApp, productApp] = await Promise.all([
    source("lib/recovery/engine.ts"),
    source("lib/kto/availability.ts"),
    source("app/flow/FlowApp.tsx"),
    source("app/ProductApp.tsx"),
  ]);

  // 엔진이 영어 쌍을 실제로 내보내는지.
  assert.match(engine, /strategyLabelEn:/);
  assert.match(engine, /whyEn: reasons\.en/);
  const purposeStatements = engine.match(/^\s+statement:/gm) ?? [];
  const purposeStatementsEn = engine.match(/^\s+statementEn:/gm) ?? [];
  assert.equal(
    purposeStatements.length,
    purposeStatementsEn.length,
    "every purpose statement needs an English twin",
  );
  assert.match(availability, /noteEn:/);

  // 클라이언트가 영어 쌍을 우선 사용하는지.
  assert.match(flowApp, /option\.whyEn/);
  assert.match(flowApp, /statementEn/);
  assert.match(flowApp, /strategyLabelEn/);
  assert.match(productApp, /option\.whyEn/);
  assert.match(productApp, /statementEn/);
  assert.match(productApp, /strategyLabelEn/);

  // 여행 목적이 바뀐 후보에 "목적 유지"라고 쓰지 않는지.
  assert.match(engine, /changed_visit_category/);
  assert.doesNotMatch(
    engine,
    /관광·체험 목적을 유지하는 공식 관광 콘텐츠 유형입니다/,
    "the old claim survives even when the activity category changes",
  );

  // 세 번째 카드가 다시 무의미한 이름으로 채워지지 않는지.
  // (설명 주석에는 옛 라벨이 남아 있으므로 실제로 내보내는 자리만 본다.)
  assert.doesNotMatch(engine, /ko:\s*"추가 검증 대안"/);
  assert.match(engine, /addFirstUnused\(/);
});

test("지점 검색은 지역이 다른 동일 상호를 앞세우지 않는다", async () => {
  const { branchAffinity, parseBranchQuery } = await import(
    "../lib/location/branch-query.ts"
  );

  const query = parseBranchQuery("스타벅스 대전역점");
  assert.equal(query.base, "스타벅스");
  assert.equal(query.branch, "대전역");

  // 지역명이 겹치면 부분 점수, 전혀 다른 지역이면 0.
  const daejeon = branchAffinity(query, "스타벅스 대전탄방역점", "대전 서구");
  const gangneung = branchAffinity(query, "스타벅스 강릉강문해변점", "강원 강릉시");
  assert.ok(
    daejeon > gangneung,
    `대전 지점이 강릉 지점보다 앞서야 한다 (${daejeon} vs ${gangneung})`,
  );
  assert.equal(gangneung, 0);

  // 지점명이 정확히 맞으면 최고점.
  const exact = parseBranchQuery("성심당 DCC점");
  assert.equal(
    branchAffinity(exact, "성심당 DCC점", "대전 유성구 엑스포로 107"),
    1,
  );

  // 시설 이름 자체가 `점`으로 끝나면 접미사를 떼지 않는다.
  const store = parseBranchQuery("성심당 롯데백화점점");
  assert.equal(store.branch, "롯데백화점");
});

test("지점 해석 실패는 최종 목록으로 판단한다", async () => {
  const search = await source("lib/location/place-search.ts");
  // KTO 결과만 보고 판단하면, 보조 제공자가 지점을 찾아 1순위에 올렸는데도
  // "지점을 찾지 못했습니다"가 뜬다.
  assert.match(search, /const branchResolved =[\s\S]{0,200}merged\.some/);
  // 지점을 물었을 때 상호가 다른 보조 결과는 목록에서 뺀다.
  assert.match(search, /relevantFallback/);
});
