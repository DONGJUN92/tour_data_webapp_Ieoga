import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 2026-08-05 AI 가상 페르소나 조사(23명, 실호출 43회)가 찾은 S1 치명 결함의
   회귀 방지. 각 테스트는 조사에서 실제로 관측된 값을 그대로 쓴다. */

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

function at(hour, minute = 0) {
  /* KST 기준으로 그 시각을 만든다. 판정이 한국 시간대로 계산되므로 UTC로 환산. */
  return new Date(Date.UTC(2026, 7, 5, hour - 9, minute));
}

test("S1-3 표기가 자세한 곳이 검사를 건너뛰지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  /* 조사에서 07:2x~07:3x 호출에 1순위로 올라온 실제 값들. 모두
     `official_hours_unstructured`로 통과했다. */
  const cases = [
    { usetimeculture: "[평일] 10:00~19:00 (입장 마감 18:00) / [주말] 10:00~20:00" },
    { usetimeculture: "09:00~18:00 (입장 마감 17:30)" },
    { usetimeculture: "화요일~일요일 10:00~18:30 (매표 마감 18:00)" },
    { usetime: "11:00~19:00" },
  ];
  for (const item of cases) {
    const evidence = evaluateAvailabilityItem(
      item,
      audit,
      at(7, 40),
      at(9, 10),
    );
    assert.equal(
      evidence.status,
      "confirmed_closed",
      `개관 전 시각인데 걸러지지 않았다: ${JSON.stringify(item)} → ${evidence.status}`,
    );
  }
});

test("S1-3 열려 있는 시각은 여전히 단정하지 않는다", async () => {
  const { evaluateAvailabilityItem } = await import(
    "../lib/kto/availability.ts"
  );
  /* 이 페르소나가 지키는 것은 "요일을 모르면 말하지 말라"가 아니라 **근거를
     넘어서지 말라**다. 두 규칙이 방문 구간에 대해 같은 답을 주면 요일을 몰라도
     답은 하나다 — 13~14시는 평일에도 주말에도 열려 있다. 그때 미확정으로 미루는
     것은 신중함이 아니라, 우리가 이미 아는 것을 여행자에게 숨기는 것이다. */
  const agreeing = evaluateAvailabilityItem(
    { usetimeculture: "[평일] 10:00~19:00 / [주말] 10:00~20:00" },
    audit,
    at(13, 0),
    at(14, 0),
  );
  assert.equal(agreeing.status, "confirmed_open");

  /* 두 규칙이 갈리는 시각에서는 여전히 단정하지 않는다. 19시 30분은 주말에만
     열려 있으므로, 무슨 요일인지 모르면 말할 수 없다. */
  const disagreeing = evaluateAvailabilityItem(
    { usetimeculture: "[평일] 10:00~19:00 / [주말] 10:00~20:00" },
    audit,
    at(19, 0),
    at(19, 30),
  );
  assert.equal(disagreeing.status, "official_hours_unstructured");

  /* 이 페르소나의 원래 사고는 그대로 막힌다 — 07시 20분에 조회했을 때 10시
     개관인 곳이 1순위로 올라오던 일. 어느 규칙으로도 닫혀 있다. */
  const beforeOpening = evaluateAvailabilityItem(
    { usetimeculture: "[평일] 10:00~19:00 / [주말] 10:00~20:00" },
    audit,
    at(7, 20),
    at(8, 20),
  );
  assert.equal(beforeOpening.status, "confirmed_closed");

  /* 표기가 명확한 단일 구간이면 그때는 열려 있다고 확정한다. */
  const clear = evaluateAvailabilityItem(
    { usetime: "09:00~18:00" },
    audit,
    at(13, 0),
    at(14, 0),
  );
  assert.equal(clear.status, "confirmed_open");
});

test("S1-2 대여 정보 한 줄이 내부 이동 확인으로 승격되지 않는다", async () => {
  const { evaluateAccessibility } = await import(
    "../lib/recovery/engine.ts"
  ).then((module) => module).catch(() => ({}));
  /* `evaluateAccessibility`가 내부 함수라면 소스로 계약을 고정한다. */
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  void evaluateAccessibility;
  assert.match(engine, /function rentalOnlyAccessibility/);
  /* 대여만 말하는 값은 필수 항목 충족에서 빠진다. */
  assert.match(engine, /const confirmedForRequired = new Set\(/);
  assert.match(
    engine,
    /\.filter\(\(entry\) => !rentalOnlyAccessibility\(entry\.value\)\)/,
  );
  /* 같은 문장에 동선 표현이 함께 있으면 인정한다 — 정보를 버리는 게 아니다. */
  const fn = engine.slice(
    engine.indexOf("function rentalOnlyAccessibility"),
    engine.indexOf("function accessibilityFields"),
  );
  assert.match(fn, /mentionsMobility/);
  for (const word of ["대여", "렌탈", "보유"]) {
    assert.ok(fn.includes(word), `대여 표현 ${word}이 목록에 없다`);
  }
  for (const word of ["경사", "단차", "엘리베이터"]) {
    assert.ok(fn.includes(word), `동선 표현 ${word}이 목록에 없다`);
  }
});

test("S1-2 장애물이 없다는 진술을 부정으로 읽지 않는다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* `단차 없음`을 부정으로 처리하면 동선을 가장 정확하게 적어 둔 곳이 버려지고
     `대여 가능`만 남은 곳이 등급을 얻는다. 같은 역선택의 다른 얼굴이다. */
  const fn = engine.slice(
    engine.indexOf("function positiveAccessibility"),
    engine.indexOf("/* 무장애 필드의 값이"),
  );
  assert.match(fn, /withoutBarrierAbsence/);
  for (const word of ["단차", "문턱", "계단", "장애물"]) {
    assert.ok(fn.includes(word), `장애물 표현 ${word}이 목록에 없다`);
  }
  /* `해당 없음`·`엘리베이터 없음`은 여전히 부정이어야 한다. */
  assert.ok(fn.includes("해당\\s*없음"), "기존 부정 판정이 사라졌다");
});

test("S1-4 집중률 라벨이 자기 카드의 수치와 모순되지 않는다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* 조사 관측: 이 카드 63.77, 위 카드 14.01인데 라벨이 "덜 붐빌 것으로 예측된
     곳"이었다. 최저 후보가 앞 카드에 쓰이면 차순위가 라벨을 물려받았다. */
  /* 점수 계산 분기가 아니라 라벨을 만드는 블록을 본다. */
  const branch = engine.slice(
    engine.indexOf('"comfortable",'),
    engine.indexOf("} else {\n    addFirstUnused("),
  );
  assert.ok(
    branch.length > 0 && branch.length < 3000,
    `라벨 블록을 찾지 못했다 (${branch.length}자)`,
  );
  assert.match(branch, /const lowerAlreadyShown = selected\.some\(/);
  /* 판정 축은 절대값에서 `crowdComfortScore`로 옮겼다 — 점수·정렬·라벨이
     한 함수를 쓰지 않으면 다시 갈린다. 불변식은 그대로다: 더 덜 붐비는
     후보가 이미 보였으면 "덜 붐빌" 라벨을 쓰지 않는다. */
  assert.match(branch, /crowdComfortScore\(entry\.candidate\) >= score/);
  const engineAll = engine;
  for (const site of [
    /const crowdScore = crowdComfortScore\(candidate\);/,
    /crowdComfortScore\(b\) - crowdComfortScore\(a\)/,
  ]) {
    assert.match(
      engineAll,
      site,
      `점수·정렬 중 하나가 공통 함수를 쓰지 않는다: ${site}`,
    );
  }
  /* 더 낮은 후보가 이미 보였으면 다른 문구를 쓴다. */
  assert.match(branch, /집중률 예측을 확인한 곳/);
  /* 예측값이 아예 없으면 그것도 밝힌다. */
  assert.match(branch, /집중률 예측을 확인하지 못한 곳/);
});

test("S1-5 접근성 미확인이 추천 이유에 반드시 나온다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  /* 조사 관측: grade X · 필수 항목 전부 missing인 후보가 유일 추천인데 `why`
     다섯 문장에 접근성 문장이 0개였다. `evidenceGaps`는 "자동 복구안에서
     제외합니다"라고 적혀 있는데 화면은 추천으로 보여주는 상태였다. */
  assert.match(engine, /} else if \(input\.audience !== "general"\) \{/);
  assert.match(engine, /요청한 이동 조건 중 \$\{missing\.join/);
  assert.match(engine, /출발 전에 직접 확인해 주세요/);
  /* 무엇이 확인되지 않았는지 이름을 대야 한다. */
  assert.match(engine, /requiredChecks\s*\n?\s*\.filter\(\(check\) => check\.status === "missing"\)/);
});

test("S1 운영 미확인·휴무 후보는 UI에서도 fail-closed로 차단한다", async () => {
  const { optionApplicationSafety } = await import("../app/traveler-safety.ts");
  for (const status of [
    "confirmed_closed",
    "official_hours_unstructured",
    "unknown",
    undefined,
  ]) {
    const safety = optionApplicationSafety(
      { availability: status ? { status } : undefined },
      "ko",
    );
    assert.equal(safety.canApply, false, `${status ?? "missing"}가 적용 가능해졌다`);
    assert.ok(safety.reasons.length >= 1);
  }
  assert.equal(
    optionApplicationSafety(
      {
        availability: { status: "confirmed_open" },
        confirmationRequired: false,
        evidenceGaps: [],
      },
      "en",
    ).canApply,
    true,
  );
});

test("S1 잠근 약속의 ID·시각·잠금 플래그가 하나라도 변하면 UI가 적용을 거부한다", async () => {
  const { executionPreservesLockedAppointment } = await import(
    "../app/traveler-safety.ts"
  );
  const locked = {
    id: "next",
    title: "세종문화회관",
    startAt: "2026-08-09T18:00:00+09:00",
    locked: true,
    reservation: true,
  };
  const execution = {
    nextFixedStepSequence: 1,
    steps: [
      {
        id: "fixed-step",
        originalNodeId: "next",
        sequence: 1,
        role: "next_fixed",
        title: "세종문화회관",
        scheduledAt: "2026-08-09T09:00:00.000Z",
        locked: true,
        reservation: true,
      },
    ],
  };
  assert.equal(executionPreservesLockedAppointment(execution, locked), true);
  assert.equal(
    executionPreservesLockedAppointment(
      {
        ...execution,
        steps: [{ ...execution.steps[0], scheduledAt: "2026-08-09T15:40:00+09:00" }],
      },
      locked,
    ),
    false,
  );
  assert.equal(
    executionPreservesLockedAppointment(
      {
        ...execution,
        steps: [{ ...execution.steps[0], originalNodeId: "chosen" }],
      },
      locked,
    ),
    false,
  );
});

test("S1 예약이 아닌 고정 방문도 원본 잠금 플래그 그대로 적용할 수 있다", async () => {
  const { executionPreservesLockedAppointment } = await import(
    "../app/traveler-safety.ts"
  );
  const lockedVisit = {
    id: "museum-fixed",
    title: "도슨트 투어",
    startAt: "2026-08-09T18:00:00+09:00",
    locked: true,
    reservation: false,
  };
  const execution = {
    nextFixedStepSequence: 2,
    steps: [
      {
        id: "fixed-visit-step",
        originalNodeId: "museum-fixed",
        sequence: 2,
        role: "next_fixed",
        title: "도슨트 투어",
        scheduledAt: "2026-08-09T09:00:00.000Z",
        locked: true,
        reservation: false,
      },
    ],
  };
  assert.equal(
    executionPreservesLockedAppointment(execution, lockedVisit),
    true,
  );
  assert.equal(
    executionPreservesLockedAppointment(
      {
        ...execution,
        steps: [{ ...execution.steps[0], reservation: true }],
      },
      lockedVisit,
    ),
    false,
  );
});

test("일정 마법사는 과거일·시간 역전·잠금 없음 계약을 저장 전에 검사한다", async () => {
  const wizard = await readFile(
    new URL("../app/plan/PlanWizard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(wizard, /min=\{todayInKorea\(\)\}/);
  assert.match(wizard, /entry\.time <= previous/);
  assert.match(wizard, /!plan\.some\(\(entry\) => entry\.locked\)/);
  assert.match(wizard, /setError\(""\)/);
  assert.match(wizard, /language=\{language\}/);
});

test("빈 시간 결과는 제외사유·반사실과 별도 복귀 경로 근거를 보존한다", async () => {
  const panel = await readFile(
    new URL("../app/DiscoverWindowPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panel, /rejectionSummary:/);
  assert.match(panel, /counterfactual:/);
  assert.match(panel, /origin_return_route/);
  assert.match(panel, /returnProvider/);
  assert.match(panel, /returnDistanceMeters/);
  assert.match(panel, /SourceLedgerDisclosure/);
  assert.match(
    panel,
    /추천 결과가 0건이어도 실제로 조회한 원천과 연결 실패를 숨기지 않습니다/,
  );
  assert.match(panel, /ledgerStatusLabel/);
});

test("/app과 /flow는 우천 복구를 모두 실내 우선으로 요청한다", async () => {
  const [product, flow] = await Promise.all([
    readFile(new URL("../app/ProductApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/flow/FlowApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(product, /useState\(true\).*indoorTouched/s);
  assert.match(product, /indoorOnly,/);
  assert.match(flow, /indoorOnly:\s*incident === "rain" \? !includeOutdoor : false/);
});

test("/app 직접 위치 입력은 한 개의 장소 검색 폼만 제공한다", async () => {
  const [product, picker] = await Promise.all([
    readFile(new URL("../app/ProductApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ManualLocationPicker.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal((product.match(/<ManualLocationPicker/g) ?? []).length, 1);
  assert.doesNotMatch(product, /origin-place-keyword|origin-place-search/);
  assert.equal((picker.match(/data-testid="manual-picker-keyword"/g) ?? []).length, 1);
  assert.equal((picker.match(/data-testid="manual-picker-search"/g) ?? []).length, 1);
  assert.match(product, /geoState === "success"[\s\S]*originLabel\.trim\(\)/);
});

test("S1 적용·도착 결과는 active journey 상태 머신을 우회하지 못한다", async () => {
  const [product, outcomeRoute] = await Promise.all([
    readFile(new URL("../app/ProductApp.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/v1/recover/[runId]/outcome/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(product, /recordRecoveryOutcome/);
  assert.doesNotMatch(product, /"arrived"\s*\)/);
  assert.doesNotMatch(product, /"abandoned"\s*\)/);
  assert.match(product, /\/api\/v1\/journey\/active/);
  assert.match(outcomeRoute, /parsed\.data\.event !== "selected"/);
  assert.match(outcomeRoute, /JOURNEY_EXECUTION_REQUIRED/);
});

test("S1 apply 응답은 서버의 authoritative active execution과 다시 일치해야 한다", async () => {
  const [product, flow, safety] = await Promise.all([
    readFile(new URL("../app/ProductApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/flow/FlowApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/traveler-safety.ts", import.meta.url), "utf8"),
  ]);

  assert.match(product, /authoritativeExecutionMatchesApply/);
  assert.match(product, /fetchJson\("\/api\/v1\/journey\/active"\)/);
  assert.match(product, /applyInFlightRef\.current/);
  assert.match(product, /applyRequestGenerationRef\.current/);
  assert.match(product, /Boolean\(applyingOptionId\)/);
  assert.match(safety, /activeExecution\.id === applyExecution\.id/);
  assert.match(safety, /execution\.sourceRunId === expected\.runId/);
  assert.match(safety, /execution\.sourceOptionId === expected\.optionId/);
  assert.match(safety, /sameExecutionTopology/);

  assert.match(flow, /normalizeJourneyExecution\(applyPayload\)/);
  assert.match(flow, /getJson\(\s*"\/api\/v1\/journey\/active"/s);
  assert.match(flow, /authoritativeExecutionMatchesApply/);
  assert.match(flow, /applyInFlightRef\.current/);
  assert.match(flow, /applyRequestGenerationRef\.current/);
  assert.match(flow, /applyExecution\.baseItineraryId === expected\.baseItineraryId/);
  assert.match(flow, /executionPreservesLockedAppointment\(\s*authoritativeExecution/s);
  assert.match(flow, /setExecution\(authoritativeExecution\)/);
  assert.equal(
    (flow.match(/postJson\("\/api\/v1\/itineraries"/g) ?? []).length,
    1,
    "Flow는 최초 불변 원본 itinerary만 등록해야 한다",
  );
  assert.doesNotMatch(flow, /registered\.(?:nowIso|nodes)/);
});

test("S1 A→B→A의 과거 200 응답은 authoritative B와 다르면 거부한다", async () => {
  const { authoritativeExecutionMatchesApply } = await import(
    "../app/traveler-safety.ts"
  );
  const makeExecution = (id, runId, optionId) => ({
    id,
    baseItineraryId: "itinerary-1",
    sourceRunId: runId,
    sourceOptionId: optionId,
    status: "active",
    currentStepSequence: 0,
    nextFixedStepSequence: 1,
    activatedAt: "2026-08-11T09:00:00.000Z",
    outcomePromptAt: "2026-08-11T09:30:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
    expiresAt: "2026-08-12T09:00:00.000Z",
    steps: [
      {
        id: `${id}-replacement`,
        sequence: 0,
        role: "replacement",
        title: "대체 장소",
        type: "visit",
        latitude: 37.5,
        longitude: 127,
        locked: false,
        reservation: false,
        verificationStatus: "continuity_verified",
        status: "current",
      },
      {
        id: `${id}-fixed`,
        sequence: 1,
        originalNodeId: "fixed",
        role: "next_fixed",
        title: "다음 약속",
        type: "reservation",
        scheduledAt: "2026-08-11T12:00:00.000Z",
        latitude: 37.51,
        longitude: 127.01,
        locked: true,
        reservation: true,
        verificationStatus: "continuity_verified",
        status: "pending",
      },
    ],
  });
  const staleA = makeExecution("execution-a", "run-a", "option-a");
  const activeB = makeExecution("execution-b", "run-b", "option-b");
  assert.equal(
    authoritativeExecutionMatchesApply(staleA, activeB, {
      runId: "run-a",
      optionId: "option-a",
    }),
    false,
  );
  assert.equal(
    authoritativeExecutionMatchesApply(staleA, structuredClone(staleA), {
      runId: "run-a",
      optionId: "option-a",
    }),
    true,
  );
  const driftedA = structuredClone(staleA);
  driftedA.steps[1].scheduledAt = "2026-08-11T12:01:00.000Z";
  assert.equal(
    authoritativeExecutionMatchesApply(staleA, driftedA, {
      runId: "run-a",
      optionId: "option-a",
    }),
    false,
  );
  const wrongBase = structuredClone(staleA);
  wrongBase.baseItineraryId = "itinerary-2";
  assert.equal(
    authoritativeExecutionMatchesApply(staleA, wrongBase, {
      runId: "run-a",
      optionId: "option-a",
      baseItineraryId: "itinerary-1",
    }),
    false,
  );
  const changedRoute = structuredClone(staleA);
  changedRoute.steps[0].latitude = 37.7;
  assert.equal(
    authoritativeExecutionMatchesApply(staleA, changedRoute, {
      runId: "run-a",
      optionId: "option-a",
      baseItineraryId: "itinerary-1",
    }),
    false,
  );
});

test("/flow contract_missed는 실패로 고정하고 재도착·완료 후 dead share를 막는다", async () => {
  const flow = await readFile(
    new URL("../app/flow/FlowApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(flow, /executionContractMissed/);
  assert.match(flow, /data-testid="flow-contract-missed"/);
  assert.match(flow, /role="alert"[\s\S]*aria-live="assertive"/);
  assert.match(flow, /도착했지만 약속 시각을 지키지 못했습니다\./);
  assert.match(flow, /You arrived, but did not meet the promised time\./);
  assert.match(flow, /href="\/flow"[\s\S]*지금 상황에서 다시 복구/);
  assert.match(flow, /href="tel:1330"/);
  assert.match(flow, /execution\.status === "active"[\s\S]*data-testid="flow-confirm-arrival"/);
  assert.match(flow, /arrivalInFlightRef\.current/);
  assert.match(flow, /data-testid="flow-create-historical-proof"/);
  assert.match(flow, /proofKind: "historical_execution"/);
  assert.match(flow, /"historical_not_actionable"/);
  assert.match(flow, /현재 이동 결정에 사용하면 안 됩니다/);
  assert.match(flow, /proofShareLinks\.historical\.runId === execution\.sourceRunId/);
});

test("contract_missed는 성공과 분리해 한·영 경고, 재복구와 1330 지원을 제공한다", async () => {
  const [cockpit, model] = await Promise.all([
    readFile(new URL("../app/ActiveJourneyCockpit.tsx", import.meta.url), "utf8"),
    import("../app/product-app-model.ts"),
  ]);
  assert.match(cockpit, /execution\.status === "contract_missed"/);
  assert.match(cockpit, /도착했지만 약속 시각을 지키지 못했습니다\./);
  assert.match(cockpit, /You arrived, but did not meet the promised time\./);
  assert.match(cockpit, /role="alert"/);
  assert.match(cockpit, /aria-live="assertive"/);
  assert.match(cockpit, /지금 상황에서 다시 복구/);
  assert.match(cockpit, /href="tel:1330"/);
  assert.match(cockpit, /contractMissedAt/);
  assert.match(cockpit, /contractMetAt/);
  assert.match(cockpit, /data-testid="journey-abandoned"/);
  assert.match(cockpit, /다음 약속을 지킨 기록은 그대로 유지/);
  assert.match(cockpit, /The met-appointment record remains/);
  assert.match(cockpit, /const trackedSteps = execution\.steps;/);
  assert.doesNotMatch(cockpit, /sequence <= execution\.nextFixedStepSequence/);
  assert.match(cockpit, /whole recovered trip/);

  const validMissed = {
    execution: {
      id: "execution-missed",
      baseItineraryId: "itinerary-1",
      sourceRunId: "run-1",
      sourceOptionId: "option-1",
      status: "contract_missed",
      currentStepSequence: 1,
      nextFixedStepSequence: 1,
      activatedAt: "2026-08-11T09:00:00.000Z",
      outcomePromptAt: "2026-08-11T09:30:00.000Z",
      contractMissedAt: "2026-08-11T12:05:00.000Z",
      updatedAt: "2026-08-11T12:05:00.000Z",
      expiresAt: "2026-08-12T09:00:00.000Z",
      steps: [
        {
          id: "fixed-step",
          sequence: 1,
          role: "next_fixed",
          title: "다음 약속",
          type: "reservation",
          scheduledAt: "2026-08-11T12:00:00.000Z",
          latitude: 37.5,
          longitude: 127,
          locked: true,
          reservation: true,
          verificationStatus: "continuity_verified",
          status: "arrived",
        },
      ],
    },
  };
  assert.equal(model.normalizeJourneyExecution(validMissed)?.status, "contract_missed");
  assert.equal(
    model.normalizeJourneyExecution({
      execution: { ...validMissed.execution, status: "arrived" },
    }),
    null,
  );
});

test("60분 빈시간 선택은 분 경계에서도 줄지 않고 embed 체류·왕복 공간을 남긴다", async () => {
  const { windowEndIsoFromMinutes } = await import("../app/traveler-safety.ts");
  for (const now of [
    Date.parse("2026-08-11T00:00:00.001Z"),
    Date.parse("2026-08-11T00:29:59.999Z"),
    Date.parse("2026-08-11T00:59:59.999Z"),
  ]) {
    assert.equal(Date.parse(windowEndIsoFromMinutes(60, now)) - now, 60 * 60_000);
  }
  const [discover, embed] = await Promise.all([
    readFile(new URL("../app/DiscoverWindowPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/embed/recover/EmbedRecoverWidget.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(discover, /setMinutes\(target\.getMinutes\(\) - remainder\)/);
  assert.match(discover, /availableUntil: requestWindowEndIso/);
  assert.match(discover, /arriveBy: requestWindowEndIso/);
  assert.match(embed, /const EMBED_STAY_MINUTES = 30/);
  assert.match(embed, /minimumStayMinutes: EMBED_STAY_MINUTES/);
  assert.match(embed, /plannedStayMinutes: EMBED_STAY_MINUTES/);
  assert.match(embed, /availableUntil: requestAvailableUntil/);
});

test("공유 증명은 추천 판정과 실행을 분리하고 중앙 안전 계약을 감사 가능하게 보인다", async () => {
  const share = await readFile(
    new URL("../app/share/[token]/ShareView.tsx", import.meta.url),
    "utf8",
  );
  for (const contractField of [
    "nextFixedAppointment",
    "scheduledAt",
    "estimatedArrivalAt",
    "arrivalBufferMinutes",
    "requiredBufferMinutes",
    "availabilityEvidence",
    "checkedAt",
    "routeEvidence",
    "calculatedAt",
    "returnProvider",
    "returnCalculatedAt",
    "ruleVersion",
    "generatedAt",
    "shareExpiresAt",
    "evidenceKind",
    "verificationLevel",
    "proofKind",
    "actionability",
    "contractMetAt",
    "contractMissedAt",
    "lastUpdatedAt",
  ]) {
    assert.match(share, new RegExp(contractField));
  }
  assert.match(share, /추천 시점의 판정 근거와 이후 실행 기록을 분리/);
  assert.match(share, /목록에서 골랐다는 기록입니다\. 적용 또는 도착을 뜻하지 않습니다\./);
  assert.match(share, /Self-reported; not independently verified/);
  assert.match(share, /No application or arrival record existed when shared/);
  assert.match(share, /과거 실행 이력 · 현재 이동 결정에 사용 불가/);
  assert.match(share, /Historical execution record · not for a current travel decision/);
  assert.match(share, /증명의 사용 범위 미확인 · 이동 결정에 사용하지 마세요/);
  assert.doesNotMatch(share, /nextFixed\.safetyBufferMinutes/);
});

test("TourAPI의 넓은 관광지 유형을 자연 관광으로 과장 분류하지 않는다", async () => {
  const engine = await readFile(
    new URL("../lib/recovery/engine.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    engine,
    /"12": \{ key: "attraction", label: "관광 명소", tier: "sightseeing" \}/,
  );
  assert.doesNotMatch(engine, /"12": \{[^\n]*label: "자연 관광"/);
});

test("임베드는 성공한 공식 행정구역 응답만 현재 위치로 확정한다", async () => {
  const { verifiedTravelerOrigin } = await import("../app/traveler-safety.ts");
  const coordinates = { latitude: 37.5759, longitude: 126.9768 };

  assert.deepEqual(
    verifiedTravelerOrigin(
      {
        label: "서울특별시 종로구",
        areaCode: "11",
        sigunguCode: "11110",
      },
      coordinates,
    ),
    {
      ...coordinates,
      label: "서울특별시 종로구",
      areaCode: "11",
      sigunguCode: "11110",
    },
  );
  assert.equal(
    verifiedTravelerOrigin(
      { error: { code: "LOCATION_UNRESOLVED" } },
      coordinates,
    ),
    null,
  );
  assert.equal(
    verifiedTravelerOrigin(
      { location: { label: "현재 위치" } },
      coordinates,
    ),
    null,
  );
  assert.equal(
    verifiedTravelerOrigin(
      {
        data: {
          label: "잘못된 코드",
          areaCode: "11",
          sigunguCode: "26110",
        },
      },
      coordinates,
    ),
    null,
  );

  const widget = await readFile(
    new URL("../app/embed/recover/EmbedRecoverWidget.tsx", import.meta.url),
    "utf8",
  );
  assert.match(widget, /if \(!response\.ok\)/);
  assert.match(widget, /setOrigin\(null\)/);
  assert.match(widget, /role=\{originState === "error" \? "alert" : "status"\}/);
});
