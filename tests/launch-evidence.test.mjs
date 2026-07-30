import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

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
