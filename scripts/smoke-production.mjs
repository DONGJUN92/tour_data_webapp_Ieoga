import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../tests/alias-loader.mjs", import.meta.url));

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.SMOKE_PORT ?? 4185);
const baseUrl = `http://127.0.0.1:${port}`;
const cookieJar = new Map();

function parseEnv(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );
}

function koreaSchedule() {
  const toKoreaIso = (value) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(value);
    const fields = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:00+09:00`;
  };
  const disrupted = new Date(Date.now() + 30 * 60_000);
  const occurred = new Date(disrupted.getTime() + 10 * 60_000);
  const fixed = new Date(disrupted.getTime() + 180 * 60_000);
  return {
    occurredAt: toKoreaIso(occurred),
    disruptedAt: toKoreaIso(disrupted),
    fixedAt: toKoreaIso(fixed),
  };
}

function updateCookies(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookieJar.set(
        pair.slice(0, separator),
        pair.slice(separator + 1),
      );
    }
  }
}

async function request(pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (cookieJar.size) {
    headers.set(
      "Cookie",
      [...cookieJar.entries()]
        .map(([key, value]) => `${key}=${value}`)
        .join("; "),
    );
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  updateCookies(response);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`local production server did not start\n${output}`));
    }, 45_000);
    const inspect = (chunk) => {
      output += chunk.toString();
      if (output.includes(`Ready on http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `local production server exited with ${code}\n${output}`,
        ),
      );
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

const child = spawn(
  process.execPath,
  [
    "scripts/start-production-local.mjs",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
  ],
  {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);

try {
  await waitForReady(child);
  const env = parseEnv(
    await readFile(path.join(root, ".env.local"), "utf8").catch(() => ""),
  );

  const home = await request("/");
  assert.equal(home.response.status, 200);
  assert.match(home.body, /처음 사용 가이드/);
  assert.match(home.body, /전국/);
  assert.doesNotMatch(home.body, /name="latitude"/);

  const capabilities = await request("/api/v1/capabilities");
  assert.equal(capabilities.response.status, 200);
  assert.equal(capabilities.body.scope, "nationwide");
  assert.equal(
    capabilities.body.travelerRecovery.placeSearch
      .manualCoordinatesRequired,
    false,
  );
  assert.deepEqual(
    capabilities.body.policyInsights.missionLoop.failureCategories,
    [
      "content_gap",
      "data_gap",
      "operating_hours_gap",
      "mobility_gap",
    ],
  );

  let healthRefresh = null;
  if (env.OPS_API_KEY) {
    healthRefresh = await request("/api/v1/ops/health/refresh", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPS_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 90_000,
    });
    assert.ok([200, 503].includes(healthRefresh.response.status));
    assert.equal(healthRefresh.body.sources?.length, 8);
  }

  const placeSearch = await request(
    `/api/v1/places/search?keyword=${encodeURIComponent(
      "서울역사박물관",
    )}&purpose=saved_stop&fallback=auto`,
    { timeoutMs: 30_000 },
  );
  assert.equal(placeSearch.response.status, 200);
  assert.ok(placeSearch.body.places?.length > 0);
  const firstPlace = placeSearch.body.places.find(
    (place) => place.retention === "persistable",
  );
  assert.ok(firstPlace);

  const fixedSearch = await request(
    `/api/v1/places/search?keyword=${encodeURIComponent(
      "세종문화회관",
    )}&purpose=saved_stop&fallback=auto`,
    { timeoutMs: 30_000 },
  );
  assert.equal(fixedSearch.response.status, 200);
  const fixedPlace = fixedSearch.body.places?.find(
    (place) => place.retention === "persistable",
  );
  assert.ok(fixedPlace);

  const schedule = koreaSchedule();
  const itineraryId = crypto.randomUUID();
  const itinerary = {
    id: itineraryId,
    title: "출시 스모크 여행",
    timezone: "Asia/Seoul",
    audience: "general",
    nodes: [
      {
        id: "smoke-changeable",
        sequence: 1,
        type: "visit",
        title: firstPlace.title,
        startAt: schedule.disruptedAt,
        durationMinutes: 50,
        locked: false,
        reservation: false,
        location: {
          latitude: firstPlace.latitude,
          longitude: firstPlace.longitude,
          label: firstPlace.address || firstPlace.title,
          areaCode: firstPlace.regionCode,
          sigunguCode: firstPlace.districtCode,
        },
      },
      {
        id: "smoke-fixed",
        sequence: 2,
        type: "reservation",
        title: fixedPlace.title,
        startAt: schedule.fixedAt,
        locked: true,
        reservation: true,
        location: {
          latitude: fixedPlace.latitude,
          longitude: fixedPlace.longitude,
          label: fixedPlace.address || fixedPlace.title,
          areaCode: fixedPlace.regionCode,
          sigunguCode: fixedPlace.districtCode,
        },
      },
    ],
  };

  const saved = await request("/api/v1/itineraries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itinerary, analyticsConsent: false }),
  });
  assert.equal(saved.response.status, 201);
  assert.equal(saved.body.itinerary.id, itineraryId);
  assert.ok(cookieJar.has("ieoga_session"));

  const recovery = await request("/api/v1/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      origin: {
        latitude: firstPlace.latitude,
        longitude: firstPlace.longitude,
        label: firstPlace.title,
        areaCode: firstPlace.regionCode,
        sigunguCode: firstPlace.districtCode,
      },
      incident: "delay",
      availableMinutes: 150,
      maxDistanceMeters: 5_000,
      audience: "general",
      indoorOnly: false,
      radiusMeters: 5_000,
      safetyBufferMinutes: 15,
      minimumStayMinutes: 30,
      analyticsConsent: false,
      itinerary: {
        ...itinerary,
        occurredAt: schedule.occurredAt,
        disruptedNodeId: "smoke-changeable",
        nextFixedNodeId: "smoke-fixed",
      },
    }),
    timeoutMs: 30_000,
  });
  assert.equal(recovery.response.status, 200);
  assert.equal(recovery.body.persistence?.status, "persisted");
  assert.equal(recovery.body.scope?.coverage, "nationwide");

  let executionCompletedContract = false;
  if (recovery.body.options?.length) {
    const option = recovery.body.options[0];
    assert.ok(option.purposePreservation);
    assert.notEqual(option.title, firstPlace.title);
    if (env.KTO_SERVICE_KEY) {
      process.env.KTO_SERVICE_KEY = env.KTO_SERVICE_KEY;
      const { getTourismCommonDetail } = await import(
        "../lib/kto/adapters.ts"
      );
      let detail;
      try {
        detail = await getTourismCommonDetail(option.contentId, {
          timeoutMs: 10_000,
          retry: false,
        });
      } catch (error) {
        const diagnosticUrl = new URL(
          "https://apis.data.go.kr/B551011/KorService2/detailCommon2",
        );
        diagnosticUrl.search = new URLSearchParams({
          serviceKey: env.KTO_SERVICE_KEY,
          MobileOS: "ETC",
          MobileApp: "IEOGA",
          _type: "json",
          contentId: option.contentId,
          defaultYN: "Y",
          firstImageYN: "Y",
          areacodeYN: "Y",
          catcodeYN: "Y",
          addrinfoYN: "Y",
          mapinfoYN: "Y",
          overviewYN: "N",
          pageNo: "1",
          numOfRows: "10",
        }).toString();
        const diagnosticResponse = await fetch(diagnosticUrl, {
          signal: AbortSignal.timeout(10_000),
        });
        const diagnosticBody = await diagnosticResponse
          .json()
          .catch(() => null);
        throw new Error(
          JSON.stringify({
            contentId: option.contentId,
            originalError:
              error instanceof Error ? error.message : String(error),
            status: diagnosticResponse.status,
            rootKeys:
              diagnosticBody && typeof diagnosticBody === "object"
                ? Object.keys(diagnosticBody)
                : [],
            header:
              diagnosticBody?.response?.header ??
              diagnosticBody?.header ??
              null,
            resultCode: diagnosticBody?.resultCode ?? null,
            resultMsg: diagnosticBody?.resultMsg ?? null,
          }),
        );
      }
      assert.ok(
        detail.items[0],
        `official detail missing for ${option.contentId}`,
      );
      assert.ok(
        Number.isFinite(Number(detail.items[0].mapx)) &&
          Number.isFinite(Number(detail.items[0].mapy)),
        JSON.stringify({
          contentId: option.contentId,
          fields: Object.keys(detail.items[0]),
        }),
      );
    }
    const applied = await request(
      `/api/v1/recover/${encodeURIComponent(
        recovery.body.requestId,
      )}/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: option.id }),
        timeoutMs: 30_000,
      },
    );
    assert.ok(
      [200, 201].includes(applied.response.status),
      JSON.stringify(applied.body),
    );
    assert.equal(applied.body.execution?.steps?.length, 2);
    assert.equal(applied.body.execution?.steps?.[0]?.role, "replacement");
    assert.equal(applied.body.execution?.steps?.[1]?.role, "next_fixed");
    const firstArrival = await request("/api/v1/journey/active", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "arrive_step",
        stepId: applied.body.execution.steps[0].id,
      }),
    });
    assert.equal(firstArrival.response.status, 200);
    assert.equal(firstArrival.body.execution.currentStepSequence, 1);
    const finalArrival = await request("/api/v1/journey/active", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "arrive_step",
        stepId: firstArrival.body.execution.steps[1].id,
      }),
    });
    assert.equal(finalArrival.response.status, 200);
    assert.equal(finalArrival.body.execution.status, "completed");
    executionCompletedContract = true;
  }

  const evidence = await request("/api/v1/release/evidence");
  assert.equal(evidence.response.status, 200);
  assert.ok(evidence.body.report.items.length >= 10);

  const health = await request("/api/v1/health/ready");
  assert.ok([200, 503].includes(health.response.status));

  console.log(
    JSON.stringify(
      {
        home: "ok",
        nationwide: capabilities.body.scope,
        openApiHealth: healthRefresh
          ? healthRefresh.body.sources.map((source) => ({
              name: source.apiName,
              status: source.status,
            }))
          : "ops_key_not_configured",
        placeSearch: {
          primary: firstPlace.provider,
          firstPlace: firstPlace.title,
          fixedPlace: fixedPlace.title,
        },
        recovery: {
          status: recovery.body.status,
          options: recovery.body.options?.length ?? 0,
          persisted: recovery.body.persistence?.status,
          executionActivated: executionCompletedContract,
        },
        releaseEvidence: {
          overall: evidence.body.report.overall,
          verified: `${evidence.body.report.verifiedCount}/${evidence.body.report.totalCount}`,
        },
        runtime: {
          readiness: health.body.overall,
          sourceCount: health.body.sourceHealth?.sourceCount ?? 0,
          sourceStatuses: (health.body.sources ?? []).map((source) => ({
            name: source.apiName,
            status: source.status,
          })),
          providerRequirement:
            health.body.externalProviders?.releaseRequirement,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await stopChild(child);
}
