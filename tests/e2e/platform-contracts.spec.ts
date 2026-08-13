import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import {
  PLAYWRIGHT_D1_FIXTURE,
  createPlaywrightSessionCookie,
} from "../../scripts/playwright-d1-fixture.mjs";

const PARTNER_PORT = 4195;
const APP_ORIGIN = "http://127.0.0.1:4192";
const E2E_SESSION_SIGNING_KEY = "ieoga-ci-only-session-key-000001";

let partnerServer: Server;

test.beforeAll(async () => {
  partnerServer = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
      <html lang="ko"><head><title>Partner fixture</title></head>
      <body><main><h1>Partner host</h1>
        <iframe
          title="이어가 복구 위젯"
          allow="geolocation"
          src="${APP_ORIGIN}/embed/recover?host=Partner&lat=37.5759&lng=126.9768&area=11&sigungu=11110">
        </iframe>
      </main></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    partnerServer.once("error", reject);
    partnerServer.listen(PARTNER_PORT, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    partnerServer.close((error) => (error ? reject(error) : resolve()));
  });
});

for (const route of ["/app", "/plan", "/embed/demo", "/embed/recover"] as const) {
  test(`${route} is accessible and does not overflow`, async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("ieoga-simulation-guide-seen-v1", "seen");
    });
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(Math.max(widths.document, widths.body), JSON.stringify(widths)).toBeLessThanOrEqual(
      widths.viewport + 1,
    );
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations
        .filter(
          (violation) =>
            violation.id === "color-contrast" ||
            violation.impact === "serious" ||
            violation.impact === "critical",
        )
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          targets: violation.nodes.flatMap((node) => node.target),
        })),
    ).toEqual([]);
  });
}

test("security headers deny ordinary framing and allow only the configured widget host", async ({
  request,
}) => {
  const ordinary = await request.get("/app");
  expect(ordinary.headers()["x-frame-options"]).toBe("DENY");
  expect(ordinary.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  const widget = await request.get("/embed/recover");
  expect(widget.headers()["x-frame-options"]).toBeUndefined();
  expect(widget.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'self' http://127.0.0.1:4195",
  );

  const demo = await request.get("/embed/demo");
  expect(demo.headers()["content-security-policy"]).toContain("frame-src 'self'");
});

test("a separately hosted partner can render the allowlisted widget", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PARTNER_PORT}`, {
    waitUntil: "domcontentloaded",
  });
  const widget = page.frameLocator('iframe[title="이어가 복구 위젯"]');
  await expect(widget.getByRole("heading", { name: "갈 수 있는 곳" })).toBeVisible();
  await expect(widget.getByText("Partner × IEOGA")).toBeVisible();
});

test("cross-origin iframe uses a scoped bearer without any third-party cookie", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1280",
    "One real cross-origin network run is sufficient; browser coverage is an independently audited release artifact.",
  );
  await page.goto(`http://127.0.0.1:${PARTNER_PORT}`, {
    waitUntil: "domcontentloaded",
  });
  const widget = page.frameLocator('iframe[title="이어가 복구 위젯"]');
  await expect(widget.getByRole("button", { name: "다녀올 수 있는 곳 찾기" })).toBeEnabled();

  // Force a deterministic scope denial after token verification. This proves
  // the real cross-origin bootstrap→bearer→recover path without making the
  // security contract test depend on live KTO availability or quota.
  await page.route("**/api/v1/recover", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({
      postData: JSON.stringify({ ...body, analyticsConsent: true }),
    });
  });
  let presentedBearer = "";
  page.on("request", (outgoing) => {
    if (
      outgoing.method() === "POST" &&
      new URL(outgoing.url()).pathname === "/api/v1/recover"
    ) {
      presentedBearer = outgoing.headers()["x-ieoga-embed-session"] ?? "";
    }
  });
  const bootstrapPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/embed/session",
  );
  const recoveryPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/recover",
    { timeout: 30_000 },
  );
  await widget.getByRole("button", { name: "다녀올 수 있는 곳 찾기" }).click();
  const [bootstrap, recovery] = await Promise.all([
    bootstrapPromise,
    recoveryPromise,
  ]);
  expect(bootstrap.status()).toBe(200);
  expect(bootstrap.headers()["set-cookie"]).toBeUndefined();
  expect(presentedBearer).toMatch(/^ev1\./);
  expect(recovery.status()).toBe(403);
  expect(recovery.headers()["set-cookie"]).toBeUndefined();
  const recoveryBody = await recovery.json();
  expect(recoveryBody.error?.code).toBe("EMBED_SESSION_SCOPE_VIOLATION");
  await page.unroute("**/api/v1/recover");

  const replacement = presentedBearer.endsWith("x") ? "y" : "x";
  const tampered = `${presentedBearer.slice(0, -1)}${replacement}`;
  const denied = await request.post("/api/v1/recover", {
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "X-IEOGA-Embed-Session": tampered,
    },
  });
  expect(denied.status()).toBe(401);
  expect(denied.headers()["set-cookie"]).toBeUndefined();
  expect((await denied.json()).error?.code).toBe("INVALID_EMBED_SESSION");
});

test("a local runtime assertion alone can never impersonate a release build", async ({ request }) => {
  const response = await request.get("/api/v1/release/version");
  expect(response.status()).toBe(503);
  const body = await response.json();
  expect(body.commitSha).toBeNull();
  expect(body.releaseReady).toBe(false);
  expect(body.releaseBuild).toBe(false);
  expect(body.source).toBe(
    "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION",
  );
});

test("place search never accepts travel keywords or coordinates in a URL", async ({
  request,
}) => {
  const leakedQuery = await request.get(
    "/api/v1/places/search?keyword=%EA%B4%91%ED%99%94%EB%AC%B8&latitude=37.5759&longitude=126.9768",
  );
  expect(leakedQuery.status()).toBe(405);
  expect(leakedQuery.headers()["allow"]).toBe("POST");
  expect(leakedQuery.headers()["cache-control"]).toContain("no-store");
  expect((await leakedQuery.json()).error?.code).toBe(
    "SENSITIVE_QUERY_PARAMETERS_FORBIDDEN",
  );

  // The media-type boundary is independent of payload parsing. An empty body
  // also avoids a Windows Miniflare loopback defect triggered by rejecting an
  // unread streamed body before the following D1 request.
  const wrongMediaType = await request.post("/api/v1/places/search", {
    headers: { "Content-Type": "text/plain" },
  });
  expect(wrongMediaType.status()).toBe(415);
  expect((await wrongMediaType.json()).error?.code).toBe(
    "JSON_CONTENT_TYPE_REQUIRED",
  );
});

function itinerary(
  nodes: Array<Record<string, unknown>>,
  id = "e2e-itinerary-contract",
) {
  return {
    itinerary: {
      id,
      title: "E2E itinerary contract",
      timezone: "Asia/Seoul",
      audience: "general",
      nodes,
    },
    analyticsConsent: false,
  };
}

function node(
  id: string,
  sequence: number,
  startAt: string,
  locked: boolean,
) {
  return {
    id,
    sequence,
    type: locked ? "reservation" : "visit",
    title: locked ? "다음 예약" : "바꿀 수 있는 일정",
    startAt,
    durationMinutes: 60,
    locked,
    reservation: locked,
    location: {
      latitude: 37.5759,
      longitude: 126.9768,
      label: "서울 종로구",
    },
  };
}

test("real D1 round-trip preserves mutable and locked itinerary contracts", async ({
  request,
}) => {
  const itineraryId = crypto.randomUUID();
  const mutableStartAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const lockedStartAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  const payload = itinerary(
    [
      node("mutable", 1, mutableStartAt, false),
      node("locked", 2, lockedStartAt, true),
    ],
    itineraryId,
  );

  const created = await request.post("/api/v1/itineraries", {
    headers: { Origin: APP_ORIGIN },
    data: payload,
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json();
  expect(createdBody.status).toBe("created");
  expect(createdBody.itinerary.id).toBe(itineraryId);

  // Production cookies are deliberately Secure, so an HTTP-only local
  // harness cannot persist them automatically. Reuse the exact signed cookie
  // issued by the POST; this keeps the request/session boundary real without
  // weakening the production cookie contract for E2E.
  const sessionCookie = created.headers()["set-cookie"]?.split(";", 1)[0];
  expect(sessionCookie).toMatch(/^ieoga_session=/);
  const loaded = await request.get("/api/v1/itineraries", {
    headers: { cookie: sessionCookie },
  });
  expect(loaded.status()).toBe(200);
  const loadedBody = await loaded.json();
  expect(loadedBody.status).toBe("available");
  const stored = loadedBody.itineraries.find(
    (entry: { id: string }) => entry.id === itineraryId,
  );
  expect(stored).toBeTruthy();
  expect(
    stored.nodes.map(
      (entry: {
        id: string;
        startAt: string;
        locked: boolean;
        reservation: boolean;
      }) => ({
        id: entry.id,
        startAt: entry.startAt,
        locked: entry.locked,
        reservation: entry.reservation,
      }),
    ),
  ).toEqual([
    {
      id: "mutable",
      startAt: mutableStartAt,
      locked: false,
      reservation: false,
    },
    {
      id: "locked",
      startAt: lockedStartAt,
      locked: true,
      reservation: true,
    },
  ]);
});

test("real itinerary API rejects time reversal, past schedules, and missing hard stops", async ({
  request,
}) => {
  const now = Date.now();
  const future1 = new Date(now + 60 * 60_000).toISOString();
  const future2 = new Date(now + 120 * 60_000).toISOString();
  const past1 = new Date(now - 48 * 60 * 60_000).toISOString();
  const past2 = new Date(now - 47 * 60 * 60_000).toISOString();
  const cases = [
    itinerary([
      node("mutable", 1, future2, false),
      node("locked", 2, future1, true),
    ]),
    itinerary([
      node("mutable", 1, past1, false),
      node("locked", 2, past2, true),
    ]),
    itinerary([
      node("mutable-1", 1, future1, false),
      node("mutable-2", 2, future2, false),
    ]),
  ];

  for (const data of cases) {
    const response = await request.post("/api/v1/itineraries", {
      headers: { Origin: APP_ORIGIN },
      data,
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error?.code).toBe("INVALID_ITINERARY");
    expect(body.error?.fields?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/(?:SELECT|INSERT|UPDATE|DELETE)\s/i);
  }
});

function fixtureMutationHeaders(sessionId: string) {
  return {
    Origin: APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    cookie: createPlaywrightSessionCookie(
      sessionId,
      E2E_SESSION_SIGNING_KEY,
    ),
  };
}

test("real D1 enforces protected apply, share, idempotency, and concurrent finalization", async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-360",
    "The startup fixture is intentionally single-use across the shared D1 process.",
  );
  const headers = fixtureMutationHeaders(
    PLAYWRIGHT_D1_FIXTURE.primarySessionId,
  );
  const applyPath = (runId: string) =>
    `/api/v1/recover/${runId}/apply`;

  const appliedA = await request.post(
    applyPath(PLAYWRIGHT_D1_FIXTURE.runA),
    {
      headers,
      data: { optionId: PLAYWRIGHT_D1_FIXTURE.optionA },
    },
  );
  const appliedAText = await appliedA.text();
  expect(appliedA.status(), appliedAText).toBe(201);
  const bodyA = JSON.parse(appliedAText);
  expect(bodyA.status).toBe("activated");
  expect(bodyA.execution.status).toBe("active");

  const idempotentA = await request.post(
    applyPath(PLAYWRIGHT_D1_FIXTURE.runA),
    {
      headers,
      data: { optionId: PLAYWRIGHT_D1_FIXTURE.optionA },
    },
  );
  expect(idempotentA.status()).toBe(201);
  expect((await idempotentA.json()).execution.id).toBe(bodyA.execution.id);

  const appliedB = await request.post(
    applyPath(PLAYWRIGHT_D1_FIXTURE.runB),
    {
      headers,
      data: { optionId: PLAYWRIGHT_D1_FIXTURE.optionB },
    },
  );
  expect(appliedB.status()).toBe(201);
  const bodyB = await appliedB.json();
  expect(bodyB.execution.id).not.toBe(bodyA.execution.id);
  expect(bodyB.execution.steps).toHaveLength(1);

  const revivedA = await request.post(
    applyPath(PLAYWRIGHT_D1_FIXTURE.runA),
    {
      headers,
      data: { optionId: PLAYWRIGHT_D1_FIXTURE.optionA },
    },
  );
  expect(revivedA.status()).toBe(409);
  expect((await revivedA.json()).error?.code).toBe("INVALID_STATE");

  const active = await request.get("/api/v1/journey/active", {
    headers: { cookie: headers.cookie },
  });
  expect(active.status()).toBe(200);
  expect((await active.json()).execution.id).toBe(bodyB.execution.id);

  const shared = await request.post("/api/v1/share", {
    headers,
    data: {
      runId: PLAYWRIGHT_D1_FIXTURE.runB,
      optionId: PLAYWRIGHT_D1_FIXTURE.optionB,
    },
  });
  expect(shared.status()).toBe(200);
  const sharedBody = await shared.json();
  expect(sharedBody.status).toBe("created");
  expect(sharedBody.proof.shareExpiresAt).toBe(sharedBody.expiresAt);
  const token = new URL(sharedBody.url, APP_ORIGIN).pathname.split("/").at(-1);
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  const proofPath = `/api/v1/share/${token}`;
  const loadedProof = await request.get(proofPath);
  expect(loadedProof.status()).toBe(200);
  expect((await loadedProof.json()).proof.schema).toBe(
    "urn:ieoga:recovery-proof:v2",
  );
  const revokedProof = await request.delete(proofPath, { headers });
  expect(revokedProof.status()).toBe(200);
  expect((await request.get(proofPath)).status()).toBe(404);

  const stepId = bodyB.execution.steps[0].id as string;
  const [arrival, abandon] = await Promise.all([
    request.patch("/api/v1/journey/active", {
      headers,
      data: { action: "arrive_step", stepId },
    }),
    request.patch("/api/v1/journey/active", {
      headers,
      data: { action: "abandon", reasonCode: "E2E_CONCURRENT" },
    }),
  ]);
  const statuses = [arrival.status(), abandon.status()].sort((a, b) => a - b);
  expect(statuses[0]).toBe(200);
  expect([404, 409]).toContain(statuses[1]);

  const afterRace = await request.get("/api/v1/journey/active", {
    headers: { cookie: headers.cookie },
  });
  expect(afterRace.status()).toBe(200);
  expect(await afterRace.json()).toMatchObject({
    status: "empty",
    execution: null,
  });
  const staleArrival = await request.patch("/api/v1/journey/active", {
    headers,
    data: { action: "arrive_step", stepId },
  });
  expect(staleArrival.status()).toBe(404);

  const historicalShare = await request.post("/api/v1/share", {
    headers,
    data: {
      runId: PLAYWRIGHT_D1_FIXTURE.runB,
      optionId: PLAYWRIGHT_D1_FIXTURE.optionB,
    },
  });
  expect(historicalShare.status()).toBe(200);
  const historicalProof = (await historicalShare.json()).proof;
  expect(historicalProof.proofKind).toBe("historical_execution");
  expect(historicalProof.actionability).toBe(
    "historical_not_actionable",
  );
  expect(["completed", "abandoned"]).toContain(
    historicalProof.execution?.status,
  );

  const stale = await request.post(
    applyPath(PLAYWRIGHT_D1_FIXTURE.staleRun),
    {
      headers,
      data: { optionId: PLAYWRIGHT_D1_FIXTURE.staleOption },
    },
  );
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error?.code).toBe("INVALID_STATE");
});

test("real D1 preserves contract_missed while separately recording abandonment and rejects expiry", async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-360",
    "The startup fixture is intentionally single-use across the shared D1 process.",
  );
  const lateHeaders = fixtureMutationHeaders(
    PLAYWRIGHT_D1_FIXTURE.lateSessionId,
  );
  const lateArrival = await request.patch("/api/v1/journey/active", {
    headers: lateHeaders,
    data: {
      action: "arrive_step",
      stepId: PLAYWRIGHT_D1_FIXTURE.lateCurrentStepId,
    },
  });
  expect(lateArrival.status()).toBe(200);
  const missed = await lateArrival.json();
  expect(missed.status).toBe("contract_missed");
  expect(missed.execution.contractMissedAt).toEqual(expect.any(String));
  expect(missed.execution.contractMetAt).toBeUndefined();
  expect(missed.execution.completedAt).toBeUndefined();
  expect(missed.execution.currentStepSequence).toBe(1);

  const terminated = await request.patch("/api/v1/journey/active", {
    headers: lateHeaders,
    data: { action: "abandon", reasonCode: "E2E_AFTER_MISSED_CONTRACT" },
  });
  expect(terminated.status()).toBe(200);
  const abandoned = await terminated.json();
  expect(abandoned.status).toBe("abandoned");
  expect(abandoned.execution.contractMissedAt).toBe(
    missed.execution.contractMissedAt,
  );
  expect(abandoned.execution.contractMetAt).toBeUndefined();
  expect(abandoned.execution.completedAt).toBeUndefined();

  const noLongerActive = await request.get("/api/v1/journey/active", {
    headers: { cookie: lateHeaders.cookie },
  });
  expect(await noLongerActive.json()).toMatchObject({
    status: "empty",
    execution: null,
  });

  const expiredHeaders = fixtureMutationHeaders(
    PLAYWRIGHT_D1_FIXTURE.expiredSessionId,
  );
  const expiredGet = await request.get("/api/v1/journey/active", {
    headers: { cookie: expiredHeaders.cookie },
  });
  expect(await expiredGet.json()).toMatchObject({
    status: "empty",
    execution: null,
  });
  const expiredArrival = await request.patch("/api/v1/journey/active", {
    headers: expiredHeaders,
    data: {
      action: "arrive_step",
      stepId: PLAYWRIGHT_D1_FIXTURE.expiredCurrentStepId,
    },
  });
  expect(expiredArrival.status()).toBe(404);
});
