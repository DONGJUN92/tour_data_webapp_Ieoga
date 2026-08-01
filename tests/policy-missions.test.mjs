import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));

const { env } = await import("./cloudflare-workers.stub.mjs");
const {
  buildMissionCandidates,
  FAILURE_CATEGORIES,
  isSameMissionScenario,
  MINIMUM_BEHAVIOR_SAMPLE,
  revalidateMissionScenario,
  selectRecommendedPlan,
  updateMissionWorkflow,
} = await import("../lib/insights/missions.ts");
const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

class FakeD1 {
  constructor(allResults = []) {
    this.allResults = [...allResults];
    this.executedStatements = [];
  }

  prepare(sql) {
    return {
      bind: (...params) => ({
        raw: async () => this.allResults.shift() ?? [],
        all: async () => ({
          results: this.allResults.shift() ?? [],
        }),
        run: async () => {
          this.executedStatements.push({ sql, params });
          return { success: true, results: [], meta: {} };
        },
      }),
    };
  }
}

function storedMissionRow(overrides = {}) {
  const actionEvidence = overrides.actionEvidence ?? {};
  return [
    "mission:resilience-mission-2026.07-v1:11:11110:policy_evidence_gap",
    "11",
    "11110",
    "policy_evidence_gap",
    "data_gap",
    overrides.status ?? "in_progress",
    90,
    "공식 근거 개선",
    "공식 데이터 공백",
    "동일 조건 재실행",
    "한국관광공사 관광데이터 운영 담당",
    "공식 관광데이터 품질 책임자",
    "2026-07-30T00:00:00.000Z",
    "필수 공식 지표가 모두 응답해야 합니다.",
    "OpenAPI 감사 ID와 조치 전후 비교가 필요합니다.",
    JSON.stringify({
      id: "mission:resilience-mission-2026.07-v1:11:11110:policy_evidence_gap",
      scope: { areaCode: "11", districtCode: "11110" },
      missionType: "policy_evidence_gap",
      calculationVersion: "resilience-mission-2026.07-v1",
      evaluator: {
        metric: "official_evidence_coverage",
        betterWhen: "higher",
        activationRule: "공식 근거 누락",
        observationWindow: "official_base_month",
      },
    }),
    JSON.stringify(actionEvidence),
    overrides.actionRecordedAt ?? null,
    overrides.lastRevalidatedAt ?? null,
    overrides.lastRevalidationResult ?? null,
    overrides.revalidationCount ?? 0,
    "{}",
    "[]",
    JSON.stringify({
      interventionId: "test",
      title: "테스트 조치",
      rationale: "테스트",
      objective: {
        minimize: [
          "estimated_effort",
          "estimated_time",
          "uncertainty",
        ],
        maximize: "evidence_or_recovery_gaps_closed",
        score: 1,
      },
    }),
    overrides.baselineValue ?? 50,
    overrides.currentValue ?? 50,
    overrides.sampleSize ?? 0,
    30,
    "official_only",
    "202606",
    "resilience-mission-2026.07-v1",
    "2026-07-16T00:00:00.000Z",
    overrides.lastEvaluatedAt ?? "2026-07-16T00:00:00.000Z",
    overrides.resolvedAt ?? null,
    "2026-07-16T00:00:00.000Z",
    "2026-07-16T00:00:00.000Z",
  ];
}

function policyPayload() {
  return {
    scope: "nationwide",
    areaCode: "11",
    districtCode: "11110",
    regionName: "서울특별시",
    districtName: "종로구",
    status: "live",
    coverage: {
      available: 8,
      expected: 8,
      percent: 100,
      meaning: "공식 근거 확인 비율",
    },
    baseYm: "202606",
    metrics: Array.from({ length: 7 }, (_, index) => ({
      key: `metric-${index + 1}`,
      label: `지표 ${index + 1}`,
      officialName: `공식 지표 ${index + 1}`,
      value: index + 1,
      valueRaw: String(index + 1),
      source: "AreaTarDemDsService",
      operation: "areaTarSjrnDsList",
      baseYm: "202606",
    })),
    hubs: [
      {
        name: "공식 중심 관광지",
        rank: 1,
        category: "문화",
        latitude: 37.57,
        longitude: 126.98,
      },
    ],
    sourceLedger: [],
    warnings: [],
    generatedAt: "2026-07-16T00:00:00.000Z",
    calculationVersion: "policy-evidence-2026.07-v1",
  };
}

function aggregate(overrides = {}) {
  return {
    eligibleCount: 0,
    noCandidateCount: 0,
    upstreamUnavailableCount: 0,
    totalOptionCount: 0,
    totalRejectedCount: 0,
    mobilityEligibleCount: 0,
    mobilityNoCandidateCount: 0,
    incidents: {},
    audiences: {},
    outcomeRunCount: 0,
    arrivedCount: 0,
    continuedCount: 0,
    abandonedCount: 0,
    arrivedOnTimeCount: 0,
    arrivedWithTimingCount: 0,
    mobilityOutcomeCount: 0,
    mobilityAbandonedCount: 0,
    ...overrides,
  };
}

test("behavior missions suppress all sub-threshold counts", () => {
  const missions = buildMissionCandidates(
    policyPayload(),
    aggregate({ eligibleCount: MINIMUM_BEHAVIOR_SAMPLE - 1 }),
  );
  const recovery = missions.find(
    (mission) => mission.missionType === "recovery_scenario_gap",
  );

  assert.equal(recovery.active, false);
  assert.equal(recovery.inactiveStatus, "suppressed");
  assert.equal(recovery.sampleSize, 0);
  assert.equal(recovery.currentValue, null);
  assert.deepEqual(recovery.evidence, {
    evidenceKind: "suppressed_behavior_aggregate",
    privacyState: "below_threshold",
    minimumSampleSize: 30,
  });
});

test("generated options and actual continuity outcomes remain separate metrics", () => {
  const missions = buildMissionCandidates(
    policyPayload(),
    aggregate({
      eligibleCount: 30,
      noCandidateCount: 3,
      totalOptionCount: 54,
      outcomeRunCount: 30,
      arrivedCount: 8,
      continuedCount: 10,
      abandonedCount: 12,
    }),
  );
  const generated = missions.find(
    (mission) => mission.missionType === "recovery_scenario_gap",
  );
  const outcome = missions.find(
    (mission) => mission.missionType === "continuity_outcome_gap",
  );

  assert.equal(generated.currentValue, 10);
  assert.equal(generated.active, false);
  assert.equal(outcome.currentValue, 40);
  assert.equal(outcome.active, true);
  assert.match(outcome.evidence.interpretation, /도착·여행 지속·중단/);
});

test("every mission exposes deterministic 2–4 option minimum-intervention logic", () => {
  const missions = buildMissionCandidates(
    policyPayload(),
    aggregate({
      eligibleCount: 30,
      noCandidateCount: 15,
      totalOptionCount: 30,
      outcomeRunCount: 30,
      abandonedCount: 12,
      continuedCount: 18,
      mobilityEligibleCount: 30,
      mobilityNoCandidateCount: 9,
      audiences: { wheelchair: 30 },
    }),
  );

  for (const mission of missions) {
    assert.ok(mission.interventions.length >= 2);
    assert.ok(mission.interventions.length <= 4);
    assert.deepEqual(
      mission.recommendedPlan,
      selectRecommendedPlan(mission.interventions),
    );
  }
});

test("every mission has exactly one four-category failure classification and an executable contract", () => {
  const missions = buildMissionCandidates(
    policyPayload(),
    aggregate({
      eligibleCount: 30,
      noCandidateCount: 15,
      outcomeRunCount: 30,
      abandonedCount: 12,
      mobilityEligibleCount: 30,
      mobilityNoCandidateCount: 9,
    }),
  );

  assert.deepEqual(
    [...new Set(missions.map((mission) => mission.failureCategory))].sort(),
    [...FAILURE_CATEGORIES].sort(),
  );
  for (const mission of missions) {
    assert.ok(FAILURE_CATEGORIES.includes(mission.failureCategory));
    assert.equal(mission.scenario.id, mission.id);
    assert.equal(
      mission.scenario.missionType,
      mission.missionType,
    );
    assert.equal(mission.scenario.scope.areaCode, mission.regionCode);
    assert.equal(
      mission.scenario.scope.districtCode,
      mission.districtCode,
    );
    assert.equal(
      mission.scenario.parameters.failureCategory,
      mission.failureCategory,
    );
    assert.ok(mission.actionContract.ownerOrganization.length >= 2);
    assert.ok(mission.actionContract.ownerRole.length >= 2);
    assert.ok(
      new Date(mission.actionContract.deadlineAt).getTime() >
        new Date(policyPayload().generatedAt).getTime(),
    );
    assert.ok(mission.actionContract.successCondition.length >= 20);
    assert.ok(mission.actionContract.evidenceRequirement.length >= 20);
  }
});

test("same-scenario guard rejects changed scope or evaluator version", () => {
  const mission = buildMissionCandidates(
    policyPayload(),
    aggregate(),
  )[0];
  const scenario = mission.scenario;

  assert.equal(
    isSameMissionScenario(scenario, structuredClone(scenario)),
    true,
  );
  const changedScope = structuredClone(scenario);
  changedScope.scope.districtCode = "11140";
  assert.equal(isSameMissionScenario(scenario, changedScope), false);
  const changedVersion = structuredClone(scenario);
  changedVersion.calculationVersion = "future-rule";
  assert.equal(isSameMissionScenario(scenario, changedVersion), false);
});

test("ready-for-recheck transition is blocked until an operator records evidence", async () => {
  const missionId =
    "mission:resilience-mission-2026.07-v1:11:11110:policy_evidence_gap";
  env.DB = new FakeD1([[[...storedMissionRow()]]]);

  await assert.rejects(
    updateMissionWorkflow({
      missionId,
      status: "ready_for_recheck",
      note: "조치 완료",
    }),
    (error) => error?.code === "ACTION_EVIDENCE_REQUIRED",
  );

  const evidence = {
    actionSummary:
      "누락된 공식 지표 레코드를 보완하고 동일 API 응답을 확인했습니다.",
    artifactReferences: [
      "api-audit:policy-fix-2026-07-17",
      "official-record:tour-data-1024",
    ],
    occurredAt: "2026-07-17T01:00:00.000Z",
    recordedBy: "관광데이터 운영자",
  };
  const updatedRow = storedMissionRow({
    status: "ready_for_recheck",
    actionEvidence: evidence,
    actionRecordedAt: "2026-07-17T01:10:00.000Z",
  });
  const fake = new FakeD1([
    [[...storedMissionRow()]],
    [[...updatedRow]],
  ]);
  env.DB = fake;
  const mission = await updateMissionWorkflow({
    missionId,
    status: "ready_for_recheck",
    note: "공식 데이터 보완 완료",
    actionEvidence: evidence,
  });

  assert.equal(mission?.status, "ready_for_recheck");
  assert.deepEqual(mission?.actionEvidence, {
    actionSummary: evidence.actionSummary,
    evidenceCount: 2,
    occurredAt: evidence.occurredAt,
  });
  assert.equal(
    JSON.stringify(mission?.actionEvidence).includes(
      "api-audit:policy-fix-2026-07-17",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(mission?.actionEvidence).includes(
      "관광데이터 운영자",
    ),
    false,
  );
  const writes = JSON.stringify(fake.executedStatements);
  assert.match(writes, /action_recorded/);
  assert.match(writes, /api-audit:policy-fix-2026-07-17/);
  assert.match(writes, /status_changed/);
});

test("evidence-backed rerun evaluates only the stored mission scenario and writes a receipt", async () => {
  const missionId =
    "mission:resilience-mission-2026.07-v1:11:11110:policy_evidence_gap";
  const evidence = {
    actionSummary:
      "누락된 공식 지표 레코드를 보완하고 동일 API 응답을 확인했습니다.",
    artifactReferences: ["api-audit:policy-fix-2026-07-17"],
    occurredAt: "2026-07-17T01:00:00.000Z",
    recordedBy: "관광데이터 운영자",
  };
  const readyRow = storedMissionRow({
    status: "ready_for_recheck",
    actionEvidence: evidence,
    actionRecordedAt: "2026-07-17T01:10:00.000Z",
  });
  const resolvedRow = storedMissionRow({
    status: "resolved",
    actionEvidence: evidence,
    actionRecordedAt: "2026-07-17T01:10:00.000Z",
    lastRevalidatedAt: "2026-07-17T01:20:00.000Z",
    lastRevalidationResult: "improved",
    revalidationCount: 1,
    currentValue: 100,
    lastEvaluatedAt: "2026-07-17T01:20:00.000Z",
    resolvedAt: "2026-07-17T01:20:00.000Z",
  });
  const fake = new FakeD1([
    [[...readyRow]],
    [],
    [],
    [[...resolvedRow]],
  ]);
  env.DB = fake;

  const result = await revalidateMissionScenario(
    missionId,
    policyPayload(),
    "공식 레코드 보완 후 동일 조건 재검증",
  );

  assert.equal(result?.receipt.sameScenario, true);
  assert.equal(result?.receipt.scenarioId, missionId);
  assert.equal(result?.receipt.previousStatus, "ready_for_recheck");
  assert.equal(result?.receipt.nextStatus, "resolved");
  assert.equal(result?.receipt.baselineValue, 50);
  assert.equal(result?.receipt.evaluatedValue, 100);
  assert.equal(result?.receipt.result, "improved");
  const writes = JSON.stringify(fake.executedStatements);
  assert.match(writes, /scenario_revalidated/);
  assert.match(writes, /sameScenario/);
  assert.match(writes, /api-audit:policy-fix-2026-07-17/);
});

test("operator workflow records evidence before authenticated mission-specific rerun", async () => {
  const workflowRoute = await source(
    "app/api/v1/ops/missions/[missionId]/route.ts",
  );
  const revalidateRoute = await source(
    "app/api/v1/ops/missions/[missionId]/revalidate/route.ts",
  );
  const missionService = await source("lib/insights/missions.ts");
  const migration = await source(
    "drizzle/0006_marvelous_tyger_tiger.sql",
  );

  assert.match(workflowRoute, /authenticateOps/);
  assert.match(workflowRoute, /actionEvidence/);
  assert.match(workflowRoute, /artifactReferences/);
  assert.match(missionService, /ACTION_EVIDENCE_REQUIRED/);
  assert.match(missionService, /eventType:\s*"action_recorded"/);
  assert.match(revalidateRoute, /authenticateOps/);
  assert.match(
    revalidateRoute,
    /mission\.scenario\.scope\.areaCode/,
  );
  assert.match(revalidateRoute, /revalidateMissionScenario/);
  assert.doesNotMatch(revalidateRoute, /areaCode:\s*z\./);
  assert.match(missionService, /isSameMissionScenario/);
  assert.match(missionService, /sameScenario:\s*true/);
  assert.match(
    missionService,
    /eventType:\s*"scenario_revalidated"/,
  );
  assert.match(migration, /failure_category/);
  assert.match(migration, /owner_organization/);
  assert.match(migration, /success_condition/);
  assert.match(migration, /scenario_json/);
});

test("0006 migration backfills executable contracts for existing missions", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE resilience_missions (
      id text PRIMARY KEY NOT NULL,
      region_code text NOT NULL,
      district_code text NOT NULL,
      mission_type text NOT NULL,
      status text NOT NULL,
      first_detected_at text NOT NULL,
      calculation_version text NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO resilience_missions (
      id,
      region_code,
      district_code,
      mission_type,
      status,
      first_detected_at,
      calculation_version
    ) VALUES (?, '11', '11110', ?, 'open', '2026-07-16T00:00:00.000Z', 'resilience-mission-2026.07-v1')
  `);
  for (const missionType of [
    "policy_evidence_gap",
    "hub_evidence_gap",
    "recovery_scenario_gap",
    "continuity_outcome_gap",
    "mobility_recovery_gap",
  ]) {
    insert.run(`mission:${missionType}`, missionType);
  }
  const migration = await source(
    "drizzle/0006_marvelous_tyger_tiger.sql",
  );
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const rows = db
    .prepare(
      `SELECT
        failure_category,
        owner_organization,
        deadline_at,
        success_condition,
        evidence_requirement,
        json_extract(scenario_json, '$.parameters.failureCategory') AS scenario_failure
      FROM resilience_missions
      ORDER BY mission_type`,
    )
    .all();
  assert.equal(rows.length, 5);
  assert.deepEqual(
    [...new Set(rows.map((row) => row.failure_category))].sort(),
    [...FAILURE_CATEGORIES].sort(),
  );
  for (const row of rows) {
    assert.ok(String(row.owner_organization).length >= 2);
    assert.notEqual(row.deadline_at, "1970-01-01T00:00:00.000Z");
    assert.ok(String(row.success_condition).length >= 20);
    assert.ok(String(row.evidence_requirement).length >= 20);
    assert.equal(row.scenario_failure, row.failure_category);
  }
  db.close();
});

test("0007 migration creates authenticated evidence and durable rate windows", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE recovery_options (id text PRIMARY KEY NOT NULL);",
  );
  const migration = await source(
    "drizzle/0007_field_evidence_registry.sql",
  );
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes("field_evidence_registry"));
  assert.ok(tables.includes("durable_rate_limit_windows"));

  const evidenceColumns = db
    .prepare("PRAGMA table_info(field_evidence_registry)")
    .all()
    .map((row) => row.name);
  for (const column of [
    "evidence_type",
    "sample_size",
    "regions_json",
    "metrics_json",
    "artifact_reference",
    "reviewers_json",
    "measured_at",
    "reviewed_at",
    "validated",
  ]) {
    assert.ok(evidenceColumns.includes(column), column);
  }
  assert.ok(
    db
      .prepare("PRAGMA table_info(recovery_options)")
      .all()
      .some((row) => row.name === "application_snapshot_json"),
  );
  db.close();
});

test("0008 migration makes independent field evidence audit durable", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE field_evidence_registry (id text PRIMARY KEY NOT NULL, evidence_type text NOT NULL);",
  );
  const migration = await source(
    "drizzle/0008_independent_evidence_audit.sql",
  );
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const columns = db
    .prepare("PRAGMA table_info(field_evidence_registry)")
    .all();
  const byName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(byName.get("independent_audit_status")?.notnull, 1);
  assert.equal(byName.get("independent_audit_status")?.dflt_value, "'pending'");
  for (const column of ["approved_at", "approved_by", "audit_notes"]) {
    assert.ok(byName.has(column), column);
  }
  const indexes = db
    .prepare("PRAGMA index_list(field_evidence_registry)")
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("field_evidence_audit_status_idx"));
  db.close();
});

test("policy sync always prioritizes aggregate region packs and recovers leases", async () => {
  const sync = await source("lib/sync/policy-sync.ts");

  assert.match(sync, /districtCode:\s*"_all"/);
  assert.match(
    sync,
    /CASE WHEN \$\{syncPartitions\.districtCode\} = '_all' THEN 0 ELSE 1 END/,
  );
  assert.match(sync, /eq\(syncPartitions\.status,\s*"running"\)/);
  assert.match(sync, /eq\(syncPartitions\.nextRunAt,\s*leaseUntil\)/);
  assert.match(sync, /failedRegionCodes/);
  assert.match(sync, /resumeTargets/);
  assert.match(sync, /isNotNull\(administrativeAreas\.sourceUpdatedAt\)/);
  assert.match(sync, /districts = await getDistricts\(regionCode\)/);
  assert.match(sync, /catch \{[\s\S]*continue;/);
});

test("policy region list truthfully describes read-only scheduled packs", async () => {
  const route = await source("app/api/v1/insights/regions/route.ts");
  assert.match(route, /scheduled_region_pack/);
  assert.match(route, /scheduled_versioned_region_pack/);
  assert.match(route, /운영 동기화가 생성한 최신 검증 지역팩/);
  assert.doesNotMatch(route, /선택하면[^\n]*실시간 조회/);
});

test("0007 Drizzle snapshot matches its migration additions", async () => {
  const snapshot = JSON.parse(
    await source("drizzle/meta/0007_snapshot.json"),
  );
  assert.ok(snapshot.tables.durable_rate_limit_windows);
  assert.ok(snapshot.tables.field_evidence_registry);
  assert.ok(
    snapshot.tables.recovery_options.columns.application_snapshot_json,
  );
  assert.equal(snapshot.version, "6");
});

test("0008 Drizzle snapshot matches independent audit additions", async () => {
  const snapshot = JSON.parse(
    await source("drizzle/meta/0008_snapshot.json"),
  );
  const table = snapshot.tables.field_evidence_registry;
  assert.equal(
    table.columns.independent_audit_status.default,
    "'pending'",
  );
  assert.equal(table.columns.independent_audit_status.notNull, true);
  assert.ok(table.columns.approved_at);
  assert.ok(table.columns.approved_by);
  assert.ok(table.columns.audit_notes);
  assert.ok(table.indexes.field_evidence_audit_status_idx);
});
