import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateEvidence,
  parseCsv,
  verifyCloudflareReleaseControlPlane,
  verifyProductionAssetManifest,
  verifyReleaseArtifactManifests,
  verifyReleaseReceiptAttestation,
  verifyReleaseReceiptManifest,
  verifyReleaseReceiptRemote,
  verifyRemoteArtifactReferences,
} from "../scripts/submission-gate.mjs";
import {
  CANONICAL_DEPLOYMENT_ORIGIN,
  RELEASE_ASSET_MANIFEST_PATH,
  RELEASE_ATTESTATION_REPOSITORY,
  RELEASE_ATTESTATION_SOURCE_REF,
  RELEASE_ATTESTATION_WORKFLOW,
  RELEASE_BUNDLE_MANIFEST_PATH,
  canonicalJson,
  createReleaseReceipt,
  parseWranglerDeployOutput,
  validateReleaseReceipt,
  verifyRemoteReleaseIdentity,
} from "../scripts/release-identity.mjs";

const commitSha = "a".repeat(40);
const deploymentUrl = "https://travel.example";
const artifactDigest = "b".repeat(64);
const consentLedgerSha = "c".repeat(64);
const artifact = `approved-artifact:sha256:${artifactDigest}`;
const consentReference = `approved-consent-ledger:sha256:${consentLedgerSha}`;
const measuredAt = "2026-08-09T00:00:00.000Z";
const context = {
  commitSha,
  deploymentUrl,
  nowMs: Date.parse("2026-08-09T02:00:00.000Z"),
  approvedArtifactDigests: [artifactDigest, consentLedgerSha],
  consentLedgerSha,
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function common() {
  return { commit_sha: commitSha, deployment_url: deploymentUrl };
}

function passingDatasets() {
  const tripbreak = Array.from({ length: 100 }, (_, index) => ({
    ...common(),
    scenario_id: `tb-${index + 1}`,
    run_at: measuredAt,
    region_class: `region-${index % 6}`,
    area_code: String(10 + (index % 6)),
    incident: ["rain", "crowd", "delay", "closure"][index % 4],
    audience: ["general", "stroller", "wheelchair", "senior"][index % 4],
    request_id: `request-${index}`,
    rule_version: "2026.08-v2",
    result_status: index % 5 === 0 ? "explained_no_option" : "options_presented",
    has_fixed_appointment: index < 70 ? "true" : "false",
    option_count: index % 5 === 0 ? "0" : "3",
    response_ms: "3200",
    locked_appointment_preserved:
      index < 70 && index % 5 !== 0 ? "true" : "not_applicable",
    availability_fail_closed: "true",
    return_route_verified:
      index >= 70 && index % 5 !== 0 ? "true" : "not_applicable",
    critical_false_positive: "0",
  }));
  const performance = Array.from({ length: 40 }, (_, index) => ({
    ...common(),
    measurement_id: `perf-${index}`,
    measured_at: measuredAt,
    device_class: index < 20 ? "mobile-android" : "desktop",
    browser: index % 2 === 0 ? "Chrome" : "Safari",
    viewport_width: index < 20 ? "390" : "1440",
    network_profile: index < 16 ? "Slow 4G" : "Wi-Fi",
    flow: "recovery",
    repetition: String(index + 1),
    response_ms: "3200",
    largest_contentful_paint_ms: "1900",
    interaction_to_next_paint_ms: "120",
    cumulative_layout_shift: "0.04",
    retry_required: "false",
    error_code: "",
  }));
  const locales = ["ko-KR", "en-US", "ja-JP"];
  const realUsers = Array.from({ length: 20 }, (_, index) => ({
    ...common(),
    participant_id: `participant-${index}`,
    user_segment: index === 0 ? "wheelchair" : "general",
    locale: locales[index % locales.length],
    device_class: index % 2 === 0 ? "mobile" : "desktop",
    first_time_visitor: index === 0 ? "true" : "false",
    task_id: `task-${index}`,
    started_at: measuredAt,
    completed: "true",
    completion_seconds: "180",
    constraint_preserved: "true",
    critical_safety_incident: "false",
    clarity_score_1_to_5: "4.5",
    trust_score_1_to_5: "4.6",
    artifact_reference: artifact,
    consent_reference: consentReference,
  }));
  const fieldJourneys = Array.from({ length: 12 }, (_, index) => ({
    ...common(),
    journey_id: `journey-${index}`,
    participant_id: `field-participant-${index}`,
    observed_at: measuredAt,
    region_class: `region-${index % 6}`,
    area_code: String(10 + (index % 6)),
    city: index < 5 ? "부산" : `city-${index}`,
    network_profile: index % 2 === 0 ? "LTE" : "Wi-Fi",
    device_class: "mobile",
    completed: "true",
    constraint_preserved: "true",
    critical_false_positive: "false",
    actual_closed_recommended: "false",
    appointment_missed: "false",
    artifact_reference: artifact,
    reviewer_id: `field-reviewer-${index % 2}`,
  }));
  const comparisons = Array.from({ length: 20 }, (_, index) =>
    [
      ["ieoga", "120", "true"],
      ["manual_search", "260", "true"],
      ["general_ai", "180", "false"],
      ["generic_regenerator", "210", "false"],
    ].map(([method, seconds, preserved]) => ({
      ...common(),
      scenario_id: `comparison-${index}`,
      method,
      completed: "true",
      constraint_preserved: preserved,
      critical_false_positive: "false",
      completion_seconds: seconds,
      reviewer_id: `comparison-reviewer-${index % 2}`,
      artifact_reference: artifact,
    })),
  ).flat();
  const practitionerReviews = Array.from({ length: 3 }, (_, index) => ({
    ...common(),
    reviewer_id: `reviewer-${index}`,
    review_id: `review-${index}`,
    reviewer_role: ["tourism", "municipality", "accessibility"][index],
    organization_type: ["dmo", "local-government", "accessibility-group"][index],
    reviewed_at: measuredAt,
    decision: "approved",
    critical_findings_open: "0",
    artifact_reference: artifact,
  }));
  const partnerEmbedPilot = Array.from({ length: 4 }, (_, index) => ({
    ...common(),
    pilot_id: `pilot-${index}`,
    partner_id: "partner-1",
    partner_origin: "https://partner.ieoga.kr",
    browser: ["Chrome", "Safari", "Firefox", "Chrome"][index],
    device_class: "mobile",
    run_at: measuredAt,
    iframe_rendered: "true",
    session_ready: "true",
    recovery_completed: "true",
    critical_failure: "false",
    artifact_reference: artifact,
    reviewer_id: `pilot-reviewer-${index % 2}`,
  }));
  const operationsApprovals = [
    "location_service_compliance",
    "openapi_storage_permission",
    "kto_branding_confirmation",
    "privacy_legal_review",
    "managed_routing",
    "managed_geocoding",
    "managed_weather",
    "production_monitoring",
  ].map((control_id, index) => ({
    ...common(),
    control_id,
    status: "approved",
    approved_at: measuredAt,
    authority: index % 2 === 0 ? "privacy-counsel" : "operations-owner",
    artifact_reference: artifact,
    expires_at: "2099-12-31T00:00:00.000Z",
  }));
  const consentLedger = Array.from({ length: 20 }, (_, index) => ({
    ...common(),
    consent_record_id: `consent-${index}`,
    participant_id: `participant-${index}`,
    consented_at: measuredAt,
    consent_scope: "usability-research",
    withdrawn_at: "",
    withdrawal_honored: "not_applicable",
    reviewer_id: `consent-reviewer-${index % 2}`,
  }));
  return {
    tripbreak,
    performance,
    realUsers,
    fieldJourneys,
    comparisons,
    practitionerReviews,
    partnerEmbedPilot,
    operationsApprovals,
    consentLedger,
  };
}

test("CSV parser preserves quoted commas and escaped quotes", () => {
  const parsed = parseCsv('id,note\n1,"서울, 종로의 ""현장"""\n');
  assert.deepEqual(parsed.headers, ["id", "note"]);
  assert.deepEqual(parsed.rows, [{ id: "1", note: '서울, 종로의 "현장"' }]);
});

test("submission evidence gate accepts only a complete high-confidence cohort", () => {
  const result = evaluateEvidence(passingDatasets(), context);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.metrics.tripbreakScenarios, 100);
  assert.equal(result.metrics.realUsers, 20);
  assert.equal(result.metrics.fieldJourneys, 12);
  assert.equal(result.metrics.comparisonScenarios, 20);
  assert.equal(result.metrics.partnerPilotRuns, 4);
});

test("submission evidence gate fails closed on a locked-time or closed-place regression", () => {
  const datasets = passingDatasets();
  datasets.tripbreak[1].locked_appointment_preserved = "false";
  datasets.fieldJourneys[0].actual_closed_recommended = "true";
  const result = evaluateEvidence(datasets, context);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("locked_appointment_preserved")));
  assert.ok(result.errors.some((message) => message.includes("actual_closed_recommended")));
});

test("submission evidence gate rejects mixed commits and unverifiable user artifacts", () => {
  const datasets = passingDatasets();
  datasets.realUsers[0].commit_sha = "c".repeat(40);
  datasets.realUsers[0].artifact_reference = "https://example.invalid/missing";
  datasets.realUsers[0].consent_reference = "local-note.txt";
  const result = evaluateEvidence(datasets, context);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("제출 SHA")));
  assert.ok(result.errors.some((message) => message.includes("artifact_reference")));
  assert.ok(result.errors.some((message) => message.includes("consent_reference")));
});

test("submission evidence gate rejects missing, NaN, malformed boolean/date/url and duplicate rows", () => {
  const datasets = passingDatasets();
  datasets.performance[0].response_ms = "";
  datasets.performance[1].largest_contentful_paint_ms = "NaN";
  datasets.performance[2].retry_required = "maybe";
  datasets.realUsers[0].clarity_score_1_to_5 = "";
  datasets.realUsers[1].completed = "yes";
  datasets.fieldJourneys[0].observed_at = "not-a-date";
  datasets.partnerEmbedPilot[0].partner_origin = "https://partner.ieoga.kr/path";
  datasets.comparisons[1].method = datasets.comparisons[0].method;
  const result = evaluateEvidence(datasets, context);
  assert.equal(result.ok, false);
  for (const field of [
    "response_ms",
    "largest_contentful_paint_ms",
    "retry_required",
    "clarity_score_1_to_5",
    "completed",
    "observed_at",
    "partner_origin",
    "scenario_id+method",
  ]) {
    assert.ok(
      result.errors.some((message) => message.includes(field)),
      `${field} malformed value was not rejected:\n${result.errors.join("\n")}`,
    );
  }
});

test("tripbreak applies safety invariants only to eligible rows and enforces minimum denominators", () => {
  const passing = evaluateEvidence(passingDatasets(), context);
  assert.equal(passing.ok, true, passing.errors.join("\n"));
  assert.equal(passing.metrics.lockedAppointmentChecks, 56);
  assert.equal(passing.metrics.returnRouteChecks, 24);

  const insufficient = passingDatasets();
  for (const row of insufficient.tripbreak) {
    row.has_fixed_appointment = "true";
    row.return_route_verified = "not_applicable";
  }
  const result = evaluateEvidence(insufficient, context);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("역방향 복귀 경로 검증이 15건 미만")));
});

test("remote evidence requires retrievable bytes whose SHA-256 matches the URL fragment", async () => {
  const body = "verified field evidence\n";
  const digest = (await import("node:crypto"))
    .createHash("sha256")
    .update(body)
    .digest("hex");
  const reference = `https://evidence.ieoga.kr/artifacts/run.csv#sha256=${digest}`;
  const dependencies = {
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => new Response(body, { status: 200 }),
  };
  const verified = await verifyRemoteArtifactReferences([reference], dependencies);
  assert.deepEqual(verified, [
    {
      reference,
      sha256: digest,
      byteLength: Buffer.byteLength(body),
    },
  ]);

  await assert.rejects(
    verifyRemoteArtifactReferences(
      [`https://evidence.ieoga.kr/artifacts/run.csv#sha256=${"0".repeat(64)}`],
      dependencies,
    ),
    /실제 SHA-256/,
  );
  await assert.rejects(
    verifyRemoteArtifactReferences([reference], {
      ...dependencies,
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    /사설·예약 주소/,
  );
});

test("release identity requires one 100% Cloudflare version whose tag, timestamp and etag match", () => {
  const versionId = "11111111-2222-4333-8444-555555555555";
  const timestamp = "2026-08-11T00:00:00.000Z";
  const scriptEtag = "script-etag-verified-1234";
  const manifest = {
    commitSha,
    cloudflare: { versionId, scriptEtag },
  };
  const deployed = {
    source: "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION",
    versionId,
    versionTag: commitSha,
    versionTimestamp: timestamp,
  };
  const deploymentsBody = {
    success: true,
    result: {
      deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }],
    },
  };
  const versionBody = {
    success: true,
    result: {
      id: versionId,
      metadata: {
        created_on: timestamp,
        annotations: { "workers/tag": commitSha },
      },
      resources: { script: { etag: scriptEtag } },
    },
  };

  assert.deepEqual(
    verifyCloudflareReleaseControlPlane({
      manifest,
      deployed,
      deploymentsBody,
      versionBody,
    }),
    {
      workerName: "ieoga-national-travel-resilience",
      versionId,
      scriptEtag,
      trafficPercentage: 100,
    },
  );
  assert.throws(
    () =>
      verifyCloudflareReleaseControlPlane({
        manifest,
        deployed,
        deploymentsBody: {
          success: true,
          result: {
            deployments: [
              {
                versions: [
                  { version_id: versionId, percentage: 50 },
                  { version_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", percentage: 50 },
                ],
              },
            ],
          },
        },
        versionBody,
      }),
    /100%/,
  );
  assert.throws(
    () =>
      verifyCloudflareReleaseControlPlane({
        manifest,
        deployed,
        deploymentsBody,
        versionBody: {
          ...versionBody,
          result: {
            ...versionBody.result,
            resources: { script: { etag: "different-etag" } },
          },
        },
      }),
    /script etag/,
  );
});

test("release receipt canonicalization and Wrangler parsing bind one exact production artifact", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, x: ["b", "a"] } }),
    '{"a":{"x":["b","a"],"y":true},"z":1}',
  );

  const versionId = "11111111-2222-4333-8444-555555555555";
  const wrangler = parseWranglerDeployOutput(
    [
      JSON.stringify({ type: "wrangler-session", version: 1 }),
      JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "ieoga-national-travel-resilience",
        version_id: versionId,
        targets: [`${CANONICAL_DEPLOYMENT_ORIGIN}/`],
      }),
    ].join("\n"),
  );
  assert.deepEqual(wrangler, {
    versionId,
    workerName: "ieoga-national-travel-resilience",
  });
  assert.throws(
    () =>
      parseWranglerDeployOutput(
        JSON.stringify({
          type: "deploy",
          version: 1,
          worker_name: "ieoga-national-travel-resilience",
          version_id: versionId,
          targets: ["https://attacker.example"],
        }),
    ),
    /canonical production deployment/,
  );
  for (const targets of [
    [`${CANONICAL_DEPLOYMENT_ORIGIN}/api/v1/release/version`],
    [`${CANONICAL_DEPLOYMENT_ORIGIN}/`, "https://attacker.example/"],
  ]) {
    assert.throws(
      () =>
        parseWranglerDeployOutput(
          JSON.stringify({
            type: "deploy",
            version: 1,
            worker_name: "ieoga-national-travel-resilience",
            version_id: versionId,
            targets,
          }),
        ),
      /canonical production deployment/,
    );
  }
});

test("signed receipt fields must match manifest, runtime, and Cloudflare control plane", () => {
  const versionId = "11111111-2222-4333-8444-555555555555";
  const versionTimestamp = "2026-08-11T00:00:00.000Z";
  const scriptEtag = "script-etag-verified-1234";
  const bundleDigest = "d".repeat(64);
  const assetManifestDigest = "e".repeat(64);
  const receiptSha256 = "f".repeat(64);
  const prepared = {
    schemaVersion: 1,
    type: "urn:ieoga:prepared-worker-build:v1",
    commitSha,
    bundleDigest,
    assetManifestDigest,
    bundleManifestPath: RELEASE_BUNDLE_MANIFEST_PATH,
    assetManifestPath: RELEASE_ASSET_MANIFEST_PATH,
    bundleFileCount: 30,
    assetFileCount: 50,
  };
  const deployed = {
    releaseBuild: true,
    releaseReady: true,
    commitSha,
    source: "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION",
    versionId,
    versionTag: commitSha,
    versionTimestamp,
  };
  const deploymentsBody = {
    success: true,
    result: {
      deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }],
    },
  };
  const versionBody = {
    success: true,
    result: {
      id: versionId,
      metadata: {
        created_on: versionTimestamp,
        annotations: { "workers/tag": commitSha },
      },
      resources: { script: { etag: scriptEtag } },
    },
  };
  const remote = verifyRemoteReleaseIdentity({
    commitSha,
    versionId,
    deployed,
    deploymentsBody,
    versionBody,
  });
  const receipt = createReleaseReceipt({
    prepared,
    remote,
    generatedAt: "2026-08-11T00:01:00.000Z",
  });
  assert.equal(validateReleaseReceipt(receipt), receipt);

  const manifest = {
    schemaVersion: 2,
    commitSha,
    deploymentUrl: CANONICAL_DEPLOYMENT_ORIGIN,
    cloudflare: { versionId, scriptEtag },
    releaseReceipt: {
      path: "outputs/release/release-receipt.json",
      sha256: receiptSha256,
      bundleDigest,
      assetManifestDigest,
      bundleManifestPath: RELEASE_BUNDLE_MANIFEST_PATH,
      assetManifestPath: RELEASE_ASSET_MANIFEST_PATH,
    },
  };
  assert.equal(
    verifyReleaseReceiptManifest({ manifest, receipt, receiptSha256 }),
    receipt,
  );
  const cloudflareRelease = {
    workerName: "ieoga-national-travel-resilience",
    versionId,
    scriptEtag,
    trafficPercentage: 100,
  };
  assert.deepEqual(
    verifyReleaseReceiptRemote({ receipt, deployed, cloudflareRelease }),
    { bundleDigest, assetManifestDigest, receiptVersionId: versionId },
  );

  assert.throws(
    () =>
      verifyReleaseReceiptManifest({
        manifest: {
          ...manifest,
          releaseReceipt: {
            ...manifest.releaseReceipt,
            bundleDigest: "0".repeat(64),
          },
        },
        receipt,
        receiptSha256,
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      verifyReleaseReceiptRemote({
        receipt,
        deployed,
        cloudflareRelease: {
          ...cloudflareRelease,
          scriptEtag: "different-etag",
        },
      }),
    /does not match/,
  );
});

test("signed manifests bind canonical local trees and every production executable byte", async () => {
  const versionId = "11111111-2222-4333-8444-555555555555";
  const versionTimestamp = "2026-08-11T00:00:00.000Z";
  const scriptEtag = "script-etag-verified-1234";
  const bundleBytes = new Map([
    ["index.js", Buffer.from("export default { fetch() {} };\n")],
    ["wrangler.json", Buffer.from('{"main":"index.js"}\n')],
  ]);
  const assetBytes = new Map([
    ["_headers", Buffer.from("/sw.js\n  Cache-Control: no-store\n")],
    ["assets/app.css", Buffer.from("body{color:#123}\n")],
    ["assets/app.js", Buffer.from("globalThis.__IEOGA_RELEASE__=true;\n")],
    ["assets/module.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ["manifest.webmanifest", Buffer.from('{"name":"Ieoga"}\n')],
    ["sw.js", Buffer.from("self.addEventListener('fetch',()=>{});\n")],
  ]);
  const manifestFrom = (root, files) => ({
    schemaVersion: 1,
    root,
    files: [...files.entries()].map(([filePath, bytes]) => ({
      path: filePath,
      sha256: digest(bytes),
      size: bytes.byteLength,
    })),
  });
  const bundleManifest = manifestFrom("dist/server", bundleBytes);
  const assetManifest = manifestFrom("dist/client", assetBytes);
  const prepared = {
    schemaVersion: 1,
    type: "urn:ieoga:prepared-worker-build:v1",
    commitSha,
    bundleDigest: digest(Buffer.from(canonicalJson(bundleManifest), "utf8")),
    assetManifestDigest: digest(
      Buffer.from(canonicalJson(assetManifest), "utf8"),
    ),
    bundleManifestPath: RELEASE_BUNDLE_MANIFEST_PATH,
    assetManifestPath: RELEASE_ASSET_MANIFEST_PATH,
    bundleFileCount: bundleManifest.files.length,
    assetFileCount: assetManifest.files.length,
  };
  const receipt = createReleaseReceipt({
    prepared,
    remote: {
      versionId,
      scriptEtag,
      versionTimestamp,
      trafficPercentage: 100,
    },
    generatedAt: "2026-08-11T00:01:00.000Z",
  });
  assert.deepEqual(
    verifyReleaseArtifactManifests({
      receipt,
      bundleManifest,
      assetManifest,
    }),
    {
      bundleDigest: prepared.bundleDigest,
      assetManifestDigest: prepared.assetManifestDigest,
      bundleFileCount: 2,
      assetFileCount: 6,
    },
  );

  const html = Buffer.from(
    '<!doctype html><link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>',
  );
  const fetched = [];
  const makeFetch = ({ tamperPath = "", redirectPath = "", htmlBody = html } = {}) =>
    async (input, options) => {
      const url = new URL(String(input));
      fetched.push({ pathname: url.pathname, options });
      if (url.pathname === redirectPath) {
        return new Response(null, {
          status: 302,
          headers: { location: `${CANONICAL_DEPLOYMENT_ORIGIN}/attacker` },
        });
      }
      let bytes;
      let contentType = "application/octet-stream";
      if (["/", "/app", "/flow", "/plan", "/embed/recover"].includes(url.pathname)) {
        bytes = htmlBody;
        contentType = "text/html; charset=utf-8";
      } else {
        const filePath = decodeURIComponent(url.pathname.slice(1));
        bytes = assetBytes.get(filePath);
      }
      if (!bytes) return new Response("not found", { status: 404 });
      if (url.pathname === tamperPath) bytes = Buffer.from("tampered");
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": contentType,
        },
      });
    };

  assert.deepEqual(
    await verifyProductionAssetManifest(assetManifest, {
      fetchImpl: makeFetch(),
    }),
    {
      executableAssetCount: 5,
      verifiedHtmlRouteCount: 5,
      referencedExecutableAssetCount: 2,
    },
  );
  assert.equal(fetched.some((entry) => entry.pathname === "/_headers"), false);
  assert.equal(
    fetched.every(
      (entry) =>
        entry.options.redirect === "error" &&
        entry.options.headers["accept-encoding"] === "identity",
    ),
    true,
  );

  await assert.rejects(
    verifyProductionAssetManifest(assetManifest, {
      fetchImpl: makeFetch({ tamperPath: "/assets/app.js" }),
    }),
    /asset bytes do not match/,
  );
  await assert.rejects(
    verifyProductionAssetManifest(assetManifest, {
      fetchImpl: makeFetch({ redirectPath: "/sw.js" }),
    }),
    /returned HTTP 302 or redirected/,
  );
  await assert.rejects(
    verifyProductionAssetManifest(assetManifest, {
      fetchImpl: makeFetch({
        htmlBody: Buffer.from('<script src="/assets/not-signed.js"></script>'),
      }),
    }),
    /absent from the signed manifest/,
  );
  assert.throws(
    () =>
      verifyReleaseArtifactManifests({
        receipt: { ...receipt, assetManifestDigest: "0".repeat(64) },
        bundleManifest,
        assetManifest,
      }),
    /does not match the signed release receipt/,
  );
});

test("attestation verification pins repo, workflow, main source commit, and hosted runner", () => {
  const calls = [];
  const result = verifyReleaseReceiptAttestation(
    { absolutePath: "/tmp/release-receipt.json", commitSha },
    (command, args, options) => {
      calls.push({ command, args, options });
      return "verified";
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gh");
  assert.deepEqual(calls[0].args, [
    "attestation",
    "verify",
    "/tmp/release-receipt.json",
    "--repo",
    RELEASE_ATTESTATION_REPOSITORY,
    "--signer-repo",
    RELEASE_ATTESTATION_REPOSITORY,
    "--signer-workflow",
    RELEASE_ATTESTATION_WORKFLOW,
    "--source-digest",
    commitSha,
    "--source-ref",
    RELEASE_ATTESTATION_SOURCE_REF,
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--deny-self-hosted-runners",
  ]);
  assert.equal(result.selfHostedRunnerDenied, true);
  assert.throws(
    () =>
      verifyReleaseReceiptAttestation(
        { absolutePath: "/tmp/release-receipt.json", commitSha },
        () => {
          throw new Error("untrusted attestation");
        },
      ),
    /required GitHub-hosted main-branch build provenance/,
  );
});

test("production release workflow builds once and deploys that artifact without rebundling", async () => {
  const [workflow, playwrightConfig, packageSource] = await Promise.all([
    readFile(
      new URL("../.github/workflows/release-production.yml", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../playwright.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.equal(
    workflow.match(/run:\s*npm run build\s*$/gm)?.length,
    1,
    "the production workflow must have exactly one build step",
  );
  for (const contract of [
    /runs-on:\s*ubuntu-latest/,
    /github\.ref == 'refs\/heads\/main'/,
    /environment:\s*production/,
    /npm run test:coverage/,
    /npm run evidence:structure/,
    /npx --no-install playwright install --with-deps chromium/,
    /npm run test:e2e/,
    /node scripts\/release-identity\.mjs prepare/,
    /wrangler d1 migrations apply site-creator-d1/,
    /--remote/,
    /npx --no-install wrangler deploy dist\/server\/index\.js/,
    /--no-bundle/,
    /--assets dist\/client/,
    /--tag "\$GITHUB_SHA"/,
    /--keep-vars/,
    /node scripts\/release-identity\.mjs finalize/,
    /uses:\s*actions\/attest@[a-f0-9]{40}\s+# v4/,
    /subject-path:\s*outputs\/release\/release-receipt\.json/,
  ]) {
    assert.match(workflow, contract);
  }
  assert.doesNotMatch(
    workflow,
    /^\s*uses:\s*actions\/[a-z-]+@v\d+\s*$/gm,
    "trusted release actions must use immutable full commit SHAs",
  );
  const deployIndex = workflow.indexOf("npx --no-install wrangler deploy");
  const cloudflareSecretReferences = [
    ...workflow.matchAll(/CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/g),
  ];
  assert.equal(cloudflareSecretReferences.length, 3);
  assert.equal(
    cloudflareSecretReferences.every(
      (match) =>
        match.index > workflow.indexOf("Canonically hash the exact worker"),
    ),
    true,
    "Cloudflare edit credentials may only enter deploy/finalize steps after untrusted build tooling",
  );
  for (const command of [
    "npm run test:coverage",
    "npm run evidence:structure",
    "npm run test:e2e",
  ]) {
    assert.ok(
      workflow.indexOf(command) > workflow.indexOf("npm run build") &&
        workflow.indexOf(command) < deployIndex,
      `${command} must run after the single build and before deployment`,
    );
  }
  assert.ok(
    workflow.indexOf("wrangler d1 migrations apply") >
      workflow.indexOf("Canonically hash the exact worker") &&
      workflow.indexOf("wrangler d1 migrations apply") < deployIndex,
    "remote D1 migrations must run only after verification and before worker deployment",
  );
  for (const viewport of ["mobile-360", "mobile-390", "tablet-768", "desktop-1280"]) {
    assert.match(playwrightConfig, new RegExp(`name: ["']${viewport}["']`));
  }
  const scripts = JSON.parse(packageSource).scripts;
  for (const command of ["test:coverage", "test:e2e", "evidence:structure"]) {
    assert.doesNotMatch(
      scripts[command],
      /(?:^|\s)(?:npm\s+run\s+)?build(?:\s|$)/,
      `${command} may not rebuild the attested dist tree`,
    );
  }
});
