import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

const PUBLIC_ROUTES = [
  "/",
  "/flow",
  "/policy",
  "/sources",
  "/privacy",
  "/terms",
  "/accessibility",
  "/offline",
] as const;

type FlowMockState = {
  applyBodies: unknown[];
  arrivalBodies: unknown[];
  itineraryBodies: unknown[];
  placeSearchBodies: unknown[];
  shareCalls: number;
  lockedAppointment?: {
    id: string;
    title: string;
    startAt: string;
  };
};

const verifiedOption = {
  id: "verified-option",
  title: "국립현대미술관 서울",
  address: "서울특별시 종로구 삼청로 30",
  latitude: 37.5787,
  longitude: 126.9801,
  strategyLabel: "비를 피하면서 전시 관람",
  distanceMeters: 850,
  estimatedTravelMinutes: 12,
  availability: { status: "confirmed_open" },
  indoorSuitability: { status: "verified" },
  accessibility: { status: "not_required" },
  crowd: { status: "available" },
  evidenceGaps: [],
  confirmationRequired: false,
  why: ["실내 운영과 다음 약속 도착 여유를 확인했습니다."],
  sources: ["KorService2", "KorWithService2"],
  dataContributions: [
    {
      source: "KorService2",
      fields: ["title", "mapx", "mapy"],
      status: "applied",
    },
  ],
  purposePreservation: {
    statement: "원래 문화예술 관람 목적을 보존합니다.",
  },
};

const evidenceGapOption = {
  id: "gap-option",
  title: "세종로공원",
  address: "서울특별시 종로구 세종대로",
  latitude: 37.572,
  longitude: 126.9769,
  strategyLabel: "근거리 휴식",
  distanceMeters: 300,
  estimatedTravelMinutes: 5,
  availability: { status: "unavailable" },
  indoorSuitability: { status: "unavailable" },
  accessibility: { status: "not_required" },
  crowd: { status: "available" },
  evidenceGaps: [
    {
      code: "INDOOR_EVIDENCE_MISSING",
      note: "공식 실내 근거를 확인하지 못했습니다.",
    },
  ],
  confirmationRequired: true,
  why: ["가깝지만 우천 시 실내 조건을 확인하지 못했습니다."],
  sources: ["KorService2"],
  dataContributions: [],
  purposePreservation: {
    statement: "휴식 목적의 관련성만 확인했습니다.",
  },
};

function execution(
  currentStepSequence: number,
  status: "active" | "contract_met" = "active",
  lockedAppointment: NonNullable<FlowMockState["lockedAppointment"]> = {
    id: "next",
    title: "세종문화회관",
    startAt: new Date(Date.now() + 150 * 60_000).toISOString(),
  },
) {
  const now = new Date().toISOString();
  return {
    id: "execution-1",
    baseItineraryId: "itinerary-1",
    sourceRunId: "run-1",
    sourceOptionId: verifiedOption.id,
    status,
    currentStepSequence,
    nextFixedStepSequence: 1,
    activatedAt: now,
    outcomePromptAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...(status === "contract_met" ? { contractMetAt: now } : {}),
    steps: [
      {
        id: "replacement-step",
        sequence: 0,
        role: "replacement",
        contentId: "126508",
        title: verifiedOption.title,
        type: "visit",
        scheduledAt: now,
        estimatedArrivalAt: now,
        durationMinutes: 40,
        locationLabel: verifiedOption.address,
        latitude: verifiedOption.latitude,
        longitude: verifiedOption.longitude,
        locked: false,
        reservation: false,
        verificationStatus: "continuity_verified",
        status:
          currentStepSequence === 0
            ? "current"
            : "arrived",
        ...(currentStepSequence > 0 ? { arrivedAt: now } : {}),
      },
      {
        id: "fixed-step",
        originalNodeId: lockedAppointment.id,
        sequence: 1,
        role: "next_fixed",
        title: lockedAppointment.title,
        type: "reservation",
        scheduledAt: lockedAppointment.startAt,
        estimatedArrivalAt: now,
        locationLabel: "서울특별시 종로구 세종대로 175",
        latitude: 37.5726,
        longitude: 126.976,
        locked: true,
        reservation: true,
        verificationStatus: "continuity_verified",
        status:
          status === "contract_met"
            ? "arrived"
            : currentStepSequence === 1
              ? "current"
              : "pending",
        ...(status === "contract_met" ? { arrivedAt: now } : {}),
      },
    ],
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": "e2e-request",
    },
    body: JSON.stringify(body),
  });
}

async function mockFlowApis(
  page: Page,
  options: Array<typeof verifiedOption | typeof evidenceGapOption>,
): Promise<FlowMockState> {
  const state: FlowMockState = {
    applyBodies: [],
    arrivalBodies: [],
    itineraryBodies: [],
    placeSearchBodies: [],
    shareCalls: 0,
  };
  let activeExecution: ReturnType<typeof execution> | null = null;

  await page.route("**/api/v1/places/search", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as {
      keyword?: string;
      purpose?: string;
      fallback?: string;
    };
    state.placeSearchBodies.push(body);
    expect(body.fallback).toBe("auto");
    const currentOrigin = body.purpose === "current_origin";
    expect(body.purpose).toMatch(/^(?:current_origin|saved_stop)$/);
    const place =
      currentOrigin
        ? {
            title: "광화문",
            address: "서울특별시 종로구 세종대로",
            latitude: 37.5759,
            longitude: 126.9768,
            regionCode: "11",
            districtCode: "11110",
            provider: "kakao_local",
            sourceLabel: "카카오 장소검색",
            retention: "ephemeral",
          }
        : {
            title: "세종문화회관",
            address: "서울특별시 종로구 세종대로 175",
            latitude: 37.5726,
            longitude: 126.976,
            regionCode: "11",
            districtCode: "11110",
            provider: "kto",
            sourceLabel: "한국관광공사 국문 관광정보",
            retention: "persistable",
          };
    await fulfillJson(route, { places: [place] });
  });
  await page.route("**/api/v1/itineraries", async (route) => {
    const body = route.request().postDataJSON() as {
      itinerary?: {
        nodes?: Array<{
          id?: string;
          title?: string;
          startAt?: string;
          locked?: boolean;
          reservation?: boolean;
        }>;
      };
    };
    state.itineraryBodies.push(body);
    const locked = body.itinerary?.nodes?.find(
      (node) => node.locked === true && node.reservation === true,
    );
    if (locked?.id && locked.title && locked.startAt) {
      state.lockedAppointment = {
        id: locked.id,
        title: locked.title,
        startAt: locked.startAt,
      };
    }
    await fulfillJson(route, { itinerary: { id: "itinerary-1" } }, 201);
  });
  await page.route("**/api/v1/recover", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.incident).toBe("rain");
    expect(body.indoorOnly).toBe(true);
    await fulfillJson(route, {
      requestId: "run-1",
      persistence: { status: "persisted", runId: "run-1" },
      rejectedCount: 2,
      rejectionSummary: [{ reasonCode: "OFFICIALLY_CLOSED", count: 2 }],
      options,
    });
  });
  await page.route("**/api/v1/recover/run-1/apply", async (route) => {
    state.applyBodies.push(route.request().postDataJSON());
    activeExecution = execution(0, "active", state.lockedAppointment);
    await fulfillJson(route, {
      execution: activeExecution,
    }, 201);
  });
  await page.route("**/api/v1/journey/active", async (route) => {
    if (route.request().method() === "GET") {
      if (!activeExecution) {
        await fulfillJson(
          route,
          { error: { code: "NO_ACTIVE_JOURNEY", message: "No active journey" } },
          404,
        );
        return;
      }
      await fulfillJson(route, { execution: activeExecution });
      return;
    }
    expect(route.request().method()).toBe("PATCH");
    const body = route.request().postDataJSON();
    state.arrivalBodies.push(body);
    activeExecution =
      state.arrivalBodies.length === 1
        ? execution(1, "active", state.lockedAppointment)
        : execution(1, "contract_met", state.lockedAppointment);
    await fulfillJson(route, {
      execution: activeExecution,
    });
  });
  await page.route("**/api/v1/share", async (route) => {
    state.shareCalls += 1;
    await fulfillJson(route, { url: "/share/e2e-proof" }, 201);
  });

  return state;
}

async function pressEnter(locator: Locator) {
  await locator.focus();
  await locator.press("Enter");
}

async function expectNoBlockingAccessibilityIssues(
  page: Page,
  stateLabel: string,
) {
  // Axe evaluates effective contrast, including ancestor opacity. State
  // screens enter with a short 0→1 opacity animation, so scanning during that
  // transition reports a transient blended colour rather than the settled UI.
  // Await only finite animations; progress pulses and spinners are intentionally
  // infinite and do not block the audit.
  await page.evaluate(async () => {
    const finiteAnimations = document.getAnimations().filter((animation) => {
      const iterations = animation.effect?.getTiming().iterations;
      return iterations !== Infinity;
    });
    await Promise.all(
      finiteAnimations.map((animation) =>
        animation.finished.catch(() => undefined),
      ),
    );
  });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) =>
      violation.id === "color-contrast" ||
      violation.impact === "serious" ||
      violation.impact === "critical",
  );
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.flatMap((node) => node.target),
    })),
    `${stateLabel} accessibility violations`,
  ).toEqual([]);
}

async function reachAppointmentSelection(page: Page) {
  await page.goto("/flow", { waitUntil: "domcontentloaded" });
  await pressEnter(page.getByRole("button", { name: /비가 와요/ }));

  const originSearch = page.getByLabel("또는 지금 있는 곳을 검색");
  await originSearch.focus();
  await page.keyboard.type("광화문");
  await page.keyboard.press("Enter");
  const originResult = page.getByRole("button", { name: /광화문.*서울특별시/ });
  await expect(originResult).toBeVisible();
  await pressEnter(originResult);
  await pressEnter(page.getByRole("button", { name: "다음", exact: true }));

  const appointmentSearch = page.getByLabel("약속 장소");
  await appointmentSearch.focus();
  await page.keyboard.type("세종문화회관");
  await page.keyboard.press("Enter");
  const appointmentResult = page.getByRole("button", {
    name: /세종문화회관.*서울특별시/,
  });
  await expect(appointmentResult).toBeVisible();
  await pressEnter(appointmentResult);
}

async function reachFlowOptions(page: Page) {
  await reachAppointmentSelection(page);
  await pressEnter(
    page.getByRole("button", { name: "예약을 지키는 복구안 찾기" }),
  );
  await expect(page.getByText("검증 결과", { exact: true })).toBeVisible();
}

for (const route of PUBLIC_ROUTES) {
  test(`${route} has no serious accessibility or horizontal-overflow defect`, async ({
    page,
  }) => {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    // Flow, Policy, and Sources use viewport-sized fixed shells whose outer
    // landmark can legitimately have a zero-height document box. A visible
    // level-one heading proves the route rendered without coupling this test
    // to those shell layout mechanics.
    await expect(
      page.getByRole("heading", { level: 1 }).first(),
    ).toBeVisible();

    const overflow = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(
      Math.max(overflow.documentWidth, overflow.bodyWidth),
      JSON.stringify(overflow),
    ).toBeLessThanOrEqual(overflow.viewportWidth + 1);

    await expectNoBlockingAccessibilityIssues(page, `${route} initial`);
  });
}

test("home skip link and main content work with keyboard only", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.keyboard.press("Tab");

  const focused = page.locator(":focus");
  await expect(focused).toHaveAttribute("href", "#main-content");
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("flow language selection works with keyboard only", async ({ page }) => {
  await page.goto("/flow", { waitUntil: "domcontentloaded" });
  const english = page.getByRole("button", { name: "EN", exact: true });
  await english.focus();
  await page.keyboard.press("Enter");
  await expect(english).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("editing a selected origin invalidates it and blocks the next step", async ({
  page,
}) => {
  const state = await mockFlowApis(page, [verifiedOption]);
  await page.goto("/flow", { waitUntil: "domcontentloaded" });
  await pressEnter(page.getByRole("button", { name: /비가 와요/ }));
  const originSearch = page.getByLabel("또는 지금 있는 곳을 검색");
  await originSearch.fill("광화문");
  await originSearch.press("Enter");
  await pressEnter(page.getByRole("button", { name: /광화문.*서울특별시/ }));
  await expect(page.getByRole("button", { name: "다음", exact: true })).toBeEnabled();

  await originSearch.fill("광화문역");
  await expect(
    page.getByRole("button", {
      name: "현재 위치를 확인하거나 장소를 검색해 주세요",
    }),
  ).toBeDisabled();
  expect(state.itineraryBodies).toEqual([]);
});

test("editing a selected appointment invalidates it and blocks recovery", async ({
  page,
}) => {
  const state = await mockFlowApis(page, [verifiedOption]);
  await reachAppointmentSelection(page);
  await expect(
    page.getByRole("button", { name: "예약을 지키는 복구안 찾기" }),
  ).toBeEnabled();

  await page.getByLabel("약속 장소").fill("세종문화회관 별관");
  await expect(
    page.getByRole("button", { name: "약속 장소를 선택해 주세요" }),
  ).toBeDisabled();
  expect(state.itineraryBodies).toEqual([]);
});

test("changing an appointment after failure clears stale recovery state", async ({
  page,
}) => {
  await mockFlowApis(page, [verifiedOption]);
  await page.unroute("**/api/v1/recover");
  await page.route("**/api/v1/recover", (route) =>
    fulfillJson(
      route,
      {
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "운영정보 연결을 확인하지 못했습니다.",
        },
      },
      503,
    ),
  );

  await reachAppointmentSelection(page);
  await pressEnter(
    page.getByRole("button", { name: "예약을 지키는 복구안 찾기" }),
  );
  await expect(
    page.getByRole("heading", { name: "복구안을 만들지 못했어요" }),
  ).toBeVisible();

  await pressEnter(page.getByRole("button", { name: "조건 바꾸기" }));
  const future = new Date(Date.now() + 180 * 60_000);
  const futureDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(future);
  const futureTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(future);
  await page.getByLabel("도착 날짜").fill(futureDate);
  await page.getByLabel("도착 시각").fill(futureTime);

  await expect(
    page.getByRole("heading", { name: "복구안을 만들지 못했어요" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/조건이 바뀌었습니다.*이전 실패.*폐기했어요/),
  ).toBeVisible();
  await expect(page.getByText("검증 결과", { exact: true })).toHaveCount(0);
});

test("keyboard-only bridge recovery selects, applies, arrives, and resumes", async ({
  page,
}) => {
  const state = await mockFlowApis(page, [
    verifiedOption,
    evidenceGapOption,
  ]);
  await reachFlowOptions(page);
  await expectNoBlockingAccessibilityIssues(page, "options");

  expect(state.placeSearchBodies).toEqual([
    { keyword: "광화문", purpose: "current_origin", fallback: "auto" },
    { keyword: "세종문화회관", purpose: "saved_stop", fallback: "auto" },
  ]);
  expect(state.itineraryBodies).toHaveLength(1);
  const itineraryRequest = state.itineraryBodies[0] as {
    ephemeralLocationNodeIds?: string[];
    itinerary?: { nodes?: Array<Record<string, unknown>> };
  };
  expect(itineraryRequest.ephemeralLocationNodeIds).toEqual(["now"]);
  const ephemeralNow = itineraryRequest.itinerary?.nodes?.find(
    (node) => node.id === "now",
  );
  expect(ephemeralNow).toBeDefined();
  expect(ephemeralNow).not.toHaveProperty("location");
  expect(ephemeralNow).not.toHaveProperty("latitude");
  expect(ephemeralNow).not.toHaveProperty("longitude");

  const blockedOption = page.getByRole("button", {
    name: "공식 확인 전 적용 불가",
  });
  await expect(blockedOption).toBeDisabled();
  await expect(
    page.getByText("공식 실내 근거를 확인하지 못했습니다."),
  ).toBeVisible();

  const verifiedSelection = page.getByRole("button", {
    name: "선택한 복구안",
  });
  await pressEnter(verifiedSelection);
  await pressEnter(
    page.getByRole("button", {
      name: new RegExp(`${verifiedOption.title}.*이어가기`),
    }),
  );

  await expect(
    page.getByRole("heading", {
      name: new RegExp(`바뀐 일정.*${verifiedOption.title}`),
    }),
  ).toBeVisible();
  await expectNoBlockingAccessibilityIssues(page, "active");
  await pressEnter(
    page.getByRole("button", { name: "실제로 이 장소에 도착했어요" }),
  );
  await expect(
    page.getByRole("heading", { name: /다음 고정 일정.*세종문화회관/ }),
  ).toBeVisible();
  await pressEnter(
    page.getByRole("button", { name: "실제로 이 장소에 도착했어요" }),
  );

  await expect(
    page.getByRole("heading", {
      name: /다음 약속을 지키고.*원래 일정으로 돌아왔어요/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "원래 일정 이어서 보기" }),
  ).toHaveAttribute("href", "/");
  await expectNoBlockingAccessibilityIssues(page, "contract_met");
  expect(state.applyBodies).toEqual([{ optionId: verifiedOption.id }]);
  expect(state.arrivalBodies).toEqual([
    { action: "arrive_step", stepId: "replacement-step" },
    { action: "arrive_step", stepId: "fixed-step" },
  ]);
});

test("an evidence-gap-only result cannot be selected, applied, or shared", async ({
  page,
}) => {
  const state = await mockFlowApis(page, [evidenceGapOption]);
  await reachFlowOptions(page);
  await expectNoBlockingAccessibilityIssues(page, "evidence-gap options");

  await expect(
    page.getByRole("button", { name: "공식 확인 전 적용 불가" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "복구안을 선택해 주세요" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "출발 전 판정 증명 링크 만들기" }),
  ).toBeDisabled();
  expect(state.applyBodies).toEqual([]);
  expect(state.shareCalls).toBe(0);
});

test("policy region selection and result review work with keyboard only", async ({
  page,
}) => {
  await page.route("**/api/v1/regions", (route) =>
    fulfillJson(route, {
      regions: [
        { code: "11", name: "서울특별시" },
        { code: "26", name: "부산광역시" },
      ],
    }),
  );
  await page.route("**/api/v1/regions/11/districts", (route) =>
    fulfillJson(route, { districts: [] }),
  );
  await page.route("**/api/v1/insights/regions/11", (route) =>
    fulfillJson(route, {
      regionName: "서울특별시",
      baseYm: "202607",
      coverage: {
        available: 7,
        expected: 7,
        percent: 100,
        meaning: "공식 세부지표 7개를 모두 확인했습니다.",
      },
      metrics: [
        {
          key: "tourism_diversity",
          label: "관광 다양성",
          officialName: "관광 다양성 지수",
          value: 112.6,
          source: "AreaTarDivService",
          operation: "areaTouDivList",
          baseYm: "202607",
        },
      ],
      sourceLedger: [
        {
          api: "AreaTarDivService",
          operation: "areaTouDivList",
          status: "live",
        },
      ],
      warnings: [],
      generatedAt: "2026-07-31T07:00:00.000Z",
    }),
  );
  await page.route("**/api/v1/insights/missions?areaCode=11", (route) =>
    fulfillJson(route, { missions: [] }),
  );

  await page.goto("/policy", { waitUntil: "domcontentloaded" });
  const seoul = page.getByRole("button", { name: "서울특별시" });
  await expect(seoul).toBeVisible();
  await pressEnter(seoul);
  await pressEnter(
    page.getByRole("button", { name: /^서울특별시 전체로 보기/ }),
  );
  await expect(
    page.getByRole("heading", { name: "서울특별시" }),
  ).toBeVisible();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  await expect(page.getByText("관광 다양성 지수")).toBeVisible();
  await expectNoBlockingAccessibilityIssues(page, "policy results");
  await pressEnter(page.getByRole("button", { name: "다른 지역 보기" }));
  await expect(
    page.getByRole("heading", { name: /어느 지역을.*살펴볼까요/ }),
  ).toBeVisible();
});

test("core flow reflows at a 200% equivalent without clipping its CTA", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto("/flow", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });

  const cta = page.getByRole("button", { name: /비가 와요/ });
  await cta.scrollIntoViewIfNeeded();
  const bounds = await cta.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(641);

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(
    Math.max(layout.documentWidth, layout.bodyWidth),
    JSON.stringify(layout),
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
  await expectNoBlockingAccessibilityIssues(page, "flow at 200% zoom");
});

test("PWA and discovery endpoints are published with production content", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );

  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192" }),
      expect.objectContaining({ sizes: "512x512" }),
      expect.objectContaining({ purpose: "maskable" }),
    ]),
  );

  const [sitemap, robots, serviceWorker] = await Promise.all([
    request.get("/sitemap.xml"),
    request.get("/robots.txt"),
    request.get("/sw.js"),
  ]);
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain("/accessibility");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Sitemap:");
  expect(serviceWorker.status()).toBe(200);
  expect(serviceWorker.headers()["service-worker-allowed"]).toBe("/");
  expect(serviceWorker.headers()["cache-control"]).toContain("no-store");
});
