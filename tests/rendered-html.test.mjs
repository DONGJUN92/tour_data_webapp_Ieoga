import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EIGHT_KTO_SERVICES = [
  "KorService2",
  "TarRlteTarService1",
  "TatsCnctrRateService",
  "KorWithService2",
  "LocgoHubTarService1",
  "AreaTarDemDsService",
  "AreaTarResDemService",
  "AreaTarDivService",
];

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

async function sourceFiles(relativeDirectory) {
  const directory = path.join(ROOT, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return sourceFiles(relativePath);
      return /\.(?:ts|tsx|js|mjs|sql|json|html|css)$/.test(entry.name)
        ? [relativePath]
        : [];
    }),
  );
  return nested.flat();
}

async function workerFetch(pathname = "/", headers = { accept: "text/html" }) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost/"), { headers }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function renderHome() {
  return workerFetch("/");
}

function ktoEnvelope(items) {
  return {
    response: {
      header: { resultCode: "0000", resultMsg: "OK" },
      body: {
        items: items.length ? { item: items } : "",
        totalCount: items.length,
        pageNo: 1,
        numOfRows: items.length,
      },
    },
  };
}

test("production home server-renders intact Korean nationwide markers", async () => {
  const response = await renderHome();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /이어가/);
  assert.match(html, /전국 어디서든, 여행 중에 바로/);
  assert.match(html, /다음 예약을 지켜/);
  assert.match(html, /여행 복구/);
  assert.match(html, /한국관광공사 OpenAPI/);
  assert.match(html, /data-testid="recover-submit"/);
  assert.doesNotMatch(html, /\uFFFD/);
  assert.doesNotMatch(
    html,
    /관광 회복탄력성 프로토타입|guided prototype|codex-preview|Your site is taking shape/i,
  );
});

test("production entry and routes do not activate prototype or synthetic fallback paths", async () => {
  const [page, capabilities, routeFiles] = await Promise.all([
    /* 앱 본체는 `/app`으로 옮겼다. `/`는 로고와 버튼 셋만 있는 랜딩이다. */
    source("app/app/page.tsx"),
    source("app/api/v1/capabilities/route.ts"),
    sourceFiles("app/api"),
  ]);

  assert.match(page, /import\s+\{\s*ProductApp\s*\}/);
  assert.doesNotMatch(page, /PrototypeApp|prototype/i);
  assert.match(capabilities, /scope:\s*"nationwide"/);
  assert.match(capabilities, /syntheticBackfill:\s*false/);
  assert.doesNotMatch(capabilities, /syntheticBackfill:\s*true/);

  const productionRouteSource = (
    await Promise.all(routeFiles.map((file) => source(file)))
  ).join("\n");
  assert.doesNotMatch(productionRouteSource, /PrototypeApp|SAMPLE_CANDIDATES|MOCK_CANDIDATES/i);
  assert.doesNotMatch(
    productionRouteSource,
    /(?:mode|delivery|source)\s*:\s*["'](?:prototype|synthetic|mock|snapshot_fallback)["']/i,
  );
  assert.doesNotMatch(
    productionRouteSource,
    /(?:fallback|catch)\w*\s*[:=]\s*(?:\[|\{)[\s\S]{0,120}(?:title|contentId)/i,
  );
});

test("capabilities endpoint publishes the nationwide, privacy-minimal production contract", async () => {
  const response = await workerFetch("/api/v1/capabilities", {
    accept: "application/json",
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json\b/i,
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const payload = await response.json();
  assert.equal(payload.scope, "nationwide");
  assert.equal(payload.regionSource, "KorService2.ldongCode2");
  assert.equal(payload.travelerRecovery.supported, true);
  assert.equal(
    payload.travelerRecovery.registeredItineraryRequired,
    true,
  );
  assert.equal(payload.travelerRecovery.exactLocationRetention, "none");
  assert.equal(payload.travelerRecovery.routeEta.supported, true);
  assert.equal(
    payload.travelerRecovery.routeEta.currentMethod,
    "shared_public_osrm_compatible",
  );
  assert.equal(
    payload.travelerRecovery.routeEta.unavailableBehavior,
    "reject_continuity_candidate_without_route_fallback",
  );
  assert.equal(
    payload.travelerRecovery.weatherAutoDetection.currentMethod,
    "shared_public_open_meteo",
  );
  assert.equal(
    payload.travelerRecovery.reverseGeocoding.currentMethod,
    "shared_public_nominatim_then_kto_nearest",
  );
  assert.equal(
    payload.travelerRecovery.reverseGeocoding.browserRequestCoordinatesInUrl,
    false,
  );
  assert.equal(
    payload.travelerRecovery.reverseGeocoding.upstreamProviderTransport,
    "https_query_parameters",
  );
  assert.equal(
    payload.externalProviderReadiness.statusEndpoint,
    "/api/v1/health/ready",
  );
  assert.equal(
    payload.externalProviderReadiness.sharedPublicReleaseBehavior,
    "blocked",
  );
  assert.equal(payload.policyInsights.syntheticBackfill, false);
  assert.equal(payload.policyInsights.missionLoop.supported, true);
  assert.equal(payload.policyInsights.missionLoop.behaviorMinimumSample, 30);
});

test("live location resolution keeps coordinates out of URLs and publishes provider attribution", async () => {
  const [route, product] = await Promise.all([
    source("app/api/v1/location/resolve/route.ts"),
    source("app/ProductApp.tsx"),
  ]);

  assert.match(route, /export async function POST\(/);
  assert.doesNotMatch(route, /export async function GET\(/);
  assert.doesNotMatch(route, /nextUrl\.searchParams/);
  assert.match(route, /toFixed\(5\)/);
  assert.match(route, /Cache-Control", "no-store"/);

  assert.match(product, /position\.coords\.latitude\.toFixed\(5\)/);
  assert.match(product, /fetchJson\("\/api\/v1\/location\/resolve",\s*\{/);
  assert.match(product, /method:\s*"POST"/);
  assert.doesNotMatch(product, /\/api\/v1\/location\/resolve\?/);
  assert.match(product, /setLocationMode\("automatic"\);[\s\S]{0,120}setGeoState\("success"\)/);
  assert.match(product, /\.catch\(\(\) => \{[\s\S]{0,120}setLocationMode\("manual"\)/);
  assert.match(product, /\(error\) => \{[\s\S]{0,120}setLocationMode\("manual"\)/);
  assert.match(product, /locationMode === "automatic" && geoState === "success"/);
  assert.match(product, /locationMode === "manual"/);
  assert.match(product, /위치 판별 출처/);
  assert.match(product, /추천 경로 출처/);
  assert.match(product, /적용 경로 출처/);
  assert.doesNotMatch(
    product,
    /tab === "insights"[\s\S]{0,120}loadInsightRegions\(/,
  );
});

test("bridge appointment window crosses KST midnight without changing the promised duration", async () => {
  const {
    appointmentAfterMinutesInKorea,
    appointmentMinutesFromNow,
    MAX_APPOINTMENT_MINUTES,
    MIN_APPOINTMENT_MINUTES,
  } = await import("../app/product-app-model.ts");
  const now = new Date("2026-07-31T13:30:00.000Z"); // 22:30 in Korea

  assert.deepEqual(appointmentAfterMinutesInKorea(now, 150), {
    date: "2026-08-01",
    time: "01:00",
  });
  assert.equal(
    appointmentMinutesFromNow("2026-08-01", "01:00", now.getTime()),
    150,
  );
  assert.equal(MIN_APPOINTMENT_MINUTES, 15);
  assert.equal(MAX_APPOINTMENT_MINUTES, 24 * 60);
});

test("bridge input rejects blank, zero, and overseas coordinates", async () => {
  const { parseKoreaCoordinate } = await import(
    "../app/product-app-model.ts"
  );

  assert.equal(parseKoreaCoordinate("", 32, 39.8), undefined);
  assert.equal(parseKoreaCoordinate("  ", 32, 39.8), undefined);
  assert.equal(parseKoreaCoordinate("0", 32, 39.8), undefined);
  assert.equal(parseKoreaCoordinate("40.7128", 32, 39.8), undefined);
  assert.equal(parseKoreaCoordinate("37.5665", 32, 39.8), 37.5665);
  assert.equal(parseKoreaCoordinate("126.9780", 124, 132), 126.978);
});

test("current-origin place search sends optional coordinates only in a POST body", async () => {
  const product = await source("app/ProductApp.tsx");
  const searchOrigin =
    product.match(
      /async function searchOriginPlace\([\s\S]*?(?=\n  function selectOriginPlace)/,
    )?.[0] ?? "";

  assert.ok(searchOrigin, "searchOriginPlace source must be present");
  assert.match(searchOrigin, /purpose:\s*"current_origin"/);
  assert.match(searchOrigin, /parseKoreaCoordinate\(latitude,\s*32,\s*39\.8\)/);
  assert.match(searchOrigin, /parseKoreaCoordinate\(longitude,\s*124,\s*132\)/);
  assert.match(
    searchOrigin,
    /fetchJson\("\/api\/v1\/places\/search",\s*\{[\s\S]*?method:\s*"POST"/,
  );
  assert.match(searchOrigin, /body:\s*JSON\.stringify\(searchInput\)/);
  assert.match(searchOrigin, /latitude:\s*currentLatitude/);
  assert.match(searchOrigin, /longitude:\s*currentLongitude/);
  assert.doesNotMatch(
    searchOrigin,
    /query\.set\(\s*["'](?:latitude|longitude)["']/,
  );
  assert.doesNotMatch(
    searchOrigin,
    /\/api\/v1\/places\/search\?/,
  );
});

test("all eight KTO contracts are registered with nationwide source hooks", async () => {
  const [types, registry, adapters, health, capabilities] = await Promise.all([
    source("lib/kto/types.ts"),
    source("lib/kto/registry.ts"),
    source("lib/kto/adapters.ts"),
    source("lib/kto/health.ts"),
    source("app/api/v1/capabilities/route.ts"),
  ]);

  for (const service of EIGHT_KTO_SERVICES) {
    assert.match(types, new RegExp(`["']${service}["']`));
    assert.match(registry, new RegExp(`${service}\\s*:`));
    assert.match(health, new RegExp(`["']${service}["']`));
  }

  for (const operation of [
    "ldongCode2",
    "locationBasedList2",
    "searchKeyword2",
    "detailWithTour2",
    "areaBasedList1",
    "tatsCnctrRatedList",
    "areaTouDivList",
    "areaTarSjrnDsList",
    "areaTarSvcDemList",
  ]) {
    assert.match(`${registry}\n${adapters}`, new RegExp(operation));
  }
  for (const [parameter, code] of [
    ["touDivIxCd", "31"],
    ["expDivIxCd", "32"],
    ["intlDivIxCd", "33"],
    ["tarSjrnDsIxCd", "21"],
    ["tarExpDsIxCd", "22"],
    ["tarSvcDemIxCd", "11"],
    ["culResDemIxCd", "12"],
  ]) {
    assert.match(
      registry,
      new RegExp(`param:\\s*["']${parameter}["'][\\s\\S]{0,80}code:\\s*["']${code}["']`),
    );
  }

  assert.match(adapters, /fieldsUsed:/);
  assert.match(adapters, /analysisDistrictCode\(/);
  assert.match(adapters, /rawDistrictCode\(/);
  assert.match(capabilities, /regionSource:\s*"KorService2\.ldongCode2"/);
});

test("official legal-dong codes normalize between TourAPI and analysis APIs", async () => {
  const {
    analysisRegionCode,
    analysisDistrictCode,
    districtBelongsToRegion,
    isOfficialRegionCode,
    isPlausibleOfficialDistrictCode,
    rawDistrictCode,
    previousCompleteMonth,
    priorMonth,
  } = await import("../lib/kto/registry.ts");

  assert.equal(analysisDistrictCode("11", "110"), "11110");
  assert.equal(analysisDistrictCode("11", "11110"), "11110");
  assert.equal(analysisDistrictCode("26", "350"), "26350");
  assert.equal(rawDistrictCode("11", "11110"), "110");
  assert.equal(rawDistrictCode("11", "110"), "110");
  assert.equal(rawDistrictCode("26", "26350"), "350");
  assert.equal(analysisRegionCode("36110"), "36");
  assert.equal(analysisDistrictCode("36110", undefined), "36110");
  assert.equal(analysisDistrictCode("36110", "36110"), "36110");
  assert.equal(rawDistrictCode("36110", "36110"), undefined);
  assert.equal(isOfficialRegionCode("36110"), true);
  assert.equal(isOfficialRegionCode("11"), true);
  assert.equal(isOfficialRegionCode("99"), false);
  assert.equal(isOfficialRegionCode("99110"), false);
  assert.equal(isOfficialRegionCode("3611"), false);
  assert.equal(isPlausibleOfficialDistrictCode("11110"), true);
  assert.equal(isPlausibleOfficialDistrictCode("99110"), false);
  assert.equal(districtBelongsToRegion("11", "11110"), true);
  assert.equal(districtBelongsToRegion("11", "26110"), false);
  assert.equal(analysisDistrictCode(undefined, "110"), undefined);
  assert.equal(rawDistrictCode(undefined, undefined), undefined);
  assert.equal(priorMonth("202601"), "202512");
  assert.match(previousCompleteMonth(new Date("2026-07-16T00:00:00Z")), /^202606$/);
});

test("recovery request schema enforces Korea bounds and hard input limits", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const itinerary = {
    title: "서울 하루 여행",
    timezone: "Asia/Seoul",
    audience: "general",
    occurredAt: "2026-07-16T10:30:00+09:00",
    disruptedNodeId: "current_visit",
    nextFixedNodeId: "fixed_lunch",
    nodes: [
      {
        id: "current_visit",
        sequence: 0,
        type: "visit",
        title: "현재 관람",
        startAt: "2026-07-16T10:00:00+09:00",
        locked: false,
        reservation: false,
      },
      {
        id: "fixed_lunch",
        sequence: 1,
        type: "reservation",
        title: "예약 식사",
        startAt: "2026-07-16T12:30:00+09:00",
        locked: true,
        reservation: true,
        location: {
          latitude: 37.57,
          longitude: 126.99,
          label: "예약 장소",
          areaCode: "11",
          sigunguCode: "11140",
        },
      },
    ],
  };
  const valid = {
    origin: {
      latitude: 37.5665,
      longitude: 126.978,
      label: "서울광장",
      areaCode: "11",
      sigunguCode: "11140",
    },
    incident: "delay",
    availableMinutes: 60,
    maxDistanceMeters: 3_000,
    audience: "general",
    indoorOnly: false,
    radiusMeters: 5_000,
    analyticsConsent: false,
    itinerary,
  };

  assert.equal(recoveryRequestSchema.safeParse(valid).success, true);
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: {
        ...valid.origin,
        areaCode: "36110",
        sigunguCode: "36110",
      },
    }).success,
    true,
  );
  const withoutItinerary = { ...valid };
  delete withoutItinerary.itinerary;
  assert.equal(
    recoveryRequestSchema.safeParse(withoutItinerary).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: { ...valid.origin, latitude: 31.9 },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: { ...valid.origin, longitude: 132.1 },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({ ...valid, availableMinutes: 14 }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({ ...valid, maxDistanceMeters: 20_001 })
      .success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({ ...valid, incident: "earthquake" })
      .success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: { ...valid.origin, areaCode: "6" },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: { ...valid.origin, sigunguCode: "350" },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: { ...valid.origin, areaCode: "KR" },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: { ...valid.origin, areaCode: "99" },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: {
        ...valid.origin,
        areaCode: "11",
        sigunguCode: "26110",
      },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...valid,
      origin: {
        ...valid.origin,
        areaCode: undefined,
        sigunguCode: "11110",
      },
    }).success,
    false,
  );
});

test("registered itinerary requires an unlocked disruption and a future fixed appointment", async () => {
  const {
    itineraryRegistrationSchema,
    recoveryRequestSchema,
  } = await import("../lib/recovery/schema.ts");
  const nodes = [
    {
      id: "current_visit",
      sequence: 0,
      type: "visit",
      title: "현재 관람",
      startAt: "2026-07-16T10:00:00+09:00",
      endAt: "2026-07-16T11:00:00+09:00",
      durationMinutes: 60,
      locked: false,
      reservation: false,
      location: {
        latitude: 37.5665,
        longitude: 126.978,
        label: "서울광장",
        areaCode: "11",
        sigunguCode: "11140",
      },
    },
    {
      id: "fixed_lunch",
      sequence: 1,
      type: "reservation",
      title: "예약 식사",
      startAt: "2026-07-16T12:30:00+09:00",
      endAt: "2026-07-16T13:30:00+09:00",
      locked: true,
      reservation: true,
      location: {
        latitude: 37.57,
        longitude: 126.99,
        label: "예약 장소",
        areaCode: "11",
        sigunguCode: "11140",
      },
    },
  ];
  const registration = {
    title: "서울 하루 여행",
    timezone: "Asia/Seoul",
    audience: "general",
    nodes,
  };
  assert.equal(
    itineraryRegistrationSchema.safeParse(registration).success,
    true,
  );

  const request = {
    origin: nodes[0].location,
    incident: "delay",
    availableMinutes: 120,
    maxDistanceMeters: 3_000,
    audience: "general",
    indoorOnly: false,
    radiusMeters: 5_000,
    itinerary: {
      ...registration,
      occurredAt: "2026-07-16T10:30:00+09:00",
      disruptedNodeId: "current_visit",
      nextFixedNodeId: "fixed_lunch",
    },
  };
  assert.equal(recoveryRequestSchema.safeParse(request).success, true);
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...request,
      itinerary: {
        ...request.itinerary,
        disruptedNodeId: "fixed_lunch",
      },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...request,
      itinerary: {
        ...request.itinerary,
        occurredAt: "2026-07-16T13:00:00+09:00",
      },
    }).success,
    false,
  );
  assert.equal(
    recoveryRequestSchema.safeParse({
      ...request,
      itinerary: {
        ...request.itinerary,
        nodes: [
          { ...nodes[0], sequence: 2 },
          { ...nodes[1], sequence: 1 },
        ],
      },
    }).success,
    false,
  );
});

test("geo estimates are deterministic, conservative, and bucketed", async () => {
  const {
    conservativeWalkingMinutes,
    distanceBucket,
    haversineMeters,
    minutesBucket,
  } = await import("../lib/geo.ts");

  assert.equal(
    haversineMeters(
      { latitude: 37.5665, longitude: 126.978 },
      { latitude: 37.5665, longitude: 126.978 },
    ),
    0,
  );
  const seoulToBusan = haversineMeters(
    { latitude: 37.5665, longitude: 126.978 },
    { latitude: 35.1796, longitude: 129.0756 },
  );
  assert.ok(seoulToBusan > 320_000 && seoulToBusan < 340_000);
  assert.equal(conservativeWalkingMinutes(0), 4);
  assert.equal(conservativeWalkingMinutes(600), 14);
  assert.equal(distanceBucket(499), "0-499m");
  assert.equal(distanceBucket(500), "500-999m");
  assert.equal(minutesBucket(30), "16-30m");
  assert.equal(minutesBucket(31), "31-60m");
});

test("mocked OpenAPI recovery preserves hard-constraint monotonicity and redacts the key", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  const fakeKey = "test-only-kto-key-never-return";
  const outboundUrls = [];

  process.env.KTO_SERVICE_KEY = fakeKey;
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    outboundUrls.push(url.href);

    const [, service, operation] = url.pathname.match(
      /\/B551011\/([^/]+)\/([^/]+)$/,
    ) ?? [];
    let items = [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      items = [
        {
          contentid: "A",
          contenttypeid: "14",
          title: "실내 문화관",
          addr1: "서울특별시",
          mapx: "126.979",
          mapy: "37.567",
          dist: "200",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260701",
        },
        {
          contentid: "B",
          contenttypeid: "12",
          title: "도심 공원",
          addr1: "서울특별시",
          mapx: "126.982",
          mapy: "37.568",
          dist: "600",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260701",
        },
        {
          contentid: "C",
          contenttypeid: "38",
          title: "지역 상점가",
          addr1: "서울특별시",
          mapx: "126.99",
          mapy: "37.57",
          dist: "1500",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260701",
        },
        {
          contentid: "D",
          contenttypeid: "12",
          title: "강변 산책로",
          addr1: "서울특별시",
          mapx: "127.01",
          mapy: "37.58",
          dist: "3500",
          lDongRegnCd: "11",
          lDongSignguCd: "110",
          modifiedtime: "20260701",
        },
      ];
    } else if (
      service === "TarRlteTarService1" &&
      operation === "areaBasedList1"
    ) {
      items = [
        { rlteTatsNm: "지역 상점가", rlteRank: "1", baseYm: "202606" },
        { rlteTatsNm: "실내 문화관", rlteRank: "2", baseYm: "202606" },
      ];
    } else if (
      service === "TatsCnctrRateService" &&
      operation === "tatsCnctrRatedList"
    ) {
      items = [
        { tAtsNm: "실내 문화관", cnctrRate: "35", baseYmd: "20260720" },
        { tAtsNm: "도심 공원", cnctrRate: "45", baseYmd: "20260720" },
        { tAtsNm: "지역 상점가", cnctrRate: "55", baseYmd: "20260720" },
      ];
    }

    return new Response(JSON.stringify(ktoEnvelope(items)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const { callKto } = await import("../lib/kto/client.ts");
    const { recoverTrip } = await import("../lib/recovery/engine.ts");

    const direct = await callKto(
      "KorService2",
      "locationBasedList2",
      { mapX: 126.978, mapY: 37.5665, radius: 5_000 },
      { retry: false },
    );
    assert.equal(JSON.stringify(direct).includes(fakeKey), false);

    const baseRequest = {
      origin: {
        latitude: 37.5665,
        longitude: 126.978,
        label: "서울광장",
        areaCode: "11",
        sigunguCode: "11110",
      },
      incident: "delay",
      availableMinutes: 120,
      maxDistanceMeters: 4_000,
      audience: "general",
      indoorOnly: false,
      radiusMeters: 5_000,
      analyticsConsent: false,
    };
    const loose = await recoverTrip(baseRequest, "request-loose");
    const distanceTight = await recoverTrip(
      { ...baseRequest, maxDistanceMeters: 1_000 },
      "request-distance-tight",
    );
    const timeTight = await recoverTrip(
      { ...baseRequest, availableMinutes: 15 },
      "request-time-tight",
    );
    const indoorTight = await recoverTrip(
      { ...baseRequest, indoorOnly: true },
      "request-indoor-tight",
    );

    assert.equal(loose.scope.coverage, "nationwide");
    assert.ok(distanceTight.options.length <= loose.options.length);
    assert.ok(timeTight.options.length <= loose.options.length);
    assert.ok(indoorTight.options.length <= loose.options.length);
    assert.ok(
      indoorTight.options.every((option) =>
        ["14", "38", "39"].includes(option.contentTypeId),
      ),
    );
    assert.ok(
      indoorTight.rejectionSummary.some(
        (entry) =>
          entry.reasonCode === "INDOOR_UNVERIFIED" &&
          entry.count >= 1,
      ),
    );
    const accessibilityConditional = await recoverTrip(
      { ...baseRequest, audience: "wheelchair" },
      "request-accessibility-conditional",
    );
    assert.ok(
      accessibilityConditional.options.every(
        (option) =>
          option.confirmationRequired ===
          (option.evidenceGaps.length > 0),
      ),
    );
    if (
      accessibilityConditional.options.some(
        (option) => option.confirmationRequired,
      )
    ) {
      assert.notEqual(accessibilityConditional.status, "verified");
    }
    assert.ok(distanceTight.rejectedCount >= loose.rejectedCount);
    assert.ok(timeTight.rejectedCount >= loose.rejectedCount);
    assert.equal(
      JSON.stringify([loose, distanceTight, timeTight, indoorTight]).includes(
        fakeKey,
      ),
      false,
    );
    assert.ok(outboundUrls.length > 0);
    assert.ok(outboundUrls.every((url) => url.startsWith("https://apis.data.go.kr/B551011/")));
    assert.ok(outboundUrls.some((url) => new URL(url).searchParams.get("serviceKey") === fakeKey));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = originalKey;
  }
});

test("KTO client normalizes one-item and empty envelopes without exposing request secrets", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  const fakeKey = "test-only-envelope-key";
  let responseMode = "single";
  process.env.KTO_SERVICE_KEY = fakeKey;
  globalThis.fetch = async () => {
    const item =
      responseMode === "single"
        ? { code: "11", name: "서울특별시", modifiedtime: "20260701" }
        : undefined;
    return new Response(
      JSON.stringify({
        response: {
          header: { resultCode: "0000", resultMsg: "OK" },
          body: {
            items: item ? { item } : "",
            totalCount: item ? 1 : 0,
            pageNo: 1,
            numOfRows: 1,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const { callKto } = await import("../lib/kto/client.ts");
    const single = await callKto(
      "KorService2",
      "ldongCode2",
      { pageNo: 1, numOfRows: 1 },
      { retry: false },
    );
    assert.equal(single.items.length, 1);
    assert.equal(single.items[0].code, "11");
    assert.equal(single.audit.status, "live");
    assert.equal(JSON.stringify(single).includes(fakeKey), false);

    responseMode = "empty";
    const empty = await callKto(
      "KorService2",
      "ldongCode2",
      { pageNo: 1, numOfRows: 1 },
      { retry: false },
    );
    assert.deepEqual(empty.items, []);
    assert.equal(empty.totalCount, 0);
    assert.equal(empty.audit.status, "empty");
    assert.equal(JSON.stringify(empty).includes(fakeKey), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = originalKey;
  }
});

test("upstream KTO failure returns an honest empty recovery instead of fallback candidates", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  process.env.KTO_SERVICE_KEY = "test-only-upstream-failure-key";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "upstream unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });

  try {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const result = await recoverTrip(
      {
        origin: {
          latitude: 37.5665,
          longitude: 126.978,
          label: "서울광장",
          areaCode: "11",
          sigunguCode: "11110",
        },
        incident: "delay",
        availableMinutes: 60,
        maxDistanceMeters: 3_000,
        audience: "general",
        indoorOnly: false,
        radiusMeters: 5_000,
        analyticsConsent: false,
      },
      "request-upstream-failure",
    );

    assert.equal(result.status, "upstream_unavailable");
    assert.deepEqual(result.options, []);
    assert.equal(result.rejectedCount, 0);
    assert.equal(result.scope.coverage, "nationwide");
    assert.ok(
      result.sourceLedger.some(
        (entry) =>
          entry.apiName === "KorService2" &&
          entry.operation === "locationBasedList2" &&
          entry.status === "error",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = originalKey;
  }
});

test("persistence schema stores generalized recovery evidence, expiry, and hashed shares", async () => {
  const [schema, migration, repository, sync, privacyRoute] = await Promise.all([
    source("db/schema.ts"),
    source("drizzle/0000_wild_star_brand.sql"),
    source("lib/db/repository.ts"),
    source("lib/sync/policy-sync.ts"),
    source("app/api/v1/privacy/session/route.ts"),
  ]);

  assert.match(schema, /timeBudgetBucket:\s*text\("time_budget_bucket"\)/);
  assert.match(schema, /distanceBucket:\s*text\("distance_bucket"\)/);
  assert.match(schema, /expiresAt:\s*text\("expires_at"\)\.notNull\(\)/);
  assert.match(schema, /tokenHash:\s*text\("token_hash"\)\.notNull\(\)/);
  assert.doesNotMatch(schema, /token:\s*text\("token"\)/);
  assert.doesNotMatch(repository, /params\.input\.origin\.(?:latitude|longitude)/);
  assert.doesNotMatch(repository, /inputJson|originJson|exactLocation/);
  assert.match(repository, /tokenHash\s*=\s*await sha256\(token\)/);
  assert.match(repository, /deleteSessionData/);
  assert.match(privacyRoute, /export async function DELETE/);
  assert.match(privacyRoute, /deleteSessionData\(sessionId\)/);
  assert.match(sync, /export async function purgeExpiredData/);
  assert.match(sync, /\.delete\(proofShares\)/);
  assert.match(sync, /\.delete\(recoveryRuns\)/);
  assert.match(sync, /\.delete\(sessions\)/);
  assert.match(sync, /await purgeExpiredData\(\)/);

  const recoveryRunsSql =
    migration.match(/CREATE TABLE `recovery_runs` \(([\s\S]*?)\);/)?.[1] ?? "";
  const recoveryOptionsSql =
    migration.match(/CREATE TABLE `recovery_options` \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.ok(recoveryRunsSql);
  assert.ok(recoveryOptionsSql);
  assert.doesNotMatch(recoveryRunsSql, /latitude|longitude|mapx|mapy|origin_json/i);
  assert.doesNotMatch(recoveryOptionsSql, /latitude|longitude|mapx|mapy/i);
  assert.match(migration, /`token_hash` text NOT NULL/);
  assert.match(migration, /`expires_at` text NOT NULL/);
});

test("real KTO decoding key is absent from production sources, fixtures, and rendered output", async () => {
  const sanitizer = await source("scripts/sanitize-build.mjs");
  assert.match(sanitizer, /"OPS_API_KEY"/);
  assert.match(sanitizer, /providerUrlNames/);
  assert.match(sanitizer, /entry\.name\.startsWith\("\.env"\)/);
  const envText = await source(".env.local").catch(() => "");
  const match = envText.match(/^\s*KTO_SERVICE_KEY\s*=\s*(.+?)\s*$/m);
  const decodingKey = match?.[1]?.replace(/^['"]|['"]$/g, "");
  if (!decodingKey) return;

  const candidateFiles = (
    await Promise.all(
      ["app", "lib", "db", "worker", "tests", "dist"].map((directory) =>
        sourceFiles(directory),
      ),
    )
  ).flat();
  const contents = await Promise.all(candidateFiles.map((file) => source(file)));
  contents.push(
    await source(".env.example").catch(() => ""),
    await source(".env.production.example").catch(() => ""),
  );
  assert.ok(
    contents.every((content) => !content.includes(decodingKey)),
    "A production source or test fixture contains the configured KTO key.",
  );

  const response = await renderHome();
  const html = await response.text();
  assert.ok(
    !html.includes(decodingKey),
    "The server-rendered HTML contains the configured KTO key.",
  );
});

test("a not-ready readiness response is read as a state, never as a failed request", async () => {
  const product = await source("app/ProductApp.tsx");
  const loadHealth =
    product.match(
      /async function loadHealth\(\)[\s\S]*?(?=\r?\n  async function shareRecoveryOption)/,
    )?.[0] ?? "";

  assert.ok(loadHealth, "loadHealth source must be present");
  /* /api/v1/health/ready answers 503 whenever overall !== "ready". Routing it
     through the throw-on-non-OK helper turned an ordinary degraded state into
     a total failure of the transparency tab. */
  assert.doesNotMatch(loadHealth, /fetchJson\(\s*["']\/api\/v1\/health\/ready/);
  assert.match(loadHealth, /fetch\(\s*["']\/api\/v1\/health\/ready["']/);
  assert.match(loadHealth, /response\.json\(\)\.catch\(\(\)\s*=>\s*null\)/);
  /* The readiness contract is the presence of `overall`, not the status code. */
  assert.match(loadHealth, /readText\(payload,\s*\["overall",\s*"status"\]\)/);
  assert.doesNotMatch(loadHealth, /response\.ok/);
});

test("failing to load the check never renders the eight KTO services as errored", async () => {
  const product = await source("app/ProductApp.tsx");
  const badge =
    product.match(
      /const currentStatus =[\s\S]*?;\r?\n/,
    )?.[0] ?? "";

  assert.ok(badge, "source status selection must be present");
  /* "we could not read the check" and "the agency API errored" are different
     facts about a third party. Only the first one is ours to report. */
  assert.doesNotMatch(badge, /healthState === "error"\s*\?\s*"error"/);
  assert.match(badge, /healthState === "error"\s*\?\s*"unknown"/);

  const { statusTone, statusLabel } = await import("../lib/text/status-labels.ts");
  assert.equal(statusTone("unknown"), "warn");
  assert.notEqual(statusTone("unknown"), "bad");
  assert.equal(statusLabel("unknown"), "확인 필요");
});

test("the official region codes match the list the agency actually serves", async () => {
  const { KTO_OFFICIAL_REGION_CODES, isOfficialRegionCode } = await import(
    "../lib/kto/registry.ts"
  );
  const codes = new Set(KTO_OFFICIAL_REGION_CODES);

  /* 2026년 개편으로 광주광역시(29)와 전라남도(46)는 전남광주통합특별시(12)로
     합쳐졌다. 이 상수가 옛 코드를 들고 있으면 두 가지가 함께 깨진다.
     장소 검색이 돌려준 12 좌표를 일정 스키마가 거절해 해당 지역 이용자가
     일정을 저장할 수 없고, 전국 집계 검사는 존재하지 않는 코드를 기다린다. */
  assert.ok(codes.has("12"), "전남광주통합특별시 코드가 있어야 한다");
  assert.ok(!codes.has("29"), "폐지된 광주광역시 코드가 남아 있으면 안 된다");
  assert.ok(!codes.has("46"), "폐지된 전라남도 코드가 남아 있으면 안 된다");
  assert.equal(codes.size, KTO_OFFICIAL_REGION_CODES.length, "중복이 없어야 한다");

  /* 장소 검색이 실제로 돌려주는 형태가 그대로 통과해야 한다. */
  assert.ok(isOfficialRegionCode("12"));
  assert.ok(isOfficialRegionCode("12300"));
  assert.ok(!isOfficialRegionCode("29"));
});
