import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const MANAGED_CONFIGURATIONS = [
  {
    provider: "reverseGeocoding",
    mode: "managed",
    endpoints: ["https://reverse.managed.test/reverse?key=secret"],
  },
  {
    provider: "forwardGeocoding",
    mode: "managed",
    endpoints: ["https://forward.managed.test/search?key=secret"],
  },
  {
    provider: "walkingRouting",
    mode: "managed",
    endpoints: ["https://routing.managed.test/route/v1/walking?key=secret"],
  },
  {
    provider: "weather",
    mode: "managed",
    endpoints: ["https://weather.managed.test/forecast?key=secret"],
  },
];

function jsonResponse(value, responseUrl) {
  const response = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  if (responseUrl) {
    Object.defineProperty(response, "url", {
      configurable: true,
      value: responseUrl,
    });
  }
  return response;
}

function validProviderFetch(input) {
  const url = new URL(input instanceof Request ? input.url : input);
  switch (url.hostname) {
    case "reverse.managed.test":
      return Promise.resolve(
        jsonResponse({
          display_name: "대한민국 서울특별시 종로구 경복궁",
          lat: "37.5796",
          lon: "126.9770",
          address: { city: "서울특별시", borough: "종로구" },
        }, url.toString()),
      );
    case "forward.managed.test":
      return Promise.resolve(
        jsonResponse([
          {
            display_name: "경복궁, 서울특별시",
            lat: "37.5796",
            lon: "126.9770",
          },
        ], url.toString()),
      );
    case "routing.managed.test":
      return Promise.resolve(
        jsonResponse({
          code: "Ok",
          routes: [
            {
              distance: 515,
              duration: 420,
              geometry: {
                coordinates: [
                  [126.977, 37.5796],
                  [126.9768, 37.5759],
                ],
              },
            },
          ],
        }, url.toString()),
      );
    case "weather.managed.test":
      return Promise.resolve(
        jsonResponse({
          current: {
            time: "2026-08-01T15:00",
            temperature_2m: 30.1,
            weather_code: 1,
          },
        }, url.toString()),
      );
    default:
      return Promise.reject(new TypeError("network unavailable"));
  }
}

test("all four managed providers require and accept validated live contracts", async () => {
  const {
    evaluateProviderReadiness,
    probeProviderConfiguration,
  } = await import("../lib/provider-readiness.ts");
  const now = new Date("2026-08-01T06:00:00.000Z");
  const snapshots = await Promise.all(
    MANAGED_CONFIGURATIONS.map((configuration) =>
      probeProviderConfiguration(configuration, {
        fetchImpl: validProviderFetch,
        now,
        timeoutMs: 50,
      }),
    ),
  );
  assert.ok(snapshots.every((snapshot) => snapshot.status === "success"));
  const report = await evaluateProviderReadiness(
    MANAGED_CONFIGURATIONS,
    snapshots,
    { now: new Date("2026-08-01T07:00:00.000Z") },
  );
  assert.equal(report.allReady, true);
  assert.ok(Object.values(report.providers).every((item) => item.ready));
  assert.ok(
    snapshots.every(
      (snapshot) =>
        !JSON.stringify(snapshot).includes("secret") &&
        !JSON.stringify(snapshot).includes("managed.test"),
    ),
  );
});

test("an example.invalid endpoint can never become ready from configuration alone", async () => {
  const {
    evaluateProviderReadiness,
    probeProviderConfiguration,
  } = await import("../lib/provider-readiness.ts");
  const configuration = {
    provider: "forwardGeocoding",
    mode: "managed",
    endpoints: ["https://provider.example.invalid/search?token=hidden"],
  };
  let calls = 0;
  const snapshot = await probeProviderConfiguration(configuration, {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse([
        {
          display_name: "이 응답은 사용되면 안 됩니다",
          lat: "37.5796",
          lon: "126.9770",
        },
      ]);
    },
    timeoutMs: 20,
  });
  assert.equal(calls, 0);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.errorCode, "RESERVED_INVALID_ENDPOINT");
  const report = await evaluateProviderReadiness(
    [configuration],
    [snapshot],
  );
  assert.equal(report.providers.forwardGeocoding.ready, false);
  assert.equal(report.allReady, false);
});

test("a non-responsive managed endpoint fails closed within the probe timeout", async () => {
  const { probeProviderConfiguration } = await import(
    "../lib/provider-readiness.ts"
  );
  const startedAt = Date.now();
  const snapshot = await probeProviderConfiguration(
    {
      provider: "weather",
      mode: "managed",
      endpoints: ["https://non-responsive.managed.test/forecast"],
    },
    {
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 15,
    },
  );
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.errorCode, "TIMEOUT");
  assert.ok(Date.now() - startedAt < 500);
});

test("an HTTPS endpoint that redirects to HTTP fails closed", async () => {
  const { probeProviderConfiguration } = await import(
    "../lib/provider-readiness.ts"
  );
  const response = jsonResponse({
    current: {
      time: "2026-08-01T15:00",
      temperature_2m: 30.1,
      weather_code: 1,
    },
  });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: "http://weather.managed.test/forecast",
  });
  const snapshot = await probeProviderConfiguration(
    MANAGED_CONFIGURATIONS[3],
    { fetchImpl: async () => response, timeoutMs: 20 },
  );
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.errorCode, "INSECURE_REDIRECT");
});

test("a managed endpoint cannot redirect to a shared-public provider", async () => {
  const { probeProviderConfiguration } = await import(
    "../lib/provider-readiness.ts"
  );
  const response = jsonResponse(
    {
      display_name: "대한민국 서울특별시 종로구 경복궁",
      lat: "37.5796",
      lon: "126.9770",
      address: { city: "서울특별시", borough: "종로구" },
    },
    "https://nominatim.openstreetmap.org/reverse?format=jsonv2",
  );
  const snapshot = await probeProviderConfiguration(
    MANAGED_CONFIGURATIONS[0],
    { fetchImpl: async () => response, timeoutMs: 20 },
  );
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.errorCode, "PUBLIC_SHARED_REDIRECT_BLOCKED");
});

test("a known shared-public origin cannot be disguised by another path", async () => {
  const { probeProviderConfiguration } = await import(
    "../lib/provider-readiness.ts"
  );
  const { forwardGeocodeProviderConfig } = await import(
    "../lib/external-providers.ts"
  );
  const previous = process.env.FORWARD_GEOCODE_URL;
  process.env.FORWARD_GEOCODE_URL =
    "https://nominatim.openstreetmap.org./search.php";
  try {
    assert.equal(forwardGeocodeProviderConfig().mode, "public_shared");
    let calls = 0;
    const snapshot = await probeProviderConfiguration(
      {
        provider: "forwardGeocoding",
        mode: "managed",
        endpoints: [process.env.FORWARD_GEOCODE_URL],
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse([], process.env.FORWARD_GEOCODE_URL);
        },
        timeoutMs: 20,
      },
    );
    assert.equal(calls, 0);
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.errorCode, "PUBLIC_SHARED_ENDPOINT_BLOCKED");
  } finally {
    if (previous === undefined) delete process.env.FORWARD_GEOCODE_URL;
    else process.env.FORWARD_GEOCODE_URL = previous;
  }
});

test("stale and configuration-mismatched successful probes remain blocked", async () => {
  const {
    evaluateProviderReadiness,
    providerConfigurationFingerprint,
  } = await import("../lib/provider-readiness.ts");
  const configuration = MANAGED_CONFIGURATIONS[0];
  const fingerprint = await providerConfigurationFingerprint(configuration);
  const staleSnapshot = {
    provider: configuration.provider,
    mode: configuration.mode,
    configurationFingerprint: fingerprint,
    endpointCount: 1,
    status: "success",
    latencyMs: 20,
    checkedAt: "2026-07-31T00:00:00.000Z",
  };
  const stale = await evaluateProviderReadiness(
    [configuration],
    [staleSnapshot],
    {
      now: new Date("2026-08-01T00:00:00.000Z"),
      staleAfterMs: 6 * 3_600_000,
    },
  );
  assert.equal(stale.providers.reverseGeocoding.status, "stale");
  assert.equal(stale.providers.reverseGeocoding.ready, false);

  const changed = await evaluateProviderReadiness(
    [
      {
        ...configuration,
        endpoints: ["https://replacement.managed.test/reverse"],
      },
    ],
    [{ ...staleSnapshot, checkedAt: "2026-08-01T00:00:00.000Z" }],
    { now: new Date("2026-08-01T01:00:00.000Z") },
  );
  assert.equal(
    changed.providers.reverseGeocoding.status,
    "configuration_changed",
  );
  assert.equal(changed.providers.reverseGeocoding.ready, false);
});

test("shared-public providers stay blocked and are not actively probed", async () => {
  const { probeProviderConfiguration } = await import(
    "../lib/provider-readiness.ts"
  );
  let calls = 0;
  const snapshot = await probeProviderConfiguration(
    {
      provider: "weather",
      mode: "public_shared",
      endpoints: ["https://api.open-meteo.com/v1/forecast"],
    },
    {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.errorCode, "PUBLIC_SHARED_BLOCKED");
});

test("probe refresh reports unreadable D1 storage instead of claiming persistence", async () => {
  const {
    getProviderReadinessReport,
    getStoredProviderProbeSnapshots,
    persistProviderProbeSnapshots,
    refreshProviderProbes,
  } = await import("../lib/provider-readiness.ts");
  const names = [
    "REVERSE_GEOCODE_URL",
    "FORWARD_GEOCODE_URL",
    "ROUTING_BASE_URL",
    "WEATHER_API_URL",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    names.forEach((name) => delete process.env[name]);
    assert.equal(await persistProviderProbeSnapshots([]), false);
    await assert.rejects(() => getStoredProviderProbeSnapshots(), /D1 binding/);
    await assert.rejects(() => getProviderReadinessReport(), /D1 binding/);

    const forced = await refreshProviderProbes({ force: true, timeoutMs: 10 });
    assert.equal(forced.probed, true);
    assert.equal(forced.persisted, false);
    assert.equal(forced.readiness.allReady, false);

    const coalescedWindow = await refreshProviderProbes({
      minIntervalMs: 60_000,
      timeoutMs: 10,
    });
    assert.equal(coalescedWindow.probed, false);
    assert.equal(coalescedWindow.persisted, false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("0009 migration and Drizzle snapshot contain only provider probe evidence", async () => {
  const [sql, snapshotSource, journalSource] = await Promise.all([
    readFile(`${ROOT}/drizzle/0009_provider_readiness_probes.sql`, "utf8"),
    readFile(`${ROOT}/drizzle/meta/0009_snapshot.json`, "utf8"),
    readFile(`${ROOT}/drizzle/meta/_journal.json`, "utf8"),
  ]);
  const snapshot = JSON.parse(snapshotSource);
  const journal = JSON.parse(journalSource);
  assert.match(sql, /CREATE TABLE `provider_probe_snapshots`/);
  assert.match(sql, /`configuration_fingerprint` text NOT NULL/);
  assert.match(sql, /`latency_ms` integer NOT NULL/);
  assert.match(sql, /`checked_at` text NOT NULL/);
  assert.match(sql, /`error_code` text/);
  assert.ok(snapshot.tables.provider_probe_snapshots);
  assert.equal(
    journal.entries.at(-1)?.tag,
    "0009_provider_readiness_probes",
  );
});

test("capabilities describes the configured chain without naming a different provider", async () => {
  const { describeProviderCapabilities } = await import(
    "../lib/provider-readiness.ts"
  );
  const managed = describeProviderCapabilities({
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "managed",
      walkingRouting: "managed",
      weather: "managed",
    },
    kakaoConfigured: true,
    kmaConfigured: true,
  });
  assert.equal(managed.routeMethod, "configured_osrm_compatible");
  assert.equal(
    managed.weatherMethod,
    "kma_when_configured_then_configured_weather",
  );
  assert.equal(
    managed.reverseMethod,
    "kakao_when_configured_then_configured_reverse_then_kto_nearest",
  );
  assert.equal(
    managed.currentOriginFallback,
    "kakao_when_configured_then_configured_forward",
  );

  const shared = describeProviderCapabilities({
    providers: {
      reverseGeocoding: "public_shared",
      forwardGeocoding: "public_shared",
      walkingRouting: "public_shared",
      weather: "public_shared",
    },
    kakaoConfigured: false,
    kmaConfigured: false,
  });
  assert.equal(shared.routeMethod, "shared_public_osrm_compatible");
  assert.equal(shared.weatherMethod, "shared_public_open_meteo");
  assert.equal(
    shared.reverseMethod,
    "shared_public_nominatim_then_kto_nearest",
  );
});

/* A commercial key must not become a release claim on its own. These cover the
   walking-route chain end to end: how it is classified, and whether the
   provider that is claimed is the provider that actually gets called. */

function withRoutingEnv(values, run) {
  const names = ["TMAP_APP_KEY", "ROUTING_BASE_URL"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  return (async () => {
    try {
      return await run();
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  })();
}

function tmapFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [126.977, 37.5796] },
        properties: { totalDistance: 515, totalTime: 420 },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [126.977, 37.5796],
            [126.9768, 37.5759],
          ],
        },
        properties: {},
      },
    ],
  };
}

test("a TMAP key alone does not end the dependency on the shared public router", async () => {
  const { routingProviderConfig, walkingRouteChain, PUBLIC_OSRM_WALKING_URL } =
    await import("../lib/external-providers.ts");
  await withRoutingEnv({ TMAP_APP_KEY: "tmap-app-key" }, async () => {
    /* TMAP answers first, but public OSRM is still reachable behind it. The
       same rule Kakao and KMA live under has to apply here. */
    assert.deepEqual(walkingRouteChain(), [
      "https://apis.openapi.sk.com/tmap/routes/pedestrian",
      PUBLIC_OSRM_WALKING_URL,
    ]);
    assert.equal(routingProviderConfig().mode, "public_shared");
  });
});

test("a shared-public walking chain is never probed, whatever leads it", async () => {
  const { currentProviderConfigurations, probeProviderConfiguration } =
    await import("../lib/provider-readiness.ts");
  await withRoutingEnv({ TMAP_APP_KEY: "tmap-app-key" }, async () => {
    const configuration = currentProviderConfigurations().find(
      (entry) => entry.provider === "walkingRouting",
    );
    const snapshot = await probeProviderConfiguration(configuration, {
      fetchImpl: () => assert.fail("a shared chain must not be probed"),
      timeoutMs: 50,
    });
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.errorCode, "PUBLIC_SHARED_BLOCKED");
  });
});

test("declaring no OSRM fallback makes a TMAP-only chain classifiable", async () => {
  const { routingEndpoints, routingProviderConfig, walkingRouteChain } =
    await import("../lib/external-providers.ts");
  await withRoutingEnv(
    { TMAP_APP_KEY: "tmap-app-key", ROUTING_BASE_URL: "none" },
    async () => {
      assert.deepEqual(routingEndpoints(), []);
      assert.deepEqual(walkingRouteChain(), [
        "https://apis.openapi.sk.com/tmap/routes/pedestrian",
      ]);
      assert.equal(routingProviderConfig().mode, "managed");
    },
  );
});

test("a managed TMAP chain is proven by calling TMAP, not an OSRM endpoint", async () => {
  const { currentProviderConfigurations, probeProviderConfiguration } =
    await import("../lib/provider-readiness.ts");
  await withRoutingEnv(
    { TMAP_APP_KEY: "tmap-app-key", ROUTING_BASE_URL: "none" },
    async () => {
      const calls = [];
      const snapshot = await probeProviderConfiguration(
        currentProviderConfigurations().find(
          (entry) => entry.provider === "walkingRouting",
        ),
        {
          fetchImpl: (input, init) => {
            calls.push({ url: String(input), init });
            return Promise.resolve(jsonResponse(tmapFeatureCollection()));
          },
          timeoutMs: 50,
        },
      );
      assert.equal(snapshot.status, "success");
      assert.equal(snapshot.mode, "managed");
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /apis\.openapi\.sk\.com/);
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers.appKey, "tmap-app-key");
      /* The credential must not travel to the stored evidence. */
      assert.ok(!JSON.stringify(snapshot).includes("tmap-app-key"));
    },
  );
});

test("a TMAP response without a usable route fails closed", async () => {
  const { currentProviderConfigurations, probeProviderConfiguration } =
    await import("../lib/provider-readiness.ts");
  await withRoutingEnv(
    { TMAP_APP_KEY: "tmap-app-key", ROUTING_BASE_URL: "none" },
    async () => {
      const configuration = currentProviderConfigurations().find(
        (entry) => entry.provider === "walkingRouting",
      );
      /* An OSRM-shaped answer is not evidence that TMAP works. */
      const wrongShape = await probeProviderConfiguration(configuration, {
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({ code: "Ok", routes: [{ distance: 515, duration: 420 }] }),
          ),
        timeoutMs: 50,
      });
      assert.equal(wrongShape.status, "error");
      assert.equal(wrongShape.errorCode, "INVALID_RESPONSE_CONTRACT");

      const rejected = await probeProviderConfiguration(configuration, {
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: { code: "INVALID_API_KEY" } }), {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
          ),
        timeoutMs: 50,
      });
      assert.equal(rejected.status, "error");
      assert.equal(rejected.errorCode, "HTTP_403");
    },
  );
});
