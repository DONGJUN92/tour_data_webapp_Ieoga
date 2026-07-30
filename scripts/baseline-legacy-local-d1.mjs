import { spawnSync } from "node:child_process";
import path from "node:path";

const database = "site-creator-d1";
const executable = process.execPath;
const wranglerCli = path.resolve(
  process.cwd(),
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);

function executeSql(sql) {
  const result = spawnSync(
    executable,
    [
      wranglerCli,
      "d1",
      "execute",
      database,
      "--local",
      "--command",
      sql,
      "--json",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: "false",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        "Legacy D1 baseline inspection failed.",
    );
  }
  const jsonStart = result.stdout.indexOf("[");
  if (jsonStart < 0) {
    throw new Error("Wrangler did not return a JSON result.");
  }
  return JSON.parse(result.stdout.slice(jsonStart))[0]?.results ?? [];
}

const migrations = executeSql(
  "SELECT id, name FROM d1_migrations ORDER BY id;",
);
if (migrations.length > 0) {
  console.log("Local D1 already has migration history; no baseline change was made.");
  process.exit(0);
}

const actualTables = new Set(
  executeSql(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  ).map((row) => row.name),
);
const legacyTables = [
  "_cf_METADATA",
  "administrative_areas",
  "api_audit_logs",
  "consent_events",
  "d1_migrations",
  "partner_clients",
  "partner_usage_daily",
  "proof_shares",
  "recovery_options",
  "recovery_runs",
  "region_packs",
  "region_policy_snapshots",
  "sessions",
  "source_health",
  "sync_partitions",
];
const unexpectedTables = [...actualTables].filter(
  (table) => !legacyTables.includes(table),
);
const missingTables = legacyTables.filter(
  (table) => !actualTables.has(table),
);
if (unexpectedTables.length || missingTables.length) {
  throw new Error(
    "Local D1 is not the verified pre-migration IEOGA schema. No baseline change was made.",
  );
}

const expectedColumns = {
  recovery_runs: [
    "id",
    "session_id",
    "incident",
    "audience",
    "region_code",
    "district_code",
    "time_budget_bucket",
    "distance_bucket",
    "indoor_required",
    "status",
    "rule_version",
    "option_count",
    "rejected_count",
    "analytics_eligible",
    "failure_code",
    "created_at",
    "completed_at",
    "expires_at",
    "deleted_at",
  ],
  recovery_options: [
    "id",
    "run_id",
    "rank",
    "content_id",
    "title",
    "content_type_id",
    "status",
    "score",
    "distance_bucket",
    "travel_minutes_bucket",
    "accessibility_status",
    "crowd_status",
    "source_names_json",
    "created_at",
  ],
  region_packs: [
    "id",
    "region_code",
    "district_code",
    "base_month",
    "calculation_version",
    "object_key",
    "checksum",
    "status",
    "coverage_percent",
    "source_updated_at",
    "activated_at",
    "created_at",
  ],
  region_policy_snapshots: [
    "id",
    "region_code",
    "district_code",
    "base_month",
    "status",
    "coverage_percent",
    "metrics_json",
    "source_ledger_json",
    "calculation_version",
    "checksum",
    "r2_key",
    "created_at",
  ],
};
for (const [table, expected] of Object.entries(expectedColumns)) {
  const actual = executeSql(`PRAGMA table_info(${table});`).map(
    (row) => row.name,
  );
  if (
    actual.length !== expected.length ||
    actual.some((column, index) => column !== expected[index])
  ) {
    throw new Error(
      `Local D1 table ${table} does not match the verified legacy schema. No baseline change was made.`,
    );
  }
}

executeSql(
  "INSERT INTO d1_migrations (id, name) VALUES (1, '0000_wild_star_brand.sql');",
);
console.log(
  "Verified the legacy local D1 schema and recorded migration 0000 without changing application data.",
);
