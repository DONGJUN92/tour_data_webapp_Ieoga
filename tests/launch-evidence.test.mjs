import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("launch evidence never marks missing field proof as verified", async () => {
  const { buildLaunchEvidenceReport } = await import(
    "../lib/release/evidence.ts"
  );
  const report = buildLaunchEvidenceReport({
    ktoConfigured: true,
    d1Ready: true,
    r2Ready: true,
    sourceHealthCount: 8,
    sourceHealthErrorCount: 0,
    sourceHealthStale: false,
    providerProbesReady: true,
    sessionSigningReady: true,
    independentAuditorReady: true,
    releaseSecretsReady: true,
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "managed",
      walkingRouting: "managed",
      weather: "managed",
    },
  });

  assert.equal(report.overall, "evidence_collection");
  assert.equal(
    report.items.find((item) => item.id === "first_time_users_20")?.status,
    "needs_field_evidence",
  );
  assert.equal(
    report.items.find((item) => item.id === "tripbreak_100")?.status,
    "needs_field_evidence",
  );
});

test("shared public providers remain an explicit release blocker", async () => {
  const { buildLaunchEvidenceReport } = await import(
    "../lib/release/evidence.ts"
  );
  const report = buildLaunchEvidenceReport({
    ktoConfigured: true,
    d1Ready: true,
    r2Ready: true,
    sourceHealthCount: 8,
    sourceHealthErrorCount: 0,
    sourceHealthStale: false,
    providerProbesReady: true,
    sessionSigningReady: true,
    independentAuditorReady: true,
    releaseSecretsReady: true,
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "public_shared",
      walkingRouting: "managed",
      weather: "managed",
    },
  });

  assert.equal(report.overall, "blocked");
  assert.equal(
    report.items.find(
      (item) => item.id === "managed_external_providers",
    )?.status,
    "release_blocker",
  );
});

test("weak or reused release secrets remain an explicit release blocker", async () => {
  const { buildLaunchEvidenceReport } = await import(
    "../lib/release/evidence.ts"
  );
  const report = buildLaunchEvidenceReport({
    ktoConfigured: true,
    d1Ready: true,
    r2Ready: true,
    sourceHealthCount: 8,
    sourceHealthErrorCount: 0,
    sourceHealthStale: false,
    providerProbesReady: true,
    sessionSigningReady: true,
    independentAuditorReady: true,
    releaseSecretsReady: false,
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "managed",
      walkingRouting: "managed",
      weather: "managed",
    },
  });
  assert.equal(report.overall, "blocked");
  assert.equal(
    report.items.find(
      (item) => item.id === "release_secret_separation",
    )?.status,
    "release_blocker",
  );
});

test("managed endpoint strings remain blocked without fresh active probes", async () => {
  const { buildLaunchEvidenceReport } = await import(
    "../lib/release/evidence.ts"
  );
  const report = buildLaunchEvidenceReport({
    ktoConfigured: true,
    d1Ready: true,
    r2Ready: true,
    sourceHealthCount: 8,
    sourceHealthErrorCount: 0,
    sourceHealthStale: false,
    providerProbesReady: false,
    sessionSigningReady: true,
    independentAuditorReady: true,
    releaseSecretsReady: true,
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "managed",
      walkingRouting: "managed",
      weather: "managed",
    },
  });

  assert.equal(report.overall, "blocked");
  assert.equal(
    report.items.find(
      (item) => item.id === "managed_external_providers",
    )?.status,
    "release_blocker",
  );
});

test("implementation claims remain unverified without authenticated field evidence", async () => {
  const { buildLaunchEvidenceReport } = await import(
    "../lib/release/evidence.ts"
  );
  const report = buildLaunchEvidenceReport({
    ktoConfigured: true,
    d1Ready: true,
    r2Ready: true,
    sourceHealthCount: 8,
    sourceHealthErrorCount: 0,
    sourceHealthStale: false,
    providerProbesReady: true,
    sessionSigningReady: true,
    independentAuditorReady: true,
    releaseSecretsReady: true,
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "managed",
      walkingRouting: "managed",
      weather: "managed",
    },
  });
  for (const id of [
    "journey_completion_contract",
    "travel_purpose_preservation",
    "first_time_location_ux",
  ]) {
    assert.equal(
      report.items.find((item) => item.id === id)?.status,
      "needs_field_evidence",
    );
  }
});

test("self-reported field evidence cannot become verified before independent approval", async () => {
  const { buildLaunchEvidenceReport } = await import(
    "../lib/release/evidence.ts"
  );
  const report = buildLaunchEvidenceReport({
    ktoConfigured: true,
    d1Ready: true,
    r2Ready: true,
    sourceHealthCount: 8,
    sourceHealthErrorCount: 0,
    sourceHealthStale: false,
    providerProbesReady: true,
    sessionSigningReady: true,
    independentAuditorReady: true,
    releaseSecretsReady: true,
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "managed",
      walkingRouting: "managed",
      weather: "managed",
    },
    fieldEvidence: {
      tripbreak_100: {
        evidenceType: "tripbreak_100",
        validated: true,
        independentAuditStatus: "pending",
        sampleSize: 100,
        regionCount: 6,
        reviewerCount: 3,
        measuredAt: "2026-07-31T08:00:00.000Z",
      },
    },
  });
  assert.equal(
    report.items.find((item) => item.id === "tripbreak_100")?.status,
    "needs_field_evidence",
  );
  assert.match(
    report.items.find((item) => item.id === "tripbreak_100")?.evidence ?? "",
    /독립 감사 상태는 pending/,
  );
});

test("release auditor key must meet minimum quality and remain distinct from OPS", async () => {
  const previousOps = process.env.OPS_API_KEY;
  const previousAuditor = process.env.RELEASE_AUDITOR_API_KEY;
  const { releaseAuditorStatus } = await import(
    "../lib/release/auditor.ts"
  );
  try {
    process.env.OPS_API_KEY =
      "7fA2cE9mQ4xL8vN3rT6pW1yK5dH0sJ2uB9zG4aC";
    process.env.RELEASE_AUDITOR_API_KEY = process.env.OPS_API_KEY;
    assert.equal(releaseAuditorStatus().releaseReady, false);
    assert.equal(
      releaseAuditorStatus().reason,
      "auditor_key_reuses_ops_key",
    );

    process.env.RELEASE_AUDITOR_API_KEY = "short";
    assert.equal(releaseAuditorStatus().releaseReady, false);
    process.env.RELEASE_AUDITOR_API_KEY =
      "Q8v3N6xP1mR7kT4yW9cF2hJ5sL0dA6uE3zB8gK1M";
    assert.deepEqual(releaseAuditorStatus(), {
      configured: true,
      independent: true,
      releaseReady: true,
      reason: "ready",
    });
  } finally {
    if (previousOps === undefined) delete process.env.OPS_API_KEY;
    else process.env.OPS_API_KEY = previousOps;
    if (previousAuditor === undefined) {
      delete process.env.RELEASE_AUDITOR_API_KEY;
    } else {
      process.env.RELEASE_AUDITOR_API_KEY = previousAuditor;
    }
  }
});

test("all release secrets meet minimum quality, remain distinct, and gate auth", async () => {
  const names = [
    "SESSION_SIGNING_KEY",
    "OPS_API_KEY",
    "PARTNER_API_KEY",
    "RELEASE_AUDITOR_API_KEY",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  const values = {
    SESSION_SIGNING_KEY:
      "m7Q2vK9xD4pL8rT1wN6cF3hJ0sA5uE2zB7gY4kM",
    OPS_API_KEY: "7fA2cE9mQ4xL8vN3rT6pW1yK5dH0sJ2uB9zG4aC",
    PARTNER_API_KEY: "R5nC1xV8mQ3pT7kD2wL9hF4sJ0aE6uB1zG5yK8dP",
    RELEASE_AUDITOR_API_KEY:
      "Q8v3N6xP1mR7kT4yW9cF2hJ5sL0dA6uE3zB8gK1M",
  };
  const { releaseSecretTopologyStatus } = await import(
    "../lib/secret-policy.ts"
  );
  const { authenticateOps, authenticatePartner } = await import(
    "../lib/auth.ts"
  );
  const { sessionSigningStatus } = await import(
    "../lib/session-cookie.ts"
  );
  try {
    Object.assign(process.env, values);
    assert.equal(releaseSecretTopologyStatus().releaseReady, true);
    assert.equal(
      await authenticatePartner(`Bearer ${values.PARTNER_API_KEY}`),
      "authorized",
    );

    process.env.PARTNER_API_KEY = values.OPS_API_KEY;
    const duplicated = releaseSecretTopologyStatus();
    assert.equal(duplicated.releaseReady, false);
    assert.equal(duplicated.pairwiseDistinct, false);
    assert.equal(
      duplicated.secrets.OPS_API_KEY.operationalReady,
      false,
    );
    assert.equal(
      await authenticateOps(`Bearer ${values.OPS_API_KEY}`),
      "missing_configuration",
    );

    process.env.PARTNER_API_KEY = "short";
    assert.equal(
      releaseSecretTopologyStatus().allMinimumLengthMet,
      false,
    );
    assert.equal(
      await authenticatePartner("Bearer short"),
      "missing_configuration",
    );

    process.env.PARTNER_API_KEY = "a".repeat(64);
    const repeated = releaseSecretTopologyStatus();
    assert.equal(repeated.allMinimumLengthMet, true);
    assert.equal(repeated.allQualityPolicyMet, false);
    assert.ok(
      repeated.secrets.PARTNER_API_KEY.rejectionReasons.includes(
        "low_character_diversity",
      ),
    );
    assert.equal(
      await authenticatePartner(`Bearer ${"a".repeat(64)}`),
      "missing_configuration",
    );

    process.env.PARTNER_API_KEY =
      "change-me-placeholder-value-7fA2cE9mQ4xL8vN3";
    assert.ok(
      releaseSecretTopologyStatus().secrets.PARTNER_API_KEY.rejectionReasons.includes(
        "known_placeholder",
      ),
    );

    process.env.PARTNER_API_KEY = values.SESSION_SIGNING_KEY;
    const signing = sessionSigningStatus();
    assert.equal(signing.available, true);
    assert.equal(signing.releaseReady, false);
    assert.equal(signing.source, "ops_api_key_fallback");
    assert.match(signing.warning ?? "", /OPS_API_KEY/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("independent audit approval is reachable only through the auditor route", async () => {
  const [opsRoute, auditorRoute, evidenceStore] = await Promise.all([
    readFile(
      new URL(
        "app/api/v1/ops/evidence/route.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "app/api/v1/auditor/evidence/[evidenceId]/route.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "lib/release/field-evidence.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
  ]);
  assert.match(opsRoute, /validated_pending_independent_audit/);
  assert.doesNotMatch(opsRoute, /decideFieldEvidenceAudit/);
  assert.match(auditorRoute, /authenticateReleaseAuditor/);
  assert.match(auditorRoute, /export async function GET/);
  assert.match(auditorRoute, /export async function PATCH/);
  assert.match(auditorRoute, /decideFieldEvidenceAudit/);
  assert.doesNotMatch(auditorRoute, /authenticateOps/);
  assert.match(evidenceStore, /eq\(fieldEvidenceRegistry\.independentAuditStatus, "pending"\)/);
  assert.match(evidenceStore, /AUDIT_ALREADY_DECIDED/);
});

test("KTO readiness uses the exact eight-source set and oldest individual probe", async () => {
  const {
    evaluateStoredKtoHealth,
    REQUIRED_KTO_HEALTH_SOURCES,
  } = await import("../lib/kto/health-snapshot.ts");
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const fresh = new Date(now - 30 * 60_000).toISOString();
  const stale = new Date(now - 7 * 3_600_000).toISOString();
  const sources = REQUIRED_KTO_HEALTH_SOURCES.map((apiName, index) => ({
    apiName,
    status: "live",
    checkedAt: index === 0 ? stale : fresh,
  }));
  const mixedGeneration = evaluateStoredKtoHealth(
    sources,
    6 * 3_600_000,
    now,
  );
  assert.equal(mixedGeneration.exactSourceSet, true);
  assert.equal(mixedGeneration.ready, false);
  assert.deepEqual(mixedGeneration.staleSources, [sources[0].apiName]);
  assert.equal(mixedGeneration.oldestCheckedAt, stale);
  assert.equal(mixedGeneration.latestCheckedAt, fresh);

  const freshGeneration = evaluateStoredKtoHealth(
    sources.map((source) => ({ ...source, checkedAt: fresh })),
    6 * 3_600_000,
    now,
  );
  assert.equal(freshGeneration.ready, true);

  const unexpected = evaluateStoredKtoHealth(
    [
      ...sources.map((source) => ({ ...source, checkedAt: fresh })),
      { apiName: "UnexpectedService", status: "live", checkedAt: fresh },
    ],
    6 * 3_600_000,
    now,
  );
  assert.equal(unexpected.exactSourceSet, false);
  assert.equal(unexpected.ready, false);
  assert.deepEqual(unexpected.unexpectedSources, ["UnexpectedService"]);

  for (const invalidStatus of ["not_required", "success", "unknown"]) {
    const invalid = evaluateStoredKtoHealth(
      sources.map((source, index) => ({
        ...source,
        checkedAt: fresh,
        status: index === 0 ? invalidStatus : "live",
      })),
      6 * 3_600_000,
      now,
    );
    assert.equal(invalid.ready, false);
    assert.deepEqual(invalid.invalidStatusSources, [sources[0].apiName]);
  }

  const futureSources = sources.map((source) => ({
    ...source,
    checkedAt: new Date(now + 10 * 60_000).toISOString(),
  }));
  const future = evaluateStoredKtoHealth(
    futureSources,
    6 * 3_600_000,
    now,
  );
  assert.equal(future.ready, false);
  assert.equal(future.staleSources.length, 8);

  const { isOlderThan } = await import("../lib/kto/health-refresh.ts");
  assert.equal(
    isOlderThan(new Date(Date.now() + 10 * 60_000).toISOString(), 60_000),
    true,
  );
});

test("field evidence validation is fail-closed and threshold based", async () => {
  const { validateFieldEvidence } = await import(
    "../lib/release/field-evidence.ts"
  );
  const base = {
    evidenceType: "tripbreak_100",
    sampleSize: 100,
    regions: ["11", "26", "27", "28", "51", "48"],
    metrics: {
      scenarioSuccessRate: 95,
      criticalFalsePositiveCount: 0,
    },
    artifactReference: `sha256:${"a".repeat(64)}`,
    reviewers: ["관광 실무자", "지자체 실무자", "접근성 검토자"],
    measuredAt: "2026-07-31T08:00:00.000Z",
  };
  assert.deepEqual(
    validateFieldEvidence(base, new Date("2026-07-31T09:00:00.000Z")),
    [],
  );
  assert.ok(
    validateFieldEvidence(
      {
        ...base,
        sampleSize: 99,
        regions: ["11"],
        metrics: {
          scenarioSuccessRate: 100,
          criticalFalsePositiveCount: 1,
        },
      },
      new Date("2026-07-31T09:00:00.000Z"),
    ).length >= 3,
  );
  assert.match(
    validateFieldEvidence(
      {
        ...base,
        measuredAt: "2025-01-01T00:00:00.000Z",
      },
      new Date("2026-07-31T09:00:00.000Z"),
    ).join(" "),
    /180일/,
  );
  assert.match(
    validateFieldEvidence(
      {
        ...base,
        regions: ["99", "26", "27", "28", "51", "48"],
      },
      new Date("2026-07-31T09:00:00.000Z"),
    ).join(" "),
    /공식 시도 코드/,
  );
  assert.match(
    validateFieldEvidence(
      {
        ...base,
        evidenceType: "six_region_field_audit",
        sampleSize: 6,
        regions: ["11110", "11140", "11170", "11200", "11215", "11230"],
        metrics: { criticalFalsePositiveCount: 0 },
      },
      new Date("2026-07-31T09:00:00.000Z"),
    ).join(" "),
    /서로 다른 시도 권역 6곳/,
  );
  assert.match(
    validateFieldEvidence(
      {
        ...base,
        evidenceType: "tourism_reviewers_3",
        sampleSize: 3,
        reviewers: ["관광 실무자", " 관광   실무자 ", "관광 실무자"],
      },
      new Date("2026-07-31T09:00:00.000Z"),
    ).join(" "),
    /서로 다른 관광·지자체 실무 검토자 3인/,
  );
  assert.match(
    validateFieldEvidence(
      {
        ...base,
        artifactReference: "http://example.com/not-secure",
      },
      new Date("2026-07-31T09:00:00.000Z"),
    ).join(" "),
    /https:\/\//,
  );
});

test("session unavailability is a stable 503 contract instead of an exception", async () => {
  const files = [
    "lib/http.ts",
    "app/api/v1/itineraries/route.ts",
    "app/api/v1/recover/route.ts",
    "app/api/v1/journey/active/route.ts",
    "app/api/v1/recover/[runId]/apply/route.ts",
    "app/api/v1/recover/[runId]/outcome/route.ts",
    "app/api/v1/share/route.ts",
    "app/api/v1/share/[token]/route.ts",
    "app/api/v1/privacy/session/route.ts",
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, `file:///${ROOT.replaceAll("\\", "/")}/`), "utf8")),
  );
  assert.match(sources[0], /function requireSessionSigning/);
  assert.match(sources[0], /SESSION_SIGNING_UNAVAILABLE/);
  assert.match(sources[0], /\{ status: 503 \}/);
  for (const source of sources.slice(1)) {
    assert.match(source, /requireSessionSigning\(\)/);
  }
});

test("public JSON errors are never cacheable", async () => {
  const [source, liveHealth] = await Promise.all([
    readFile(
      new URL(
        "lib/http.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "app/api/v1/health/live/route.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
  ]);
  assert.match(source, /status >= 400 \|\| options\.maxAge === 0/);
  assert.match(source, /"Cache-Control", "private, no-store"/);
  assert.match(source, /`public, max-age=/);
  assert.match(liveHealth, /\{ maxAge: 0 \}/);
});

test("a signed session cookie rejects raw and tampered identifiers", async () => {
  const previous = process.env.SESSION_SIGNING_KEY;
  process.env.SESSION_SIGNING_KEY =
    "m7Q2vK9xD4pL8rT1wN6cF3hJ0sA5uE2zB7gY4kM";
  try {
    const {
      createSessionCookieValue,
      verifySessionCookieValue,
    } = await import(
      "../lib/session-cookie.ts"
    );
    const id = "00000000-0000-4000-8000-000000000111";
    const signed = createSessionCookieValue(id);
    assert.equal(verifySessionCookieValue(signed), id);
    assert.equal(verifySessionCookieValue(id), undefined);
    assert.equal(
      verifySessionCookieValue(
        `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`,
      ),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.SESSION_SIGNING_KEY;
    else process.env.SESSION_SIGNING_KEY = previous;
  }
});

test("session signing rejects short keys and treats OPS reuse as a release blocker", async () => {
  const previousSession = process.env.SESSION_SIGNING_KEY;
  const previousOps = process.env.OPS_API_KEY;
  const {
    createSessionCookieValue,
    sessionSigningStatus,
  } = await import("../lib/session-cookie.ts");
  try {
    process.env.SESSION_SIGNING_KEY = "too-short";
    delete process.env.OPS_API_KEY;
    assert.deepEqual(sessionSigningStatus(), {
      available: false,
      releaseReady: false,
      source: "unavailable",
      warning:
        "Session APIs are disabled until SESSION_SIGNING_KEY meets the published minimum length, placeholder, repetition, diversity, and separation policy.",
    });
    assert.throws(
      () =>
        createSessionCookieValue(
          "00000000-0000-4000-8000-000000000111",
        ),
      /SESSION_SIGNING_KEY_UNAVAILABLE/,
    );

    delete process.env.SESSION_SIGNING_KEY;
    process.env.OPS_API_KEY =
      "7fA2cE9mQ4xL8vN3rT6pW1yK5dH0sJ2uB9zG4aC";
    const fallback = sessionSigningStatus();
    assert.equal(fallback.available, true);
    assert.equal(fallback.releaseReady, false);
    assert.equal(fallback.source, "ops_api_key_fallback");
  } finally {
    if (previousSession === undefined) {
      delete process.env.SESSION_SIGNING_KEY;
    } else {
      process.env.SESSION_SIGNING_KEY = previousSession;
    }
    if (previousOps === undefined) delete process.env.OPS_API_KEY;
    else process.env.OPS_API_KEY = previousOps;
  }
});

test("missing dedicated session signing remains a launch blocker", async () => {
  const { buildLaunchEvidenceReport } = await import(
    "../lib/release/evidence.ts"
  );
  const report = buildLaunchEvidenceReport({
    ktoConfigured: true,
    d1Ready: true,
    r2Ready: true,
    sourceHealthCount: 8,
    sourceHealthErrorCount: 0,
    sourceHealthStale: false,
    providerProbesReady: true,
    sessionSigningReady: false,
    independentAuditorReady: true,
    releaseSecretsReady: true,
    providers: {
      reverseGeocoding: "managed",
      forwardGeocoding: "managed",
      walkingRouting: "managed",
      weather: "managed",
    },
  });
  assert.equal(report.overall, "blocked");
  assert.equal(
    report.items.find(
      (item) => item.id === "stable_session_signing",
    )?.status,
    "release_blocker",
  );
});

test("partner recovery enforces key-scoped durable minute and daily quotas", async () => {
  const [route, quota, durable] = await Promise.all([
    readFile(
      new URL(
        "app/api/v1/partner/recover/route.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "lib/partner/quota.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "lib/durable-rate-limit.ts",
        `file:///${ROOT.replaceAll("\\", "/")}/`,
      ),
      "utf8",
    ),
  ]);
  assert.match(route, /consumePartnerQuota\(authorization\)/);
  assert.match(route, /areKnownAdministrativeScopes\(administrativeScopes\)/);
  assert.match(route, /REGION_REFERENCE_UNAVAILABLE/);
  assert.match(route, /UNKNOWN_REGION_SCOPE/);
  assert.match(route, /beforeDeadline\(\s*recoverTrip\(/);
  assert.match(
    route,
    /deadlineController\.signal\.aborted\s*\|\|\s*Date\.now\(\)\s*>=\s*deadlineAt/,
  );
  assert.match(route, /X-Partner-Daily-Remaining/);
  assert.match(quota, /partnerClients\.active/);
  assert.match(quota, /partnerClients\.revokedAt/);
  assert.match(quota, /partnerUsageDaily\.requestCount/);
  assert.match(quota, /allowDurableIdentity\(/);
  assert.match(durable, /requestClientIdentity\(request\)/);
  assert.match(
    durable,
    /`\$\{namespace\}:\$\{identity\}:\$\{windowStart\}`/,
  );
});

test("partner daily quota uses the Korea calendar day", async () => {
  const { koreaUsageDate, secondsUntilNextKoreaDay } = await import(
    "../lib/partner/quota.ts"
  );
  assert.equal(
    koreaUsageDate(new Date("2026-07-31T14:59:59.000Z")),
    "2026-07-31",
  );
  assert.equal(
    koreaUsageDate(new Date("2026-07-31T15:00:00.000Z")),
    "2026-08-01",
  );
  assert.equal(
    secondsUntilNextKoreaDay(new Date("2026-07-31T14:59:59.000Z")),
    1,
  );
  assert.equal(
    secondsUntilNextKoreaDay(new Date("2026-07-31T15:00:00.000Z")),
    86_400,
  );
});
