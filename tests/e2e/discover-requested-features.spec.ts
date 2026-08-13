import { expect, test } from "@playwright/test";

test("free-time discovery supports location reselection, future departure and counted official categories", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback) {
          success({
            coords: {
              latitude: 37.5759,
              longitude: 126.9768,
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          } as GeolocationPosition);
        },
      },
    });
  });

  await page.route("**/api/v1/itineraries", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ itineraries: [] }),
    }),
  );
  await page.route("**/api/v1/journey/active", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ execution: null }),
    }),
  );
  await page.route("**/api/v1/location/resolve", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: {
          label: "광화문광장",
          areaCode: "11",
          sigunguCode: "11110",
          areaName: "서울특별시",
          districtName: "종로구",
          attribution: "카카오 로컬",
        },
      }),
    }),
  );

  let recoveryBody: Record<string, unknown> | undefined;
  await page.route(/\/api\/v1\/recover$/, async (route) => {
    recoveryBody = route.request().postDataJSON() as Record<string, unknown>;
    const openWindow = recoveryBody.openWindow as {
      departureAt: string;
      availableUntil: string;
      plannedStayMinutes: number;
    };
    const option = (
      id: string,
      title: string,
      category: { code: string; labelKo: string; labelEn: string },
      distanceMeters: number,
      crowdRate?: number,
    ) => ({
      id,
      contentId: id,
      title,
      address: "서울특별시 종로구",
      latitude: 37.57,
      longitude: 126.98,
      score: 90,
      distanceMeters,
      estimatedTravelMinutes: 10,
      tourismCategory: {
        ...category,
        source: "KorService2.lclsSystm2",
      },
      availability: {
        status: "confirmed_open",
        checkedAt: new Date().toISOString(),
      },
      confirmationRequired: false,
      evidenceGaps: [],
      crowd:
        typeof crowdRate === "number"
          ? { status: "measured", relativeRate: crowdRate, basis: "place" }
          : undefined,
      why: ["실제 이동·체류·복귀 시간을 확인했습니다."],
      scheduleDiff: {
        mode: "open_window",
        replacementNode: {
          id: `${id}-visit`,
          title,
          startAt: new Date(Date.parse(openWindow.departureAt) + 10 * 60_000).toISOString(),
          endAt: new Date(
            Date.parse(openWindow.departureAt) +
              (10 + openWindow.plannedStayMinutes) * 60_000,
          ).toISOString(),
        },
        openWindow: {
          windowStartAt: openWindow.departureAt,
          windowEndAt: openWindow.availableUntil,
          windowMinutes: 180,
          travelToMinutes: 10,
          plannedStayMinutes: openWindow.plannedStayMinutes,
          appliedStayMinutes: openWindow.plannedStayMinutes,
          returnMinutes: 10,
          returnBasis: "origin_return_route",
          returnProvider: "tmap_pedestrian",
          requiredBufferMinutes: 15,
          leftoverMinutes: 125,
          status: "fits",
        },
      },
      continuityProof: {
        routeEvidence: { provider: "tmap_pedestrian" },
      },
    });

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "discover-counted-categories",
        status: "verified",
        generatedAt: new Date().toISOString(),
        rejectedCount: 0,
        rejectionSummary: [],
        warnings: [],
        sourceLedger: [],
        options: [
          option(
            "park-one",
            "열린 공원",
            { code: "PARK", labelKo: "공원", labelEn: "Parks" },
            800,
            20,
          ),
          option(
            "park-two",
            "산책 공원",
            { code: "PARK", labelKo: "공원", labelEn: "Parks" },
            1200,
          ),
          option(
            "heritage-one",
            "문화유산",
            { code: "HERITAGE", labelKo: "문화유산", labelEn: "Heritage" },
            600,
            55,
          ),
          option(
            "food-one",
            "지역 식당",
            { code: "FOOD", labelKo: "식당", labelEn: "Food" },
            500,
            40,
          ),
        ],
      }),
    });
  });

  await page.goto("/app?view=discover", { waitUntil: "domcontentloaded" });

  const automatic = page.getByRole("button", { name: "현재 위치 자동 입력" });
  await automatic.click();
  const recheck = page.getByRole("button", { name: "다시 확인" });
  await expect(recheck).toBeVisible();
  await recheck.click();
  await expect(automatic).toBeVisible();
  await expect(
    page.getByRole("button", { name: "위치 권한 없이 직접 입력" }),
  ).toBeVisible();
  await expect(automatic).toBeFocused();

  await automatic.click();
  await expect(recheck).toBeVisible();
  await page.getByRole("radio", { name: "1시간 후", exact: true }).click();
  await page.getByRole("radio", { name: "4시간", exact: true }).click();
  await page.getByRole("radio", { name: "0시간 30분", exact: true }).click();
  await page
    .getByRole("button", { name: "선택한 시간에 다녀올 수 있는 곳 찾기" })
    .click();

  await expect(page.getByRole("radio", { name: "전체 4" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "공원 2" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "문화유산 1" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "식당 1" })).toBeVisible();
  await page.getByRole("radio", { name: "공원 2" }).click();
  await expect(page.getByTestId("discover-option")).toHaveCount(2);
  await expect(page.getByText("열린 공원", { exact: true })).toBeVisible();
  await expect(page.getByText("산책 공원", { exact: true })).toBeVisible();
  await expect(page.getByText("지역 식당", { exact: true })).toHaveCount(0);

  expect(recoveryBody).toBeDefined();
  expect(recoveryBody).not.toHaveProperty("maxDistanceMeters");
  expect(recoveryBody).not.toHaveProperty("radiusMeters");
  expect(recoveryBody?.availableMinutes).toBe(180);
  const requestWindow = recoveryBody?.openWindow as {
    departureAt: string;
    availableUntil: string;
  };
  expect(
    (Date.parse(requestWindow.availableUntil) -
      Date.parse(requestWindow.departureAt)) /
      60_000,
  ).toBe(180);
  expect(Date.parse(requestWindow.departureAt)).toBeGreaterThan(
    Date.now() + 55 * 60_000,
  );

  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  await expect(page.getByText(/거리 설정|최대 거리/)).toHaveCount(0);
});
