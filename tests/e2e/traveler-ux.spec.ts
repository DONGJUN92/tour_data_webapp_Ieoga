import { expect, test } from "@playwright/test";

test("contract_missed remains an assertive failure with recovery and support actions", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
  });
  const now = new Date().toISOString();
  const promisedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const missedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  await page.route("**/api/v1/journey/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        execution: {
          id: "missed-execution",
          baseItineraryId: "itinerary-1",
          sourceRunId: "run-1",
          sourceOptionId: "option-1",
          status: "contract_missed",
          currentStepSequence: 2,
          nextFixedStepSequence: 1,
          activatedAt: now,
          outcomePromptAt: now,
          contractMissedAt: missedAt,
          updatedAt: missedAt,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          drift: { status: "unknown", reason: "약속 판정 완료" },
          steps: [
            {
              id: "replacement",
              sequence: 0,
              role: "replacement",
              title: "대체 장소",
              type: "visit",
              latitude: 37.5,
              longitude: 127,
              locked: false,
              reservation: false,
              verificationStatus: "continuity_verified",
              status: "arrived",
              arrivedAt: now,
            },
            {
              id: "fixed",
              sequence: 1,
              originalNodeId: "fixed-original",
              role: "next_fixed",
              title: "다음 약속",
              type: "reservation",
              scheduledAt: promisedAt,
              latitude: 37.51,
              longitude: 127.01,
              locked: true,
              reservation: true,
              verificationStatus: "continuity_verified",
              status: "arrived",
              arrivedAt: missedAt,
            },
            {
              id: "remaining",
              sequence: 2,
              role: "remaining_original",
              title: "남은 일정",
              type: "visit",
              scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString(),
              latitude: 37.52,
              longitude: 127.02,
              locked: false,
              reservation: false,
              verificationStatus: "resumed_original",
              status: "current",
            },
          ],
        },
      }),
    });
  });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const missed = page.getByTestId("contract-missed-alert");
  await expect(missed).toHaveAttribute("role", "alert");
  await expect(missed).toHaveAttribute("aria-live", "assertive");
  await expect(missed).toContainText("도착했지만 약속 시각을 지키지 못했습니다.");
  await expect(missed.getByRole("link", { name: /1330/ })).toHaveAttribute(
    "href",
    "tel:1330",
  );
  await expect(page.getByText("다음 예약을 지켰어요.")).toHaveCount(0);

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(missed).toContainText(
    "You arrived, but did not meet the promised time.",
  );
  await expect(
    missed.getByRole("button", { name: "Recover again from here" }),
  ).toBeVisible();
});

test("ending later stops never rewrites a protected appointment as full-trip completion", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
  });
  const now = new Date().toISOString();
  await page.route("**/api/v1/journey/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        execution: {
          id: "abandoned-after-contract",
          baseItineraryId: "itinerary-1",
          sourceRunId: "run-1",
          sourceOptionId: "option-1",
          status: "abandoned",
          currentStepSequence: 2,
          nextFixedStepSequence: 1,
          activatedAt: now,
          outcomePromptAt: now,
          contractMetAt: now,
          updatedAt: now,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          steps: [
            {
              id: "replacement",
              sequence: 0,
              role: "replacement",
              title: "Recovery stop",
              type: "visit",
              latitude: 37.5,
              longitude: 127,
              locked: false,
              reservation: false,
              verificationStatus: "continuity_verified",
              status: "arrived",
            },
            {
              id: "fixed",
              sequence: 1,
              originalNodeId: "fixed-original",
              role: "next_fixed",
              title: "Protected appointment",
              type: "reservation",
              scheduledAt: now,
              latitude: 37.51,
              longitude: 127.01,
              locked: true,
              reservation: true,
              verificationStatus: "continuity_verified",
              status: "arrived",
            },
            {
              id: "remaining",
              sequence: 2,
              role: "remaining_original",
              title: "Later stop",
              type: "visit",
              latitude: 37.52,
              longitude: 127.02,
              locked: false,
              reservation: false,
              verificationStatus: "resumed_original",
              status: "skipped",
            },
          ],
        },
      }),
    });
  });

  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const ended = page.getByTestId("journey-abandoned");
  await expect(ended).toContainText("남은 여행 진행을 종료했습니다.");
  await expect(ended).toContainText("다음 약속을 지킨 기록은 그대로 유지");
  await expect(page.getByText("다음 약속을 지키고 여행을 끝까지 이어갔어요.")).toHaveCount(0);

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(ended).toContainText("You ended the remaining trip.");
  await expect(ended).toContainText("The met-appointment record remains");
});

test("quick Flow verifies authoritative apply once, preserves the base itinerary, and fails closed on contract_missed", async ({
  page,
}) => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const optionId = "flow-option-verified-0001";
  const itineraryId = "flow-base-itinerary";
  let itineraryWrites = 0;
  let authoritativeReads = 0;
  let arrivalWrites = 0;
  let protectedTitle = "테스트 약속 장소";
  let protectedAt = new Date(Date.now() + 150 * 60_000).toISOString();
  const executionNow = new Date().toISOString();
  const replacementEta = new Date(
    Date.parse(executionNow) + 10 * 60_000,
  ).toISOString();

  const execution = (
    status: "active" | "contract_missed",
    currentStepSequence: number,
  ) => {
    const replacementArrived = currentStepSequence > 0;
    const missed = status === "contract_missed";
    const missedAt = new Date(Date.parse(protectedAt) + 5 * 60_000).toISOString();
    return {
      id: "flow-execution-1",
      baseItineraryId: itineraryId,
      sourceRunId: runId,
      sourceOptionId: optionId,
      status,
      currentStepSequence,
      nextFixedStepSequence: 1,
      activatedAt: executionNow,
      outcomePromptAt: executionNow,
      ...(missed ? { contractMissedAt: missedAt } : {}),
      updatedAt: missed ? missedAt : executionNow,
      expiresAt: new Date(
        Date.parse(executionNow) + 24 * 60 * 60_000,
      ).toISOString(),
      drift: { status: "on_track", reason: "테스트 실행" },
      steps: [
        {
          id: "flow-execution-1-replacement",
          sequence: 0,
          role: "replacement",
          contentId: "12345",
          title: "검증된 대체 장소",
          type: "visit",
          estimatedArrivalAt: replacementEta,
          durationMinutes: 30,
          locationLabel: "검증된 대체 장소",
          latitude: 35.18,
          longitude: 129.08,
          locked: false,
          reservation: false,
          verificationStatus: "continuity_verified",
          status: replacementArrived ? "arrived" : "current",
          ...(replacementArrived ? { arrivedAt: executionNow } : {}),
        },
        {
          id: "flow-execution-1-fixed",
          sequence: 1,
          originalNodeId: "next",
          role: "next_fixed",
          title: protectedTitle,
          type: "reservation",
          scheduledAt: protectedAt,
          locationLabel: protectedTitle,
          latitude: 35.17,
          longitude: 129.07,
          locked: true,
          reservation: true,
          verificationStatus: "continuity_verified",
          status: missed ? "arrived" : replacementArrived ? "current" : "pending",
          ...(missed ? { arrivedAt: missedAt } : {}),
        },
      ],
    };
  };

  await page.route("**/api/v1/places/search", async (route) => {
    const body = route.request().postDataJSON() as { purpose?: string };
    const current = body.purpose === "current_origin";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        places: [
          {
            title: current ? "테스트 출발지" : protectedTitle,
            address: current ? "부산광역시 출발로" : "부산광역시 약속로",
            latitude: current ? 35.16 : 35.17,
            longitude: current ? 129.06 : 129.07,
            regionCode: "26",
            districtCode: "26110",
            provider: "kto",
            sourceLabel: "한국관광공사 국문 관광정보",
            retention: "persistable",
          },
        ],
      }),
    });
  });

  await page.route("**/api/v1/itineraries", async (route) => {
    itineraryWrites += 1;
    const body = route.request().postDataJSON() as {
      itinerary?: { nodes?: Array<{ title?: string; startAt?: string }> };
    };
    const fixed = body.itinerary?.nodes?.[1];
    protectedTitle = fixed?.title ?? protectedTitle;
    protectedAt = fixed?.startAt ?? protectedAt;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ itinerary: { id: itineraryId } }),
    });
  });

  await page.route(/\/api\/v1\/recover$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: runId,
        status: "verified",
        persistence: { status: "persisted", runId },
        rejectedCount: 0,
        rejectionSummary: [],
        options: [
          {
            id: optionId,
            title: "검증된 대체 장소",
            address: "부산광역시 대체로",
            latitude: 35.18,
            longitude: 129.08,
            estimatedTravelMinutes: 10,
            distanceMeters: 700,
            availability: {
              status: "confirmed_open",
              checkedAt: new Date().toISOString(),
            },
            confirmationRequired: false,
            evidenceGaps: [],
            sources: ["KorService2"],
            why: ["실제 경로와 약속 도착 여유를 확인했습니다."],
          },
        ],
      }),
    });
  });

  await page.route(/\/api\/v1\/recover\/[^/]+\/apply$/, async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ execution: execution("active", 0) }),
    });
  });

  await page.route("**/api/v1/journey/active", async (route) => {
    if (route.request().method() === "GET") {
      authoritativeReads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ execution: execution("active", 0) }),
      });
      return;
    }
    arrivalWrites += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        execution:
          arrivalWrites === 1
            ? execution("active", 1)
            : execution("contract_missed", 1),
      }),
    });
  });

  await page.goto("/flow", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /일정이 밀렸어요/ }).click();
  await page.getByLabel("또는 지금 있는 곳을 검색").fill("테스트 출발지");
  await page.getByRole("button", { name: "관광정보·장소 데이터 검색" }).click();
  await page.getByRole("button", { name: /테스트 출발지/ }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByLabel("약속 장소").fill(protectedTitle);
  await page.getByRole("button", { name: "저장 가능한 관광정보 검색" }).click();
  await page.getByRole("button", { name: new RegExp(protectedTitle) }).click();
  await page
    .getByRole("button", { name: "예약을 지키는 복구안 찾기" })
    .click();

  const apply = page.getByTestId("flow-apply-option");
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText("복구안이 적용됐습니다.", { exact: false })).toBeVisible();
  expect(authoritativeReads).toBe(1);
  expect(itineraryWrites).toBe(1);

  const arrival = page.getByTestId("flow-confirm-arrival");
  await arrival.click();
  await expect(arrival).toBeEnabled();
  await arrival.click();

  const missed = page.getByTestId("flow-contract-missed");
  await expect(missed).toHaveAttribute("role", "alert");
  await expect(missed).toHaveAttribute("aria-live", "assertive");
  await expect(missed).toContainText("도착했지만 약속 시각을 지키지 못했습니다.");
  await expect(missed.getByRole("link", { name: "지금 상황에서 다시 복구" })).toHaveAttribute(
    "href",
    "/flow",
  );
  await expect(missed.getByRole("link", { name: /1330/ })).toHaveAttribute(
    "href",
    "tel:1330",
  );
  await expect(page.getByTestId("flow-confirm-arrival")).toHaveCount(0);
  await expect(page.getByText(/다음 약속을 지키고/)).toHaveCount(0);
  expect(arrivalWrites).toBe(2);
  expect(itineraryWrites).toBe(1);
});

test("shared proof separates recommendation, contract evidence and self-reported execution", async ({
  page,
}) => {
  await page.route("**/api/v1/share/proof-v2", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        proof: {
          schema: "urn:ieoga:recovery-proof:v2",
          proofKind: "historical_execution",
          actionability: "historical_not_actionable",
          decisionStatus: "verified",
          recoveryMode: "registered_itinerary",
          ruleVersion: "2026-08-v3",
          generatedAt: "2026-08-11T09:00:00.000Z",
          shareExpiresAt: "2026-08-18T09:00:00.000Z",
          execution: {
            id: "execution-proof-v2",
            status: "completed",
            activatedAt: "2026-08-11T09:01:00.000Z",
            contractMetAt: "2026-08-11T10:39:00.000Z",
            completedAt: "2026-08-11T10:40:00.000Z",
            lastUpdatedAt: "2026-08-11T10:40:00.000Z",
          },
          scheduleDiff: {
            nextFixedAppointmentPreserved: true,
            replacementNode: {
              startAt: "2026-08-11T09:30:00.000Z",
              endAt: "2026-08-11T10:00:00.000Z",
            },
            nextFixedAppointment: {
              title: "예약한 공연",
              scheduledAt: "2026-08-11T11:00:00.000Z",
              estimatedArrivalAt: "2026-08-11T10:40:00.000Z",
              arrivalBufferMinutes: 20,
              requiredBufferMinutes: 15,
              status: "preserved",
            },
          },
          continuityProof: {
            availabilityEvidence: {
              status: "confirmed_open",
              checkedAt: "2026-08-11T09:00:00.000Z",
            },
            routeEvidence: {
              status: "routed",
              provider: "tmap_pedestrian",
              calculatedAt: "2026-08-11T09:00:00.000Z",
            },
          },
          outcomes: [
            {
              event: "selected",
              occurredAt: "2026-08-11T09:01:00.000Z",
              evidenceKind: "system_event",
              verificationLevel: "system_recorded",
            },
            {
              event: "arrived",
              occurredAt: "2026-08-11T10:39:00.000Z",
              actualArrivalAt: "2026-08-11T10:39:00.000Z",
              arrivedOnTime: true,
              evidenceKind: "traveler_self_report",
              verificationLevel: "self_reported_unverified",
            },
          ],
          option: {
            title: "국립박물관",
            sources: ["KorService2", "KorWithService2"],
          },
        },
      }),
    });
  });
  await page.goto("/share/proof-v2", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "1. 판정 계약" }),
  ).toBeVisible();
  await expect(page.getByText("다음 고정 일정 보존")).toBeVisible();
  await expect(page.getByText("전체 체류 구간 공식 운영 확인")).toBeVisible();
  await expect(page.getByText("15 min", { exact: true })).toBeVisible();
  await expect(page.getByText(/목록에서 골랐다는 기록.*적용 또는 도착/)).toBeVisible();
  await expect(page.getByText(/자가 보고이며 제3자 검증 없음/)).toBeVisible();
  await expect(
    page.getByText("과거 실행 이력 · 현재 이동 결정에 사용 불가"),
  ).toBeVisible();
  await expect(
    page.getByText("전체 동선 완료", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "4. Execution and arrival records" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Historical execution record · not for a current travel decision",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Whole journey completed", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Self-reported; not independently verified", {
      exact: false,
    }),
  ).toBeVisible();
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
});

test("getting-started dialog cycles every action and restores focus", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
  });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const trigger = page.getByRole("button", { name: "처음 사용 가이드" });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: /여행이 끊겼을 때/ });
  const close = dialog.getByRole("button", { name: "사용 가이드 닫기" });
  const practice = dialog.getByRole("button", { name: /연습 일정 불러오기/ });
  const dismiss = dialog.getByRole("button", { name: "다음에 볼게요" });
  await expect(close).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(practice).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dismiss).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dismiss).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("mobile navigation exposes the active screen and 44px touch targets", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const recover = page.getByTestId("mobile-nav-recover");
  const discover = page.getByTestId("mobile-nav-discover");
  await expect(recover).toHaveAttribute("aria-current", "page");
  await expect(discover).not.toHaveAttribute("aria-current", "page");

  for (const control of [recover, discover]) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await discover.click();
  await expect(discover).toHaveAttribute("aria-current", "page");
  await expect(recover).not.toHaveAttribute("aria-current", "page");
});

test("manual origin entry renders one shared picker without legacy duplicate controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
  });
  const now = Date.now();
  const itineraryId = crypto.randomUUID();
  const travelDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now + 24 * 60 * 60_000));
  const mutableStartAt = new Date(`${travelDate}T09:00:00+09:00`).toISOString();
  const lockedStartAt = new Date(`${travelDate}T11:00:00+09:00`).toISOString();
  const response = await page.request.post("/api/v1/itineraries", {
    headers: { Origin: "http://127.0.0.1:4192" },
    data: {
      itinerary: {
        id: itineraryId,
        title: "Manual picker contract",
        timezone: "Asia/Seoul",
        audience: "general",
        nodes: [
          {
            id: "mutable",
            sequence: 1,
            type: "visit",
            title: "Changeable stop",
            startAt: mutableStartAt,
            durationMinutes: 45,
            locked: false,
            reservation: false,
            location: {
              latitude: 37.5759,
              longitude: 126.9768,
              label: "Seoul",
            },
          },
          {
            id: "locked",
            sequence: 2,
            type: "reservation",
            title: "Protected appointment",
            startAt: lockedStartAt,
            durationMinutes: 60,
            locked: true,
            reservation: true,
            location: {
              latitude: 37.5726,
              longitude: 126.976,
              label: "Seoul",
            },
          },
        ],
      },
      analyticsConsent: false,
    },
  });
  expect(response.status()).toBe(201);

  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "위치 권한 없이 직접 입력", exact: true })
    .click();
  await expect(page.getByTestId("manual-picker-keyword")).toHaveCount(1);
  await expect(page.getByTestId("manual-picker-search")).toHaveCount(1);
  await expect(page.locator('[data-testid^="origin-place-"]')).toHaveCount(0);
});

test("English selection localizes the app, quick recovery, and plan entry flows", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
  });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Getting started" })).toBeVisible();
  await expect(
    page.locator(
      '[data-testid="nav-recover"]:visible, [data-testid="mobile-nav-recover"]:visible',
    ),
  ).toContainText("My plan broke");
  await expect(
    page.locator(
      '[data-testid="nav-discover"]:visible, [data-testid="mobile-nav-discover"]:visible',
    ),
  ).toContainText("I have free time");
  await expect(
    page.getByRole("heading", { level: 1, name: /When plans break/i }),
  ).toBeVisible();

  await page.goto("/flow", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { level: 1, name: /What changed right now/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /It is raining/i }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Where are you now?" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Or search for your current place"),
  ).toBeVisible();

  await page.goto("/plan", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /When are you travelling/i,
    }),
  ).toBeVisible();
  await expect(page.getByLabel(/Travel date/i)).toBeVisible();
  await page.getByLabel(/Travel date/i).fill("2099-01-01");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Where does the trip start?" }),
  ).toBeVisible();
  await expect(page.getByLabel("Find by place or address")).toBeVisible();
});
