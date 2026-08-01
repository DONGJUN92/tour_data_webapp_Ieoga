import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

function pngDimensions(buffer) {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function rgb(hex) {
  const value = hex.replace("#", "");
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((character) => character.repeat(2))
          .join("")
      : value;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function luminance(hex) {
  const channels = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  );
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function rootTokens(css) {
  const block = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gi)].map(
      ([, name, value]) => [name, value],
    ),
  );
}

test("PWA metadata names square PNG icons and an offline-safe service worker", async () => {
  const [manifestSource, sw, registration] = await Promise.all([
    source("public/manifest.webmanifest"),
    source("public/sw.js"),
    source("app/ServiceWorkerRegistration.tsx"),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  assert.match(registration, /navigator\.serviceWorker\.register\("\/sw\.js"/);
  assert.match(sw, /request\.method\s*!==\s*"GET"/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /caches\.match\("\/offline"\)/);

  for (const [file, size] of [
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
    ["public/icon-maskable-512.png", 512],
  ]) {
    const dimensions = pngDimensions(await readFile(path.join(ROOT, file)));
    assert.deepEqual(dimensions, { width: size, height: size }, file);
  }
});

test("SEO metadata uses the deployed host and publishes every public route", async () => {
  const [layout, siteConfig, sitemap, robots] = await Promise.all([
    source("app/layout.tsx"),
    source("app/site-config.ts"),
    source("app/sitemap.ts"),
    source("app/robots.ts"),
  ]);

  assert.doesNotMatch(`${layout}\n${siteConfig}`, /https:\/\/ieoga\.kr/);
  assert.match(
    siteConfig,
    /https:\/\/ieoga-national-travel-resilience\.sans5-poems-5045\.workers\.dev/,
  );
  assert.match(layout, /`\$\{SITE_URL\}\/og\.png`/);
  assert.match(layout, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  assert.doesNotMatch(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.deepEqual(
    pngDimensions(await readFile(path.join(ROOT, "public/og.png"))),
    { width: 1732, height: 908 },
  );

  for (const route of [
    "/flow",
    "/policy",
    "/sources",
    "/privacy",
    "/terms",
    "/accessibility",
  ]) {
    assert.ok(sitemap.includes(`"${route}"`), `sitemap omits ${route}`);
  }
  assert.match(robots, /disallow:\s*\["\/api\/",\s*"\/offline"\]/);
  assert.match(robots, /sitemap:\s*`\$\{SITE_URL\}\/sitemap\.xml`/);
});

test("site URL accepts HTTPS and loopback HTTP only", async () => {
  const { resolveSiteUrl } = await import(
    `../app/site-config.ts?site-url-test=${Date.now()}`
  );
  const deployed =
    "https://ieoga-national-travel-resilience.sans5-poems-5045.workers.dev";

  assert.equal(resolveSiteUrl("https://travel.example/path"), "https://travel.example");
  assert.equal(resolveSiteUrl("http://localhost:4173/path"), "http://localhost:4173");
  assert.equal(resolveSiteUrl("http://127.0.0.1:4190"), "http://127.0.0.1:4190");
  assert.equal(resolveSiteUrl("http://[::1]:4190"), "http://[::1]:4190");
  assert.equal(resolveSiteUrl("ftp://localhost/app"), deployed);
  assert.equal(resolveSiteUrl("http://travel.example"), deployed);
  assert.equal(resolveSiteUrl("http://0.0.0.0:4190"), deployed);
  assert.equal(resolveSiteUrl("http://localhost.evil.example"), deployed);
  assert.equal(resolveSiteUrl("javascript:alert(1)"), deployed);
  assert.equal(resolveSiteUrl("not a URL"), deployed);
});

test("build secret scan covers tokens in every configured routing endpoint", async () => {
  const { secretValuesFor } = await import(
    `../scripts/sanitize-build.mjs?secret-policy-test=${Date.now()}`
  );
  const configured = [
    "https://primary.example/route/v1/foot?access_token=primary-secret&annotations=distance,duration",
    "https://backup.example/route/v1/foot?token=backup-secret",
  ].join(",");
  const detected = secretValuesFor("ROUTING_BASE_URL", configured);

  assert.ok(detected.includes("primary-secret"));
  assert.ok(detected.includes("backup-secret"));
  assert.ok(
    detected.some((value) => value.includes("annotations=distance,duration")),
  );
  assert.ok(detected.includes(configured));
});

test("release smoke fails closed unless evidence and readiness are fully ready", async () => {
  const smoke = await source("scripts/smoke-production.mjs");

  assert.match(smoke, /evidence\.body\.report\.overall,\s*"ready"/);
  assert.match(
    smoke,
    /evidence\.body\.report\.verifiedCount,\s*evidence\.body\.report\.totalCount/,
  );
  assert.match(smoke, /item\.status === "verified"/);
  assert.match(smoke, /health\.response\.status,\s*200/);
  assert.match(smoke, /health\.body\.overall,\s*"ready"/);
  assert.match(
    smoke,
    /health\.body\.externalProviders\?\.releaseRequirement,\s*"satisfied"/,
  );
});

test("health, release, and scheduler share an atomic exact-eight snapshot contract", async () => {
  const [readiness, evidence, refresh, repository, worker, opsRefresh] =
    await Promise.all([
      source("app/api/v1/health/ready/route.ts"),
      source("app/api/v1/release/evidence/route.ts"),
      source("lib/kto/health-refresh.ts"),
      source("lib/db/repository.ts"),
      source("worker/index.ts"),
      source("app/api/v1/ops/health/refresh/route.ts"),
    ]);

  assert.match(readiness, /getStoredHealthSnapshot/);
  assert.match(readiness, /getStoredProviderProbeSnapshots/);
  assert.match(readiness, /stored_scheduled_snapshot/);
  assert.match(readiness, /evaluateStoredKtoHealth/);
  assert.match(readiness, /sourceEvaluation\.oldestCheckedAt/);
  assert.match(readiness, /!sourceEvaluation\.allFresh/);
  assert.doesNotMatch(readiness, /refreshKtoHealth/);
  assert.doesNotMatch(readiness, /checkAllKtoServices/);
  assert.doesNotMatch(readiness, /refreshProviderProbes/);
  assert.doesNotMatch(readiness, /probeProviderConfiguration/);
  assert.match(
    readiness,
    /status:\s*overall\s*===\s*["']ready["']\s*\?\s*200\s*:\s*503/,
  );

  assert.match(evidence, /HEALTH_STALE_AFTER_MS/);
  assert.match(evidence, /evaluateStoredKtoHealth/);
  assert.match(evidence, /sourceHealth\.oldestCheckedAt/);
  assert.match(evidence, /sourceHealth\.requiredPresentCount/);
  assert.match(evidence, /!sourceHealth\.allFresh/);

  assert.match(refresh, /evaluation\.exactSourceSet/);
  assert.match(refresh, /evaluation\.oldestCheckedAt/);
  assert.match(refresh, /persistHealth\(result\.sources\)/);
  assert.match(refresh, /KTO_HEALTH_PERSISTENCE_FAILED/);

  assert.match(repository, /hasExactKtoHealthSourceSet\(audits\)/);
  assert.match(repository, /INVALID_HEALTH_SNAPSHOT/);
  assert.match(repository, /await db\.batch\(writes\)/);
  assert.match(worker, /ctx\.waitUntil\([\s\S]*refreshKtoHealth\(\)/);
  assert.match(opsRefresh, /persistHealth\(result\.sources\)/);
  assert.match(opsRefresh, /HEALTH_PERSISTENCE_FAILED/);
});

test("cost-amplifying public routes use a durable fail-closed limiter", async () => {
  const [limiter, insights, share, locationResolve, itineraries] = await Promise.all([
    source("lib/durable-rate-limit.ts"),
    source("app/api/v1/insights/regions/[areaCode]/route.ts"),
    source("app/api/v1/share/route.ts"),
    source("app/api/v1/location/resolve/route.ts"),
    source("app/api/v1/itineraries/route.ts"),
  ]);

  assert.match(limiter, /onConflictDoUpdate/);
  assert.match(limiter, /durableRateLimitWindows\.count/);
  assert.match(limiter, /unavailable:\s*true/);
  assert.match(insights, /allowDurableRequest/);
  assert.match(insights, /RATE_LIMIT_UNAVAILABLE/);
  assert.match(share, /allowDurableRequest/);
  assert.match(share, /RATE_LIMIT_UNAVAILABLE/);
  assert.match(locationResolve, /allowDurableRequest/);
  assert.match(locationResolve, /RATE_LIMIT_UNAVAILABLE/);
  assert.match(itineraries, /allowDurableRequest/);
  assert.match(itineraries, /RATE_LIMIT_UNAVAILABLE/);
});

test("external-provider User-Agent identifies a reachable support channel", async () => {
  const clients = await Promise.all([
    source("lib/location/resolver.ts"),
    source("lib/location/forward-geocoder.ts"),
    source("lib/mobility/routing.ts"),
    source("lib/provider-readiness.ts"),
  ]);
  for (const client of clients) {
    assert.doesNotMatch(client, /https:\/\/ieoga\.kr/);
    assert.match(
      client,
      /https:\/\/github\.com\/DONGJUN92\/tour_data_webapp_Ieoga/,
    );
  }
});

test("security headers and secret scan cover the production PWA contract", async () => {
  const [worker, sanitizer] = await Promise.all([
    source("worker/index.ts"),
    source("scripts/sanitize-build.mjs"),
  ]);

  for (const directive of [
    "script-src-attr 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(worker.includes(directive), `CSP omits ${directive}`);
  }
  assert.match(worker, /Service-Worker-Allowed", "\/"/);
  assert.match(worker, /Cache-Control", "no-cache, no-store, must-revalidate"/);
  for (const name of [
    "KMA_SERVICE_KEY",
    "SESSION_SIGNING_KEY",
    "RELEASE_AUDITOR_API_KEY",
  ]) {
    assert.ok(sanitizer.includes(`"${name}"`), `secret scan omits ${name}`);
    assert.ok(worker.includes(`${name}?: string`), `worker Env omits ${name}`);
  }
});

test("quality gates cover required viewports, keyboard paths, axe, and coverage floors", async () => {
  const [playwright, e2e, startServer, packageJson, lighthouseJson] = await Promise.all([
    source("playwright.config.ts"),
    source("tests/e2e/accessibility.spec.ts"),
    source("scripts/start-production-local.mjs"),
    source("package.json"),
    source("lighthouserc.json"),
  ]);
  const packageData = JSON.parse(packageJson);
  const lighthouse = JSON.parse(lighthouseJson);

  for (const width of [360, 390, 768, 1280]) {
    assert.match(playwright, new RegExp(`width:\\s*${width}\\b`));
  }
  assert.match(e2e, /AxeBuilder/);
  assert.match(e2e, /wcag2aa/);
  assert.match(e2e, /page\.keyboard\.press\("Tab"\)/);
  assert.match(e2e, /page\.keyboard\.press\("Enter"\)/);
  assert.match(e2e, /scrollWidth/);
  for (const dynamicState of ["options", "active", "contract_met"]) {
    assert.ok(
      e2e.includes(`expectNoBlockingAccessibilityIssues(page, "${dynamicState}")`),
      `dynamic axe scan omits ${dynamicState}`,
    );
  }
  assert.match(e2e, /violation\.id === "color-contrast"/);
  const testKey = playwright.match(
    /const E2E_SESSION_SIGNING_KEY = "([^"]+)"/,
  )?.[1];
  assert.ok(testKey, "Playwright must define a dedicated session key");
  assert.equal(Buffer.byteLength(testKey), 32);
  assert.match(playwright, /IEOGA_PLAYWRIGHT_SERVER:\s*"true"/);
  assert.match(startServer, /Buffer\.byteLength\(testSessionSigningKey\) !== 32/);
  assert.match(startServer, /`SESSION_SIGNING_KEY:\$\{testSessionSigningKey\}`/);
  assert.match(startServer, /`playwright-\$\{process\.pid\}`/);
  assert.match(startServer, /!isPlaywrightServer && existsSync\(envPath\)/);
  assert.match(startServer, /delete childEnv\.SESSION_SIGNING_KEY/);
  assert.match(packageData.scripts["test:coverage"], /test-coverage-lines=75/);
  assert.match(packageData.scripts["test:coverage"], /test-coverage-branches=60/);
  assert.match(
    packageData.scripts["test:coverage"],
    /test-coverage-functions=70/,
  );
  assert.match(packageData.scripts.quality, /audit:production/);
  assert.deepEqual(lighthouse.ci.assert.assertions["color-contrast"], "error");
  assert.equal(lighthouse.ci.upload.target, "filesystem");
  assert.doesNotMatch(lighthouseJson, /temporary-public-storage/);
});

test("primary semantic text colors meet WCAG AA contrast on paper", async () => {
  const css = await source("app/globals.css");
  const tokens = rootTokens(css);
  const paper = tokens["--paper"];
  assert.ok(paper, "--paper token is required");

  for (const token of [
    "--ink",
    "--ink-soft",
    "--muted",
    "--brand-deep",
    "--warning",
    "--success",
  ]) {
    assert.ok(tokens[token], `${token} must be a direct hex color`);
    assert.ok(
      contrast(tokens[token], paper) >= 4.5,
      `${token} (${tokens[token]}) has ${contrast(tokens[token], paper).toFixed(
        2,
      )}:1 contrast on ${paper}`,
    );
  }
});
