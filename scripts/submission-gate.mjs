import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  RELEASE_ASSET_MANIFEST_PATH,
  RELEASE_ATTESTATION_REPOSITORY,
  RELEASE_ATTESTATION_SOURCE_REF,
  RELEASE_ATTESTATION_WORKFLOW,
  RELEASE_BUNDLE_MANIFEST_PATH,
  RELEASE_RECEIPT_PATH,
  validateReleaseReceipt,
} from "./release-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CANONICAL_DEPLOYMENT_ORIGIN =
  "https://ieoga-national-travel-resilience.sans5-poems-5045.workers.dev";
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const CLOUDFLARE_WORKER_NAME = "ieoga-national-travel-resilience";
const WORKER_VERSION_ID_PATTERN = /^[a-f0-9][a-f0-9-]{15,63}$/i;
const REQUIRED_ARTIFACTS = {
  tripbreak: "evidence/templates/tripbreak-runs.csv",
  performance: "evidence/templates/performance-runs.csv",
  realUsers: "evidence/templates/real-user-runs.csv",
  fieldJourneys: "evidence/templates/field-journeys.csv",
  comparisons: "evidence/templates/comparison-runs.csv",
  practitionerReviews: "evidence/templates/practitioner-reviews.csv",
  partnerEmbedPilot: "evidence/templates/partner-embed-pilot.csv",
  operationsApprovals: "evidence/templates/operations-approvals.csv",
  consentLedger: "evidence/templates/consent-ledger.csv",
};

const REQUIRED_HEADERS = {
  tripbreak: [
    "scenario_id",
    "run_at",
    "commit_sha",
    "deployment_url",
    "region_class",
    "area_code",
    "incident",
    "audience",
    "has_fixed_appointment",
    "request_id",
    "rule_version",
    "result_status",
    "option_count",
    "response_ms",
    "locked_appointment_preserved",
    "availability_fail_closed",
    "return_route_verified",
    "critical_false_positive",
  ],
  performance: [
    "measurement_id",
    "measured_at",
    "commit_sha",
    "deployment_url",
    "device_class",
    "browser",
    "viewport_width",
    "network_profile",
    "flow",
    "repetition",
    "response_ms",
    "largest_contentful_paint_ms",
    "interaction_to_next_paint_ms",
    "cumulative_layout_shift",
    "retry_required",
    "error_code",
  ],
  realUsers: [
    "participant_id",
    "user_segment",
    "locale",
    "device_class",
    "first_time_visitor",
    "task_id",
    "started_at",
    "completed",
    "completion_seconds",
    "constraint_preserved",
    "critical_safety_incident",
    "clarity_score_1_to_5",
    "trust_score_1_to_5",
    "artifact_reference",
    "consent_reference",
    "commit_sha",
    "deployment_url",
  ],
  fieldJourneys: [
    "journey_id",
    "participant_id",
    "observed_at",
    "region_class",
    "area_code",
    "city",
    "network_profile",
    "device_class",
    "completed",
    "constraint_preserved",
    "critical_false_positive",
    "actual_closed_recommended",
    "appointment_missed",
    "artifact_reference",
    "reviewer_id",
    "commit_sha",
    "deployment_url",
  ],
  comparisons: [
    "scenario_id",
    "method",
    "completed",
    "constraint_preserved",
    "critical_false_positive",
    "completion_seconds",
    "reviewer_id",
    "artifact_reference",
    "commit_sha",
    "deployment_url",
  ],
  practitionerReviews: [
    "review_id",
    "reviewer_id",
    "reviewer_role",
    "organization_type",
    "reviewed_at",
    "decision",
    "critical_findings_open",
    "artifact_reference",
    "commit_sha",
    "deployment_url",
  ],
  partnerEmbedPilot: [
    "pilot_id",
    "partner_id",
    "partner_origin",
    "browser",
    "device_class",
    "run_at",
    "iframe_rendered",
    "session_ready",
    "recovery_completed",
    "critical_failure",
    "artifact_reference",
    "reviewer_id",
    "commit_sha",
    "deployment_url",
  ],
  operationsApprovals: [
    "control_id",
    "status",
    "approved_at",
    "authority",
    "artifact_reference",
    "expires_at",
    "commit_sha",
    "deployment_url",
  ],
  consentLedger: [
    "consent_record_id",
    "participant_id",
    "consented_at",
    "consent_scope",
    "withdrawn_at",
    "withdrawal_honored",
    "reviewer_id",
    "commit_sha",
    "deployment_url",
  ],
};

const REQUIRED_METHODS = new Set([
  "ieoga",
  "manual_search",
  "general_ai",
  "generic_regenerator",
]);
const REQUIRED_CONTROLS = new Set([
  "location_service_compliance",
  "openapi_storage_permission",
  "kto_branding_confirmation",
  "privacy_legal_review",
  "managed_routing",
  "managed_geocoding",
  "managed_weather",
  "production_monitoring",
]);

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error("닫히지 않은 CSV 인용부호가 있습니다.");
  values.push(current);
  return values.map((value) => value.trim());
}

export function parseCsv(source) {
  const lines = source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line, index) => {
    const values = splitCsvLine(line);
    if (values.length !== headers.length) {
      throw new Error(
        `CSV ${index + 2}행의 열 수(${values.length})가 헤더(${headers.length})와 다릅니다.`,
      );
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
  return { headers, rows };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const STRICT_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_REMOTE_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_RELEASE_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_RELEASE_EXECUTABLE_ASSETS = 1_000;
const REQUIRED_RELEASE_HTML_ROUTES = [
  "/",
  "/app",
  "/flow",
  "/plan",
  "/embed/recover",
];

function strictBoolean(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function truthy(value) {
  return strictBoolean(value) === true;
}

function numeric(value) {
  const normalized = String(value ?? "").trim();
  if (!STRICT_NUMBER_PATTERN.test(normalized)) return Number.NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function percentile(values, ratio) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : Number.NaN;
}

function isPlaceholderHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".example") ||
    /^(?:[^.]+\.)*example\.(?:com|org|net)$/.test(normalized)
  );
}

export function parseArtifactReference(value) {
  const normalized = String(value ?? "").trim();
  const approved = normalized.match(
    /^approved-artifact:sha256:([a-f0-9]{64})$/i,
  );
  if (approved) {
    return { kind: "approved", sha256: approved[1].toLowerCase() };
  }
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  const digest = url.hash.match(/^#sha256=([a-f0-9]{64})$/i)?.[1];
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    isPlaceholderHostname(url.hostname) ||
    !digest ||
    !SHA256_PATTERN.test(digest) ||
    /\s/.test(normalized)
  ) {
    return null;
  }
  url.hash = "";
  return {
    kind: "remote",
    sha256: digest.toLowerCase(),
    url: url.href,
  };
}

function parseConsentReference(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^approved-consent-ledger:sha256:([a-f0-9]{64})$/i);
  return match ? { sha256: match[1].toLowerCase() } : null;
}

function validArtifactReference(value) {
  return parseArtifactReference(value) !== null;
}

function uniqueCount(rows, field) {
  return new Set(rows.map((row) => row[field]).filter(Boolean)).size;
}

function requireString(row, field, label, index, errors) {
  const value = String(row[field] ?? "").trim();
  if (!value || value.length > 512 || /^[=+@]/.test(value)) {
    errors.push(`${label} ${index + 1}행 ${field}가 비어 있거나 안전한 문자열이 아닙니다.`);
    return undefined;
  }
  return value;
}

function requireIdentifier(row, field, label, index, errors) {
  const value = String(row[field] ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    errors.push(`${label} ${index + 1}행 ${field}가 유효한 식별자가 아닙니다.`);
    return undefined;
  }
  return value;
}

function requireBoolean(row, field, label, index, errors) {
  const value = strictBoolean(row[field]);
  if (value === undefined) {
    errors.push(`${label} ${index + 1}행 ${field}는 true 또는 false여야 합니다.`);
  }
  return value;
}

function requireNumber(
  row,
  field,
  label,
  index,
  errors,
  { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, integer = false } = {},
) {
  const value = numeric(row[field]);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    errors.push(
      `${label} ${index + 1}행 ${field}는 ${integer ? "정수 " : ""}${min}~${max} 범위의 유한한 수여야 합니다.`,
    );
    return undefined;
  }
  return value;
}

function requireTimestamp(
  row,
  field,
  label,
  index,
  context,
  errors,
  optional = false,
  allowFuture = false,
) {
  const value = String(row[field] ?? "").trim();
  if (optional && !value) return undefined;
  const parsed = ISO_TIMESTAMP_PATTERN.test(value) ? Date.parse(value) : Number.NaN;
  const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  if (!Number.isFinite(parsed) || (!allowFuture && parsed > nowMs + 5 * 60_000)) {
    errors.push(`${label} ${index + 1}행 ${field}는 유효한 ISO 8601 시각이어야 하며 미래일 수 없습니다.`);
    return undefined;
  }
  return parsed;
}

function requireUnique(rows, fields, label, errors) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const key = fields.map((field) => String(row[field] ?? "").trim()).join("\u0000");
    if (seen.has(key)) {
      errors.push(`${label} ${index + 1}행의 ${fields.join("+")} 조합이 중복입니다.`);
    }
    seen.add(key);
  }
}

function validateCommonRows(rows, label, context, errors) {
  for (const [index, row] of rows.entries()) {
    if (!/^[a-f0-9]{40}$/i.test(String(row.commit_sha ?? "")) || row.commit_sha.toLowerCase() !== context.commitSha) {
      errors.push(`${label} ${index + 1}행 commit_sha가 제출 SHA와 다릅니다.`);
    }
    let rowDeployment;
    try {
      const parsed = new URL(String(row.deployment_url ?? ""));
      rowDeployment = parsed.protocol === "https:" ? parsed.href.replace(/\/$/, "") : "";
    } catch {
      rowDeployment = "";
    }
    if (rowDeployment !== context.deploymentUrl) {
      errors.push(`${label} ${index + 1}행 deployment_url이 제출 URL과 다릅니다.`);
    }
  }
}

function requireArtifacts(rows, label, field, errors, { consent = false } = {}) {
  for (const [index, row] of rows.entries()) {
    if (
      consent
        ? !parseConsentReference(row[field])
        : !validArtifactReference(row[field] ?? "")
    ) {
      errors.push(`${label} ${index + 1}행 ${field}가 검증 가능한 참조가 아닙니다.`);
    }
  }
}

export function evaluateEvidence(datasets, context) {
  const errors = [];
  const metrics = {};
  if (!/^[a-f0-9]{40}$/i.test(context.commitSha ?? "")) {
    errors.push("제출 context.commitSha가 40자리 Git SHA가 아닙니다.");
  }
  try {
    const deployment = new URL(context.deploymentUrl);
    if (deployment.protocol !== "https:" || deployment.href.replace(/\/$/, "") !== context.deploymentUrl) {
      errors.push("제출 context.deploymentUrl이 정규화된 HTTPS URL이 아닙니다.");
    }
  } catch {
    errors.push("제출 context.deploymentUrl이 유효한 URL이 아닙니다.");
  }
  for (const [name, rows] of Object.entries(datasets)) {
    validateCommonRows(rows, name, context, errors);
  }

  const tripbreak = datasets.tripbreak;
  requireUnique(tripbreak, ["scenario_id"], "tripbreak", errors);
  requireUnique(tripbreak, ["request_id"], "tripbreak", errors);
  metrics.tripbreakScenarios = uniqueCount(tripbreak, "scenario_id");
  metrics.tripbreakRegions = uniqueCount(tripbreak, "region_class");
  if (metrics.tripbreakScenarios < 100) errors.push("K-TRIPBREAK 고유 시나리오가 100개 미만입니다.");
  if (metrics.tripbreakRegions < 6) errors.push("K-TRIPBREAK 권역 유형이 6개 미만입니다.");
  if (uniqueCount(tripbreak, "incident") < 4) errors.push("K-TRIPBREAK 사건 유형이 4개 미만입니다.");
  if (uniqueCount(tripbreak, "audience") < 4) errors.push("K-TRIPBREAK 이용자 유형이 4개 미만입니다.");
  let lockedAppointmentChecks = 0;
  let returnRouteChecks = 0;
  for (const [index, row] of tripbreak.entries()) {
    requireIdentifier(row, "scenario_id", "tripbreak", index, errors);
    requireTimestamp(row, "run_at", "tripbreak", index, context, errors);
    requireString(row, "region_class", "tripbreak", index, errors);
    requireString(row, "area_code", "tripbreak", index, errors);
    requireString(row, "incident", "tripbreak", index, errors);
    requireString(row, "audience", "tripbreak", index, errors);
    requireIdentifier(row, "request_id", "tripbreak", index, errors);
    requireIdentifier(row, "rule_version", "tripbreak", index, errors);
    const hasFixedAppointment = requireBoolean(
      row,
      "has_fixed_appointment",
      "tripbreak",
      index,
      errors,
    );
    const optionCount = requireNumber(row, "option_count", "tripbreak", index, errors, {
      min: 0,
      max: 100,
      integer: true,
    });
    requireNumber(row, "response_ms", "tripbreak", index, errors, {
      min: 1,
      max: 60_000,
      integer: true,
    });
    if (!/^(?:options_presented|explained_no_option)$/.test(row.result_status)) {
      errors.push(`tripbreak ${index + 1}행은 설명 가능한 완료 상태가 아닙니다.`);
    }
    if (row.result_status === "options_presented" && !(optionCount > 0)) {
      errors.push(`tripbreak ${index + 1}행은 후보 제시 상태지만 option_count가 1 이상이 아닙니다.`);
    }
    if (row.result_status === "explained_no_option" && optionCount !== 0) {
      errors.push(`tripbreak ${index + 1}행은 후보 없음 상태지만 option_count가 0이 아닙니다.`);
    }
    const availability = requireBoolean(
      row,
      "availability_fail_closed",
      "tripbreak",
      index,
      errors,
    );
    if (availability === false) {
      errors.push(`tripbreak ${index + 1}행 availability_fail_closed 불변성이 실패했습니다.`);
    }

    const lockedApplicable = hasFixedAppointment === true && (optionCount ?? 0) > 0;
    if (lockedApplicable) {
      lockedAppointmentChecks += 1;
      const locked = requireBoolean(
        row,
        "locked_appointment_preserved",
        "tripbreak",
        index,
        errors,
      );
      if (locked === false) {
        errors.push(`tripbreak ${index + 1}행 locked_appointment_preserved 불변성이 실패했습니다.`);
      }
    } else if (String(row.locked_appointment_preserved).trim() !== "not_applicable") {
      errors.push(`tripbreak ${index + 1}행 locked_appointment_preserved는 적용 대상이 아니므로 not_applicable이어야 합니다.`);
    }

    const returnApplicable = hasFixedAppointment === false && (optionCount ?? 0) > 0;
    if (returnApplicable) {
      returnRouteChecks += 1;
      const returnVerified = requireBoolean(
        row,
        "return_route_verified",
        "tripbreak",
        index,
        errors,
      );
      if (returnVerified === false) {
        errors.push(`tripbreak ${index + 1}행 return_route_verified 불변성이 실패했습니다.`);
      }
    } else if (String(row.return_route_verified).trim() !== "not_applicable") {
      errors.push(`tripbreak ${index + 1}행 return_route_verified는 적용 대상이 아니므로 not_applicable이어야 합니다.`);
    }
    const criticalFalsePositive = requireNumber(
      row,
      "critical_false_positive",
      "tripbreak",
      index,
      errors,
      { min: 0, max: 100, integer: true },
    );
    if (criticalFalsePositive !== undefined && criticalFalsePositive !== 0) {
      errors.push(`tripbreak ${index + 1}행에 치명적 오추천이 있습니다.`);
    }
  }
  metrics.lockedAppointmentChecks = lockedAppointmentChecks;
  metrics.returnRouteChecks = returnRouteChecks;
  if (lockedAppointmentChecks < 50) errors.push("고정 예약 적용 검증이 50건 미만입니다.");
  if (returnRouteChecks < 15) errors.push("역방향 복귀 경로 검증이 15건 미만입니다.");

  const performance = datasets.performance;
  requireUnique(performance, ["measurement_id"], "performance", errors);
  for (const [index, row] of performance.entries()) {
    requireIdentifier(row, "measurement_id", "performance", index, errors);
    requireTimestamp(row, "measured_at", "performance", index, context, errors);
    requireString(row, "device_class", "performance", index, errors);
    requireString(row, "browser", "performance", index, errors);
    requireString(row, "network_profile", "performance", index, errors);
    requireString(row, "flow", "performance", index, errors);
    requireNumber(row, "viewport_width", "performance", index, errors, {
      min: 240,
      max: 10_000,
      integer: true,
    });
    requireNumber(row, "repetition", "performance", index, errors, {
      min: 1,
      max: 1_000,
      integer: true,
    });
    requireNumber(row, "response_ms", "performance", index, errors, {
      min: 1,
      max: 60_000,
    });
    requireNumber(row, "largest_contentful_paint_ms", "performance", index, errors, {
      min: 1,
      max: 120_000,
    });
    requireNumber(row, "interaction_to_next_paint_ms", "performance", index, errors, {
      min: 0,
      max: 120_000,
    });
    requireNumber(row, "cumulative_layout_shift", "performance", index, errors, {
      min: 0,
      max: 10,
    });
    const retryRequired = requireBoolean(row, "retry_required", "performance", index, errors);
    if (retryRequired === true) {
      errors.push(`performance ${index + 1}행은 재시도가 필요해 독립 성능 표본으로 사용할 수 없습니다.`);
    }
  }
  const responseTimes = performance.map((row) => numeric(row.response_ms)).filter(Number.isFinite);
  const lcpValues = performance
    .map((row) => numeric(row.largest_contentful_paint_ms))
    .filter(Number.isFinite);
  const inpValues = performance
    .map((row) => numeric(row.interaction_to_next_paint_ms))
    .filter(Number.isFinite);
  const clsValues = performance
    .map((row) => numeric(row.cumulative_layout_shift))
    .filter(Number.isFinite);
  metrics.performanceSamples = performance.length;
  metrics.responseP50Ms = percentile(responseTimes, 0.5);
  metrics.responseP95Ms = percentile(responseTimes, 0.95);
  metrics.lcpP75Ms = percentile(lcpValues, 0.75);
  metrics.inpP75Ms = percentile(inpValues, 0.75);
  metrics.clsP75 = percentile(clsValues, 0.75);
  if (performance.length < 40) errors.push("성능 실측이 40회 미만입니다.");
  if (performance.filter((row) => /mobile|android|iphone/i.test(row.device_class)).length < 20) {
    errors.push("모바일 실기기 성능 실측이 20회 미만입니다.");
  }
  if (performance.filter((row) => /slow.?4g|lte/i.test(row.network_profile)).length < 16) {
    errors.push("LTE/Slow 4G 성능 실측이 16회 미만입니다.");
  }
  if (!Number.isFinite(metrics.responseP50Ms) || metrics.responseP50Ms > 4_000) errors.push("복구 응답 p50이 없거나 4초를 초과합니다.");
  if (!Number.isFinite(metrics.responseP95Ms) || metrics.responseP95Ms > 8_000) errors.push("복구 응답 p95가 없거나 8초를 초과합니다.");
  if (!Number.isFinite(metrics.lcpP75Ms) || metrics.lcpP75Ms > 2_500) errors.push("LCP p75가 없거나 2.5초를 초과합니다.");
  if (!Number.isFinite(metrics.inpP75Ms) || metrics.inpP75Ms > 200) errors.push("INP p75가 없거나 200ms를 초과합니다.");
  if (!Number.isFinite(metrics.clsP75) || metrics.clsP75 > 0.1) errors.push("CLS p75가 없거나 0.1을 초과합니다.");
  if (performance.some((row) => row.error_code)) errors.push("성능 표본에 오류가 포함되어 있습니다.");

  const realUsers = datasets.realUsers;
  requireArtifacts(realUsers, "realUsers", "artifact_reference", errors);
  requireArtifacts(realUsers, "realUsers", "consent_reference", errors, { consent: true });
  requireUnique(realUsers, ["participant_id", "task_id"], "realUsers", errors);
  for (const [index, row] of realUsers.entries()) {
    requireIdentifier(row, "participant_id", "realUsers", index, errors);
    requireString(row, "user_segment", "realUsers", index, errors);
    requireString(row, "locale", "realUsers", index, errors);
    requireString(row, "device_class", "realUsers", index, errors);
    requireIdentifier(row, "task_id", "realUsers", index, errors);
    requireTimestamp(row, "started_at", "realUsers", index, context, errors);
    requireBoolean(row, "first_time_visitor", "realUsers", index, errors);
    requireBoolean(row, "completed", "realUsers", index, errors);
    const constraintPreserved = requireBoolean(
      row,
      "constraint_preserved",
      "realUsers",
      index,
      errors,
    );
    if (constraintPreserved === false) {
      errors.push(`realUsers ${index + 1}행에서 제약 보존이 실패했습니다.`);
    }
    const safetyIncident = requireBoolean(
      row,
      "critical_safety_incident",
      "realUsers",
      index,
      errors,
    );
    if (safetyIncident === true) {
      errors.push(`realUsers ${index + 1}행에 치명적 안전 사건이 있습니다.`);
    }
    requireNumber(row, "completion_seconds", "realUsers", index, errors, {
      min: 0,
      max: 86_400,
    });
    requireNumber(row, "clarity_score_1_to_5", "realUsers", index, errors, {
      min: 1,
      max: 5,
    });
    requireNumber(row, "trust_score_1_to_5", "realUsers", index, errors, {
      min: 1,
      max: 5,
    });
  }
  metrics.realUsers = uniqueCount(realUsers, "participant_id");
  metrics.realUserCompletionRate = realUsers.length
    ? realUsers.filter((row) => truthy(row.completed)).length / realUsers.length
    : 0;
  metrics.clarityMean = mean(realUsers.map((row) => numeric(row.clarity_score_1_to_5)).filter(Number.isFinite));
  metrics.trustMean = mean(realUsers.map((row) => numeric(row.trust_score_1_to_5)).filter(Number.isFinite));
  if (metrics.realUsers < 20) errors.push("독립 실사용자가 20명 미만입니다.");
  if (uniqueCount(realUsers, "locale") < 3) errors.push("실사용자 검증 언어가 3개 미만입니다.");
  if (!realUsers.some((row) => strictBoolean(row.first_time_visitor) === true)) {
    errors.push("초행 실사용자 표본이 없습니다.");
  }
  if (!realUsers.some((row) => /wheelchair|mobility|accessibility|stroller|senior|휠체어|이동약자|유아차|고령/i.test(row.user_segment))) {
    errors.push("이동약자 또는 동행자 실사용자 표본이 없습니다.");
  }
  if (metrics.realUserCompletionRate < 0.9) errors.push("실사용자 과업 완료율이 90% 미만입니다.");
  if (!Number.isFinite(metrics.clarityMean) || metrics.clarityMean < 4.2) errors.push("추천 근거 이해도 평균이 없거나 4.2/5 미만입니다.");
  if (!Number.isFinite(metrics.trustMean) || metrics.trustMean < 4.2) errors.push("사용자 신뢰도 평균이 없거나 4.2/5 미만입니다.");

  const field = datasets.fieldJourneys;
  requireArtifacts(field, "fieldJourneys", "artifact_reference", errors);
  requireUnique(field, ["journey_id"], "fieldJourneys", errors);
  for (const [index, row] of field.entries()) {
    requireIdentifier(row, "journey_id", "fieldJourneys", index, errors);
    requireIdentifier(row, "participant_id", "fieldJourneys", index, errors);
    requireIdentifier(row, "reviewer_id", "fieldJourneys", index, errors);
    requireTimestamp(row, "observed_at", "fieldJourneys", index, context, errors);
    requireString(row, "region_class", "fieldJourneys", index, errors);
    requireString(row, "area_code", "fieldJourneys", index, errors);
    requireString(row, "city", "fieldJourneys", index, errors);
    requireString(row, "network_profile", "fieldJourneys", index, errors);
    requireString(row, "device_class", "fieldJourneys", index, errors);
    for (const fieldName of [
      "completed",
      "constraint_preserved",
      "critical_false_positive",
      "actual_closed_recommended",
      "appointment_missed",
    ]) {
      requireBoolean(row, fieldName, "fieldJourneys", index, errors);
    }
  }
  metrics.fieldJourneys = uniqueCount(field, "journey_id");
  metrics.fieldRegions = uniqueCount(field, "region_class");
  metrics.busanJourneys = field.filter((row) => /부산|busan/i.test(row.city)).length;
  if (metrics.fieldJourneys < 12) errors.push("실제 이동 현장 여정이 12건 미만입니다.");
  if (metrics.fieldRegions < 6) errors.push("현장 검증 권역 유형이 6개 미만입니다.");
  if (metrics.busanJourneys < 5) errors.push("부산 현장 검증이 5건 미만입니다.");
  for (const fieldName of [
    "completed",
    "constraint_preserved",
  ]) {
    if (field.some((row) => !truthy(row[fieldName]))) errors.push(`현장 검증의 ${fieldName} 실패가 있습니다.`);
  }
  for (const fieldName of [
    "critical_false_positive",
    "actual_closed_recommended",
    "appointment_missed",
  ]) {
    if (field.some((row) => truthy(row[fieldName]))) errors.push(`현장 검증의 ${fieldName} 사건이 있습니다.`);
  }

  const comparisons = datasets.comparisons;
  requireArtifacts(comparisons, "comparisons", "artifact_reference", errors);
  requireUnique(comparisons, ["scenario_id", "method"], "comparisons", errors);
  for (const [index, row] of comparisons.entries()) {
    requireIdentifier(row, "scenario_id", "comparisons", index, errors);
    requireIdentifier(row, "reviewer_id", "comparisons", index, errors);
    if (!REQUIRED_METHODS.has(row.method)) {
      errors.push(`comparisons ${index + 1}행 method가 허용된 4개 비교 방법이 아닙니다.`);
    }
    requireBoolean(row, "completed", "comparisons", index, errors);
    requireBoolean(row, "constraint_preserved", "comparisons", index, errors);
    requireBoolean(row, "critical_false_positive", "comparisons", index, errors);
    requireNumber(row, "completion_seconds", "comparisons", index, errors, {
      min: 0,
      max: 86_400,
    });
  }
  const scenarioGroups = Map.groupBy(comparisons, (row) => row.scenario_id);
  metrics.comparisonScenarios = scenarioGroups.size;
  if (comparisons.length < 80) errors.push("비교실험 원장이 80행 미만입니다.");
  if (scenarioGroups.size < 20) errors.push("비교실험 시나리오가 20개 미만입니다.");
  let dominated = 0;
  for (const [scenarioId, rows] of scenarioGroups) {
    const methods = new Set(rows.map((row) => row.method));
    for (const method of REQUIRED_METHODS) {
      if (!methods.has(method)) errors.push(`비교실험 ${scenarioId}에 ${method}가 없습니다.`);
    }
    if (rows.length !== REQUIRED_METHODS.size) {
      errors.push(`비교실험 ${scenarioId}는 정확히 4개 방법을 한 번씩 포함해야 합니다.`);
    }
    const ieoga = rows.find((row) => row.method === "ieoga");
    if (!ieoga) continue;
    if (!truthy(ieoga.completed) || !truthy(ieoga.constraint_preserved)) {
      errors.push(`비교실험 ${scenarioId}에서 이어가 과업 또는 제약 보존이 실패했습니다.`);
    }
    if (truthy(ieoga.critical_false_positive)) {
      errors.push(`비교실험 ${scenarioId}에서 이어가 치명적 오추천이 발생했습니다.`);
    }
    const baseline = rows.filter((row) => row.method !== "ieoga");
    const ieogaSeconds = numeric(ieoga.completion_seconds);
    const baselineMedian = percentile(
      baseline.map((row) => numeric(row.completion_seconds)).filter(Number.isFinite),
      0.5,
    );
    const constraintAdvantage = baseline.some((row) => !truthy(row.constraint_preserved));
    if (constraintAdvantage || ieogaSeconds < baselineMedian) dominated += 1;
  }
  metrics.comparisonDominanceRate = scenarioGroups.size ? dominated / scenarioGroups.size : 0;
  if (metrics.comparisonDominanceRate < 0.7) errors.push("동일 조건 비교에서 이어가의 우위가 70% 미만입니다.");

  const practitioners = datasets.practitionerReviews;
  requireArtifacts(practitioners, "practitionerReviews", "artifact_reference", errors);
  requireUnique(practitioners, ["review_id"], "practitionerReviews", errors);
  for (const [index, row] of practitioners.entries()) {
    requireIdentifier(row, "review_id", "practitionerReviews", index, errors);
    requireIdentifier(row, "reviewer_id", "practitionerReviews", index, errors);
    requireString(row, "reviewer_role", "practitionerReviews", index, errors);
    requireString(row, "organization_type", "practitionerReviews", index, errors);
    requireTimestamp(row, "reviewed_at", "practitionerReviews", index, context, errors);
    if (row.decision !== "approved") {
      errors.push(`practitionerReviews ${index + 1}행 decision이 approved가 아닙니다.`);
    }
    requireNumber(
      row,
      "critical_findings_open",
      "practitionerReviews",
      index,
      errors,
      { min: 0, max: 10_000, integer: true },
    );
  }
  metrics.practitionerReviewers = uniqueCount(practitioners, "reviewer_id");
  if (metrics.practitionerReviewers < 3) errors.push("독립 관광·지자체 실무자 검토자가 3명 미만입니다.");
  if (uniqueCount(practitioners, "reviewer_role") < 3) errors.push("실무자 검토 역할이 3종 미만입니다.");
  if (practitioners.some((row) => row.decision !== "approved")) errors.push("실무자 검토에 미승인 결정이 있습니다.");
  if (practitioners.some((row) => numeric(row.critical_findings_open) !== 0)) errors.push("실무자 검토의 치명적 미해결 항목이 남아 있습니다.");

  const partnerPilot = datasets.partnerEmbedPilot;
  requireArtifacts(partnerPilot, "partnerEmbedPilot", "artifact_reference", errors);
  requireUnique(partnerPilot, ["pilot_id"], "partnerEmbedPilot", errors);
  for (const [index, row] of partnerPilot.entries()) {
    requireIdentifier(row, "pilot_id", "partnerEmbedPilot", index, errors);
    requireIdentifier(row, "partner_id", "partnerEmbedPilot", index, errors);
    requireIdentifier(row, "reviewer_id", "partnerEmbedPilot", index, errors);
    requireTimestamp(row, "run_at", "partnerEmbedPilot", index, context, errors);
    requireString(row, "browser", "partnerEmbedPilot", index, errors);
    requireString(row, "device_class", "partnerEmbedPilot", index, errors);
    try {
      const origin = new URL(row.partner_origin);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== row.partner_origin ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password ||
        isPlaceholderHostname(origin.hostname)
      ) {
        throw new Error("invalid origin");
      }
    } catch {
      errors.push(`partnerEmbedPilot ${index + 1}행 partner_origin이 정확한 외부 HTTPS origin이 아닙니다.`);
    }
    for (const fieldName of [
      "iframe_rendered",
      "session_ready",
      "recovery_completed",
      "critical_failure",
    ]) {
      requireBoolean(row, fieldName, "partnerEmbedPilot", index, errors);
    }
  }
  metrics.partnerPilotRuns = uniqueCount(partnerPilot, "pilot_id");
  metrics.partnerPilotOrganizations = uniqueCount(partnerPilot, "partner_id");
  metrics.partnerPilotBrowsers = uniqueCount(partnerPilot, "browser");
  const mobilePartnerPilot = partnerPilot.filter((row) =>
    /mobile|android|iphone|ios/i.test(row.device_class),
  );
  metrics.partnerPilotMobileRuns = mobilePartnerPilot.length;
  metrics.partnerPilotMobileBrowsers = uniqueCount(
    mobilePartnerPilot,
    "browser",
  );
  if (metrics.partnerPilotRuns < 4) errors.push("외부 파트너 iframe 실증이 4회 미만입니다.");
  if (metrics.partnerPilotOrganizations < 1) errors.push("실증한 외부 파트너가 없습니다.");
  if (metrics.partnerPilotMobileRuns < 4) errors.push("파트너 iframe 모바일 실증이 4회 미만입니다.");
  if (metrics.partnerPilotMobileBrowsers < 3) errors.push("파트너 iframe 모바일 실증 브라우저가 3종 미만입니다.");
  for (const browser of ["chrome", "safari", "firefox"]) {
    if (!mobilePartnerPilot.some((row) => row.browser.toLowerCase().includes(browser))) {
      errors.push(`파트너 iframe 모바일 실증에 ${browser} 표본이 없습니다.`);
    }
  }
  for (const fieldName of ["iframe_rendered", "session_ready", "recovery_completed"]) {
    if (partnerPilot.some((row) => !truthy(row[fieldName]))) {
      errors.push(`파트너 iframe 실증의 ${fieldName} 성공률이 100%가 아닙니다.`);
    }
  }
  if (partnerPilot.some((row) => truthy(row.critical_failure))) {
    errors.push("파트너 iframe 실증에 치명적 실패가 있습니다.");
  }

  const operations = datasets.operationsApprovals;
  requireArtifacts(operations, "operationsApprovals", "artifact_reference", errors);
  requireUnique(operations, ["control_id"], "operationsApprovals", errors);
  for (const [index, row] of operations.entries()) {
    requireIdentifier(row, "control_id", "operationsApprovals", index, errors);
    requireString(row, "authority", "operationsApprovals", index, errors);
    requireTimestamp(row, "approved_at", "operationsApprovals", index, context, errors);
    const expiresAt = requireTimestamp(
      row,
      "expires_at",
      "operationsApprovals",
      index,
      context,
      errors,
      true,
      true,
    );
    const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
    if (expiresAt !== undefined && expiresAt <= nowMs) {
      errors.push(`operationsApprovals ${index + 1}행 expires_at이 이미 만료됐습니다.`);
    }
    if (!/^(?:approved|ready)$/.test(row.status)) {
      errors.push(`operationsApprovals ${index + 1}행 status가 approved 또는 ready가 아닙니다.`);
    }
  }
  const operationControls = new Map(operations.map((row) => [row.control_id, row]));
  if (uniqueCount(operations, "authority") < 2) {
    errors.push("운영 통제에는 서로 다른 승인 주체가 2곳 이상 필요합니다.");
  }
  for (const control of REQUIRED_CONTROLS) {
    const row = operationControls.get(control);
    if (!row) {
      errors.push(`운영 승인 ${control}가 없습니다.`);
      continue;
    }
    if (!/^(?:approved|ready)$/.test(row.status)) errors.push(`운영 승인 ${control} 상태가 승인/준비가 아닙니다.`);
    const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
    if (row.expires_at && Date.parse(row.expires_at) <= nowMs) errors.push(`운영 승인 ${control}가 만료됐습니다.`);
  }

  const consentLedger = datasets.consentLedger;
  requireUnique(consentLedger, ["consent_record_id"], "consentLedger", errors);
  requireUnique(consentLedger, ["participant_id"], "consentLedger", errors);
  const consentParticipants = new Set();
  for (const [index, row] of consentLedger.entries()) {
    requireIdentifier(row, "consent_record_id", "consentLedger", index, errors);
    const participantId = requireIdentifier(
      row,
      "participant_id",
      "consentLedger",
      index,
      errors,
    );
    if (participantId) consentParticipants.add(participantId);
    requireIdentifier(row, "reviewer_id", "consentLedger", index, errors);
    requireTimestamp(row, "consented_at", "consentLedger", index, context, errors);
    requireString(row, "consent_scope", "consentLedger", index, errors);
    const withdrawnAt = requireTimestamp(
      row,
      "withdrawn_at",
      "consentLedger",
      index,
      context,
      errors,
      true,
    );
    if (withdrawnAt === undefined && String(row.withdrawal_honored).trim() !== "not_applicable") {
      errors.push(`consentLedger ${index + 1}행 withdrawal_honored는 철회가 없으면 not_applicable이어야 합니다.`);
    }
    if (withdrawnAt !== undefined && requireBoolean(
      row,
      "withdrawal_honored",
      "consentLedger",
      index,
      errors,
    ) !== true) {
      errors.push(`consentLedger ${index + 1}행의 철회 요청이 완전히 반영되지 않았습니다.`);
    }
  }
  metrics.consentParticipants = consentParticipants.size;
  if (consentParticipants.size < 20) errors.push("승인된 동의 원장 참여자가 20명 미만입니다.");
  if (uniqueCount(consentLedger, "reviewer_id") < 2) errors.push("동의 원장 검토자가 2명 미만입니다.");
  for (const participantId of new Set(realUsers.map((row) => row.participant_id))) {
    if (!consentParticipants.has(participantId)) {
      errors.push(`실사용자 ${participantId}가 승인된 동의 원장에 없습니다.`);
    }
  }

  const consentLedgerSha = context.consentLedgerSha?.toLowerCase();
  const approvedDigests = context.approvedArtifactDigests
    ? new Set(context.approvedArtifactDigests.map((value) => value.toLowerCase()))
    : null;
  for (const [index, row] of realUsers.entries()) {
    const consent = parseConsentReference(row.consent_reference);
    if (!consent) continue;
    if (consentLedgerSha && consent.sha256 !== consentLedgerSha) {
      errors.push(`realUsers ${index + 1}행 consent_reference가 제출 동의 원장 해시와 다릅니다.`);
    }
    if (approvedDigests && !approvedDigests.has(consent.sha256)) {
      errors.push(`realUsers ${index + 1}행 consent_reference가 배포본에서 독립 승인된 동의 원장이 아닙니다.`);
    }
  }
  if (approvedDigests) {
    for (const [datasetName, rows] of Object.entries(datasets)) {
      for (const [index, row] of rows.entries()) {
        const reference = row.artifact_reference
          ? parseArtifactReference(row.artifact_reference)
          : null;
        if (
          reference?.kind === "approved" &&
          !approvedDigests.has(reference.sha256)
        ) {
          errors.push(`${datasetName} ${index + 1}행 artifact_reference가 배포본의 독립 승인 artifact가 아닙니다.`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, metrics };
}

function parseArgs(argv) {
  const result = { structureOnly: false, manifest: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--structure-only") result.structureOnly = true;
    if (argv[index] === "--manifest") {
      result.manifest = argv[index + 1] ?? "";
      index += 1;
    }
  }
  return result;
}

async function loadInsideRoot(relativePath) {
  const candidate = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`저장소 밖의 증거 경로는 허용하지 않습니다: ${relativePath}`);
  }
  const [rootReal, fileReal] = await Promise.all([realpath(ROOT), realpath(candidate)]);
  if (!fileReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`심볼릭 링크로 저장소 밖을 참조할 수 없습니다: ${relativePath}`);
  }
  return { source: await readFile(fileReal, "utf8"), absolutePath: fileReal };
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function verifyReleaseReceiptAttestation(
  { absolutePath, commitSha },
  runCommand = execFileSync,
) {
  const args = [
    "attestation",
    "verify",
    absolutePath,
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
  ];
  try {
    runCommand("gh", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    throw new Error(
      "Release receipt does not have the required GitHub-hosted main-branch build provenance.",
    );
  }
  return {
    repository: RELEASE_ATTESTATION_REPOSITORY,
    signerWorkflow: RELEASE_ATTESTATION_WORKFLOW,
    sourceDigest: commitSha,
    sourceRef: RELEASE_ATTESTATION_SOURCE_REF,
    selfHostedRunnerDenied: true,
  };
}

export function verifyReleaseReceiptManifest({
  manifest,
  receipt,
  receiptSha256,
}) {
  const entry = manifest.releaseReceipt;
  if (
    !entry ||
    entry.path !== RELEASE_RECEIPT_PATH ||
    !SHA256_PATTERN.test(entry.sha256 ?? "") ||
    !SHA256_PATTERN.test(entry.bundleDigest ?? "") ||
    !SHA256_PATTERN.test(entry.assetManifestDigest ?? "") ||
    entry.bundleManifestPath !== RELEASE_BUNDLE_MANIFEST_PATH ||
    entry.assetManifestPath !== RELEASE_ASSET_MANIFEST_PATH ||
    entry.sha256.toLowerCase() !== receiptSha256.toLowerCase()
  ) {
    throw new Error("Submission manifest releaseReceipt path or digests are invalid.");
  }
  validateReleaseReceipt(receipt);
  if (
    receipt.commitSha !== manifest.commitSha.toLowerCase() ||
    receipt.productionOrigin !== new URL(manifest.deploymentUrl).origin ||
    receipt.versionId !== manifest.cloudflare?.versionId ||
    receipt.scriptEtag !== manifest.cloudflare?.scriptEtag ||
    receipt.bundleDigest !== entry.bundleDigest.toLowerCase() ||
    receipt.assetManifestDigest !== entry.assetManifestDigest.toLowerCase() ||
    receipt.bundleManifestPath !== entry.bundleManifestPath ||
    receipt.assetManifestPath !== entry.assetManifestPath
  ) {
    throw new Error(
      "Signed release receipt does not match the submission manifest release identity.",
    );
  }
  return receipt;
}

export function verifyReleaseReceiptRemote({
  receipt,
  deployed,
  cloudflareRelease,
}) {
  if (
    deployed.releaseBuild !== true ||
    deployed.releaseReady !== true ||
    deployed.source !==
      "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION" ||
    receipt.commitSha !== deployed.commitSha?.toLowerCase() ||
    receipt.commitSha !== deployed.versionTag?.toLowerCase() ||
    receipt.versionId !== deployed.versionId ||
    receipt.versionId !== cloudflareRelease.versionId ||
    receipt.scriptEtag !== cloudflareRelease.scriptEtag ||
    Date.parse(receipt.versionTimestamp) !==
      Date.parse(deployed.versionTimestamp ?? "") ||
    receipt.workerName !== cloudflareRelease.workerName ||
    receipt.trafficPercentage !== cloudflareRelease.trafficPercentage
  ) {
    throw new Error(
      "Signed release receipt does not match runtime metadata and the Cloudflare control plane.",
    );
  }
  return {
    bundleDigest: receipt.bundleDigest,
    assetManifestDigest: receipt.assetManifestDigest,
    receiptVersionId: receipt.versionId,
  };
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertReleaseFilePath(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../")
  ) {
    throw new Error(`${label} contains an unsafe or non-canonical file path.`);
  }
  return value;
}

function validateCanonicalTreeManifest(manifest, expectedRoot, requiredPaths) {
  if (
    !hasExactKeys(manifest, ["schemaVersion", "root", "files"]) ||
    manifest.schemaVersion !== 1 ||
    manifest.root !== expectedRoot ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > 20_000
  ) {
    throw new Error(`Canonical ${expectedRoot} manifest is malformed.`);
  }
  const seen = new Set();
  let previousPath = "";
  for (const [index, entry] of manifest.files.entries()) {
    if (
      !hasExactKeys(entry, ["path", "sha256", "size"]) ||
      !SHA256_PATTERN.test(entry.sha256 ?? "") ||
      entry.sha256 !== entry.sha256.toLowerCase() ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new Error(`Canonical ${expectedRoot} manifest entry ${index + 1} is malformed.`);
    }
    const filePath = assertReleaseFilePath(
      entry.path,
      `Canonical ${expectedRoot} manifest entry ${index + 1}`,
    );
    if (
      seen.has(filePath) ||
      (previousPath && !(previousPath < filePath))
    ) {
      throw new Error(`Canonical ${expectedRoot} manifest paths must be unique and sorted.`);
    }
    seen.add(filePath);
    previousPath = filePath;
  }
  for (const requiredPath of requiredPaths) {
    if (!seen.has(requiredPath)) {
      throw new Error(`Canonical ${expectedRoot} manifest is missing ${requiredPath}.`);
    }
  }
  return manifest;
}

export function verifyReleaseArtifactManifests({
  receipt,
  bundleManifest,
  assetManifest,
}) {
  validateReleaseReceipt(receipt);
  validateCanonicalTreeManifest(
    bundleManifest,
    "dist/server",
    ["index.js", "wrangler.json"],
  );
  validateCanonicalTreeManifest(
    assetManifest,
    "dist/client",
    ["_headers", "manifest.webmanifest", "sw.js"],
  );
  const bundleDigest = sha256(
    Buffer.from(canonicalJson(bundleManifest), "utf8"),
  );
  const assetManifestDigest = sha256(
    Buffer.from(canonicalJson(assetManifest), "utf8"),
  );
  if (
    bundleDigest !== receipt.bundleDigest ||
    assetManifestDigest !== receipt.assetManifestDigest
  ) {
    throw new Error(
      "Canonical worker or static asset manifest does not match the signed release receipt.",
    );
  }
  return {
    bundleDigest,
    assetManifestDigest,
    bundleFileCount: bundleManifest.files.length,
    assetFileCount: assetManifest.files.length,
  };
}

function releaseAssetUrl(filePath) {
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(`/${encodedPath}`, CANONICAL_DEPLOYMENT_ORIGIN);
}

function decodedSameOriginAssetPath(url) {
  const encodedSegments = url.pathname.slice(1).split("/");
  let decodedSegments;
  try {
    decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error(`Production HTML contains an invalid encoded asset URL: ${url.pathname}`);
  }
  if (
    decodedSegments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw new Error(`Production HTML contains a non-canonical asset URL: ${url.pathname}`);
  }
  return assertReleaseFilePath(
    decodedSegments.join("/"),
    "Production HTML asset reference",
  );
}

function sameOriginExecutableReferences(html, pageUrl) {
  const references = new Set();
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attribute = tag[0].match(
      /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
    );
    const value = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
    if (!value) continue;
    let parsed;
    try {
      parsed = new URL(value, pageUrl);
    } catch {
      throw new Error(`Production HTML contains an invalid script or stylesheet URL: ${value}`);
    }
    if (parsed.origin !== CANONICAL_DEPLOYMENT_ORIGIN) continue;
    if (parsed.username || parsed.password) {
      throw new Error("Production HTML asset URLs may not contain credentials.");
    }
    if (!/\.(?:js|css)$/i.test(parsed.pathname)) continue;
    references.add(decodedSameOriginAssetPath(parsed));
  }
  return references;
}

async function fetchProductionResource(fetchImpl, url, accept) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept,
        "accept-encoding": "identity",
        "cache-control": "no-cache, no-store, max-age=0",
        pragma: "no-cache",
      },
    });
  } catch (error) {
    throw new Error(
      `Production release resource could not be fetched: ${url.pathname} (${error instanceof Error ? error.message : "fetch failed"})`,
    );
  }
  if (!response.ok || response.redirected) {
    throw new Error(
      `Production release resource ${url.pathname} returned HTTP ${response.status} or redirected.`,
    );
  }
  return response;
}

export async function verifyProductionAssetManifest(
  assetManifest,
  { fetchImpl = fetch } = {},
) {
  validateCanonicalTreeManifest(
    assetManifest,
    "dist/client",
    ["_headers", "manifest.webmanifest", "sw.js"],
  );
  const entriesByPath = new Map(
    assetManifest.files.map((entry) => [entry.path, entry]),
  );
  const executableEntries = assetManifest.files.filter(
    (entry) =>
      /\.(?:js|css|wasm)$/i.test(entry.path) ||
      entry.path === "sw.js" ||
      entry.path === "manifest.webmanifest",
  );
  if (
    executableEntries.length < 2 ||
    executableEntries.length > MAX_RELEASE_EXECUTABLE_ASSETS
  ) {
    throw new Error("Canonical static asset manifest has an invalid executable asset count.");
  }

  let cursor = 0;
  const verifiedPaths = new Set();
  const workers = Array.from(
    { length: Math.min(4, executableEntries.length) },
    async () => {
      while (cursor < executableEntries.length) {
        const entry = executableEntries[cursor];
        cursor += 1;
        const url = releaseAssetUrl(entry.path);
        const response = await fetchProductionResource(
          fetchImpl,
          url,
          "application/javascript,text/css,application/wasm,application/manifest+json,*/*;q=0.5",
        );
        const actual = await hashBoundedResponse(
          response,
          `${CANONICAL_DEPLOYMENT_ORIGIN}${url.pathname}`,
          MAX_RELEASE_ASSET_BYTES,
        );
        if (actual.sha256 !== entry.sha256 || actual.byteLength !== entry.size) {
          throw new Error(
            `Production asset bytes do not match the signed manifest: ${entry.path}`,
          );
        }
        verifiedPaths.add(entry.path);
      }
    },
  );
  await Promise.all(workers);

  const pageReferences = new Set();
  for (const route of REQUIRED_RELEASE_HTML_ROUTES) {
    const pageUrl = new URL(route, `${CANONICAL_DEPLOYMENT_ORIGIN}/`);
    const response = await fetchProductionResource(
      fetchImpl,
      pageUrl,
      "text/html,application/xhtml+xml;q=0.9",
    );
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error(`Production route ${route} did not return HTML.`);
    }
    const body = await hashBoundedResponse(
      response,
      `${CANONICAL_DEPLOYMENT_ORIGIN}${route}`,
      MAX_REMOTE_ARTIFACT_BYTES,
      true,
    );
    const references = sameOriginExecutableReferences(
      body.bytes.toString("utf8"),
      pageUrl,
    );
    if (references.size === 0) {
      throw new Error(`Production route ${route} has no same-origin JS or CSS references.`);
    }
    for (const reference of references) {
      if (!entriesByPath.has(reference) || !verifiedPaths.has(reference)) {
        throw new Error(
          `Production route ${route} references an executable asset absent from the signed manifest: ${reference}`,
        );
      }
      pageReferences.add(reference);
    }
  }

  return {
    executableAssetCount: executableEntries.length,
    verifiedHtmlRouteCount: REQUIRED_RELEASE_HTML_ROUTES.length,
    referencedExecutableAssetCount: pageReferences.size,
  };
}

function isPrivateOrReservedAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const version = isIP(normalized);
  if (version === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (version === 6) {
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrReservedAddress(normalized.slice(7));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return true;
}

async function assertPublicArtifactHost(hostname, resolveHost) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const literalVersion = isIP(normalized);
  let addresses;
  if (literalVersion) {
    addresses = [{ address: normalized }];
  } else {
    try {
      addresses = await resolveHost(normalized, { all: true, verbatim: true });
    } catch {
      throw new Error(`증거 호스트 ${hostname}의 DNS를 검증하지 못했습니다.`);
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`증거 호스트 ${hostname}에 확인 가능한 주소가 없습니다.`);
  }
  if (addresses.some((entry) => isPrivateOrReservedAddress(entry.address))) {
    throw new Error(`증거 호스트 ${hostname}가 사설·예약 주소를 가리켜 차단했습니다.`);
  }
}

async function hashBoundedResponse(
  response,
  label,
  maxBytes = MAX_REMOTE_ARTIFACT_BYTES,
  includeBytes = false,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  const maxMiB = Math.floor(maxBytes / (1024 * 1024));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label}의 크기가 ${maxMiB}MiB 제한을 초과합니다.`);
  }
  const digest = createHash("sha256");
  let byteLength = 0;
  const chunks = includeBytes ? [] : undefined;
  if (response.body) {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > maxBytes) {
        throw new Error(`${label}의 크기가 ${maxMiB}MiB 제한을 초과합니다.`);
      }
      digest.update(bytes);
      chunks?.push(bytes);
    }
  }
  return {
    sha256: digest.digest("hex"),
    byteLength,
    ...(chunks ? { bytes: Buffer.concat(chunks, byteLength) } : {}),
  };
}

/**
 * Fetch every unique public artifact without redirects, reject private-network
 * targets, bound the bytes, and compare the actual SHA-256 with the
 * content-addressed fragment. A plausible URL or a HEAD response is never
 * sufficient evidence.
 */
export async function verifyRemoteArtifactReferences(
  references,
  { fetchImpl = fetch, resolveHost = lookup } = {},
) {
  const parsedReferences = [...new Set(references)].map((reference) => {
    const parsed = parseArtifactReference(reference);
    if (!parsed || parsed.kind !== "remote") {
      throw new Error(`원격 증거 참조 형식이 올바르지 않습니다: ${reference}`);
    }
    return { reference, ...parsed };
  });
  const results = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(4, parsedReferences.length) },
    async () => {
      while (cursor < parsedReferences.length) {
        const current = parsedReferences[cursor];
        cursor += 1;
        const url = new URL(current.url);
        await assertPublicArtifactHost(url.hostname, resolveHost);
        let response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
            headers: {
              accept: "application/octet-stream,application/json,text/csv;q=0.9,*/*;q=0.5",
            },
          });
        } catch (error) {
          throw new Error(
            `원격 증거를 가져오지 못했습니다: ${url.origin}${url.pathname} (${error instanceof Error ? error.message : "fetch failed"})`,
          );
        }
        if (!response.ok || response.redirected) {
          throw new Error(`원격 증거가 HTTP ${response.status} 또는 redirect를 반환했습니다: ${url.origin}${url.pathname}`);
        }
        const actual = await hashBoundedResponse(
          response,
          `${url.origin}${url.pathname}`,
        );
        if (actual.sha256 !== current.sha256) {
          throw new Error(`원격 증거의 실제 SHA-256이 참조와 다릅니다: ${url.origin}${url.pathname}`);
        }
        results.push({
          reference: current.reference,
          sha256: actual.sha256,
          byteLength: actual.byteLength,
        });
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function verifyDatasetArtifactReferences(
  datasets,
  { approvedArtifactDigests, consentLedgerSha },
) {
  const approved = new Set(approvedArtifactDigests.map((digest) => digest.toLowerCase()));
  const remoteReferences = [];
  for (const [datasetName, rows] of Object.entries(datasets)) {
    for (const [index, row] of rows.entries()) {
      if (row.artifact_reference) {
        const reference = parseArtifactReference(row.artifact_reference);
        if (!reference) {
          throw new Error(`${datasetName} ${index + 1}행 artifact_reference 형식이 잘못됐습니다.`);
        }
        if (reference.kind === "approved" && !approved.has(reference.sha256)) {
          throw new Error(`${datasetName} ${index + 1}행 artifact_reference가 배포본의 승인 원본과 일치하지 않습니다.`);
        }
        if (reference.kind === "remote") remoteReferences.push(row.artifact_reference);
      }
      if (row.consent_reference) {
        const consent = parseConsentReference(row.consent_reference);
        if (
          !consent ||
          consent.sha256 !== consentLedgerSha.toLowerCase() ||
          !approved.has(consent.sha256)
        ) {
          throw new Error(`${datasetName} ${index + 1}행 consent_reference가 독립 승인된 제출 동의 원장과 일치하지 않습니다.`);
        }
      }
    }
  }
  return verifyRemoteArtifactReferences(remoteReferences);
}

async function verifyStructure() {
  const errors = [];
  for (const [name, relativePath] of Object.entries(REQUIRED_ARTIFACTS)) {
    const { source } = await loadInsideRoot(relativePath);
    const { headers } = parseCsv(source);
    for (const header of REQUIRED_HEADERS[name]) {
      if (!headers.includes(header)) errors.push(`${relativePath}에 ${header} 헤더가 없습니다.`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { ok: true, templates: Object.values(REQUIRED_ARTIFACTS) };
}

async function fetchDeploymentVersion(deploymentUrl) {
  const response = await fetch(`${deploymentUrl}/api/v1/release/version`, {
    headers: { accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || response.redirected) throw new Error(`배포 버전 엔드포인트가 HTTP ${response.status} 또는 redirect를 반환했습니다.`);
  return response.json();
}

async function fetchReleaseEvidence(deploymentUrl) {
  const response = await fetch(`${deploymentUrl}/api/v1/release/evidence`, {
    headers: { accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || response.redirected) throw new Error(`배포 증거 엔드포인트가 HTTP ${response.status} 또는 redirect를 반환했습니다.`);
  const body = await response.json();
  const report = body?.report;
  if (
    report?.overall !== "ready" ||
    !Number.isInteger(report?.verifiedCount) ||
    report.verifiedCount !== report.totalCount ||
    !Array.isArray(report.items) ||
    report.items.some((item) => item.status !== "verified")
  ) {
    throw new Error("배포본의 공개 출시 증거가 전 항목 verified/ready가 아닙니다.");
  }
  if (
    !Array.isArray(body.approvedArtifactDigests) ||
    body.approvedArtifactDigests.length === 0 ||
    body.approvedArtifactDigests.some((digest) => !SHA256_PATTERN.test(digest))
  ) {
    throw new Error("배포본이 독립 승인·원본 검증된 artifact SHA-256 목록을 공개하지 않습니다.");
  }
  return {
    report,
    approvedArtifactDigests: [
      ...new Set(body.approvedArtifactDigests.map((digest) => digest.toLowerCase())),
    ],
  };
}

function cloudflareResult(body) {
  if (!body || body.success !== true || !body.result) {
    throw new Error("Cloudflare control-plane 응답이 success=true 결과를 포함하지 않습니다.");
  }
  return body.result;
}

export function verifyCloudflareReleaseControlPlane({
  manifest,
  deployed,
  deploymentsBody,
  versionBody,
}) {
  const expectedVersionId = manifest.cloudflare?.versionId;
  const expectedScriptEtag = manifest.cloudflare?.scriptEtag;
  if (!WORKER_VERSION_ID_PATTERN.test(expectedVersionId ?? "")) {
    throw new Error("manifest.cloudflare.versionId가 유효하지 않습니다.");
  }
  if (
    typeof expectedScriptEtag !== "string" ||
    expectedScriptEtag.length < 8 ||
    expectedScriptEtag.length > 256
  ) {
    throw new Error("manifest.cloudflare.scriptEtag가 유효하지 않습니다.");
  }
  if (
    deployed?.source !==
      "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION" ||
    deployed.versionId !== expectedVersionId ||
    deployed.versionTag?.toLowerCase() !== manifest.commitSha.toLowerCase() ||
    !Number.isFinite(Date.parse(deployed.versionTimestamp ?? ""))
  ) {
    throw new Error("운영 응답의 Cloudflare version metadata가 제출 영수증과 일치하지 않습니다.");
  }

  const deploymentResult = cloudflareResult(deploymentsBody);
  const deployments = Array.isArray(deploymentResult)
    ? deploymentResult
    : deploymentResult.deployments;
  const active = Array.isArray(deployments) ? deployments[0] : undefined;
  if (
    !active ||
    !Array.isArray(active.versions) ||
    active.versions.length !== 1 ||
    active.versions[0]?.version_id !== expectedVersionId ||
    Number(active.versions[0]?.percentage) !== 100
  ) {
    throw new Error("운영 Worker는 제출 version 하나만 100% 트래픽으로 제공해야 합니다.");
  }

  const version = cloudflareResult(versionBody);
  const controlPlaneTag =
    version.metadata?.annotations?.["workers/tag"] ??
    version.annotations?.["workers/tag"];
  const controlPlaneTimestamp =
    version.metadata?.created_on ?? version.created_on;
  const scriptEtag = version.resources?.script?.etag;
  if (
    version.id !== expectedVersionId ||
    String(controlPlaneTag ?? "").toLowerCase() !==
      manifest.commitSha.toLowerCase() ||
    !Number.isFinite(Date.parse(controlPlaneTimestamp ?? "")) ||
    Date.parse(controlPlaneTimestamp) !== Date.parse(deployed.versionTimestamp) ||
    scriptEtag !== expectedScriptEtag
  ) {
    throw new Error("Cloudflare version 상세의 tag·생성시각·script etag가 배포 영수증과 다릅니다.");
  }
  return {
    workerName: CLOUDFLARE_WORKER_NAME,
    versionId: expectedVersionId,
    scriptEtag,
    trafficPercentage: 100,
  };
}

async function fetchCloudflareControlPlane(pathname, apiToken) {
  const url = new URL(pathname, CLOUDFLARE_API_ORIGIN);
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
    },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || response.redirected) {
    throw new Error(`Cloudflare control-plane ${url.pathname}가 HTTP ${response.status} 또는 redirect를 반환했습니다.`);
  }
  return response.json();
}

async function verifyLiveCloudflareRelease(manifest, deployed) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "") || !apiToken) {
    throw new Error("전체 제출 게이트에는 Workers Scripts Read 전용 CLOUDFLARE_ACCOUNT_ID/API_TOKEN이 필요합니다.");
  }
  const basePath = `/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(CLOUDFLARE_WORKER_NAME)}`;
  const versionId = manifest.cloudflare?.versionId ?? "";
  const [deploymentsBody, versionBody] = await Promise.all([
    fetchCloudflareControlPlane(`${basePath}/deployments`, apiToken),
    fetchCloudflareControlPlane(
      `${basePath}/versions/${encodeURIComponent(versionId)}`,
      apiToken,
    ),
  ]);
  return verifyCloudflareReleaseControlPlane({
    manifest,
    deployed,
    deploymentsBody,
    versionBody,
  });
}

async function loadSignedReleaseArtifactManifests(receipt) {
  const [bundleFile, assetFile] = await Promise.all([
    loadInsideRoot(receipt.bundleManifestPath),
    loadInsideRoot(receipt.assetManifestPath),
  ]);
  let bundleManifest;
  let assetManifest;
  try {
    bundleManifest = JSON.parse(bundleFile.source);
    assetManifest = JSON.parse(assetFile.source);
  } catch {
    throw new Error("Canonical release manifests must be valid JSON.");
  }
  const identity = verifyReleaseArtifactManifests({
    receipt,
    bundleManifest,
    assetManifest,
  });
  return { bundleManifest, assetManifest, identity };
}

async function runFullGate(manifestPath) {
  if (!manifestPath) throw new Error("--manifest <제출 매니페스트 JSON>이 필요합니다.");
  const { source: manifestSource } = await loadInsideRoot(manifestPath);
  const manifest = JSON.parse(manifestSource);
  if (manifest.schemaVersion !== 2) throw new Error("지원하지 않는 제출 매니페스트 버전입니다.");
  if (!/^[a-f0-9]{40}$/i.test(manifest.commitSha ?? "")) throw new Error("commitSha는 40자리 Git SHA여야 합니다.");
  const deploymentUrl = new URL(manifest.deploymentUrl);
  if (
    deploymentUrl.origin !== CANONICAL_DEPLOYMENT_ORIGIN ||
    deploymentUrl.href !== `${CANONICAL_DEPLOYMENT_ORIGIN}/` ||
    deploymentUrl.username ||
    deploymentUrl.password
  ) {
    throw new Error(`배포 URL은 고정 운영 origin ${CANONICAL_DEPLOYMENT_ORIGIN}이어야 합니다.`);
  }
  const context = {
    commitSha: manifest.commitSha.toLowerCase(),
    deploymentUrl: deploymentUrl.href.replace(/\/$/, ""),
  };

  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (head !== context.commitSha) throw new Error(`현재 HEAD ${head}가 제출 SHA와 다릅니다.`);
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (dirty) throw new Error("제출 게이트는 변경사항이 없는 작업트리에서만 실행할 수 있습니다.");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", head, "origin/main"], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    throw new Error("제출 SHA가 origin/main에 푸시되지 않았습니다.");
  }

  const receiptEntry = manifest.releaseReceipt;
  if (
    !receiptEntry ||
    typeof receiptEntry.path !== "string" ||
    !receiptEntry.path.trim()
  ) {
    throw new Error("submission manifest requires a local releaseReceipt.path.");
  }
  const {
    source: receiptSource,
    absolutePath: receiptAbsolutePath,
  } = await loadInsideRoot(receiptEntry.path);
  let releaseReceipt;
  try {
    releaseReceipt = JSON.parse(receiptSource);
  } catch {
    throw new Error("Release receipt must be valid JSON.");
  }
  verifyReleaseReceiptManifest({
    manifest,
    receipt: releaseReceipt,
    receiptSha256: sha256(receiptSource),
  });
  const releaseAttestation = verifyReleaseReceiptAttestation({
    absolutePath: receiptAbsolutePath,
    commitSha: context.commitSha,
  });
  const signedReleaseManifests = await loadSignedReleaseArtifactManifests(
    releaseReceipt,
  );

  const datasets = {};
  const artifactHashes = {};
  for (const name of Object.keys(REQUIRED_ARTIFACTS)) {
    const entry = manifest.artifacts?.[name];
    if (!entry?.path || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) {
      throw new Error(`artifacts.${name}에는 path와 64자리 sha256이 필요합니다.`);
    }
    const { source } = await loadInsideRoot(entry.path);
    if (sha256(source) !== entry.sha256.toLowerCase()) {
      throw new Error(`${name} 증거 파일 해시가 매니페스트와 다릅니다.`);
    }
    artifactHashes[name] = entry.sha256.toLowerCase();
    const parsed = parseCsv(source);
    for (const header of REQUIRED_HEADERS[name]) {
      if (!parsed.headers.includes(header)) throw new Error(`${entry.path}에 ${header} 헤더가 없습니다.`);
    }
    datasets[name] = parsed.rows;
  }

  const deployedBefore = await fetchDeploymentVersion(context.deploymentUrl);
  if (deployedBefore.commitSha?.toLowerCase() !== context.commitSha) {
    throw new Error(`배포 SHA ${deployedBefore.commitSha ?? "없음"}가 제출 SHA와 다릅니다.`);
  }
  if (deployedBefore.releaseBuild !== true) throw new Error("배포본이 releaseBuild=true로 식별되지 않습니다.");
  if (deployedBefore.releaseReady !== true) throw new Error("배포본의 releaseReady가 true가 아닙니다.");
  const cloudflareBefore = await verifyLiveCloudflareRelease(
    manifest,
    deployedBefore,
  );
  verifyReleaseReceiptRemote({
    receipt: releaseReceipt,
    deployed: deployedBefore,
    cloudflareRelease: cloudflareBefore,
  });

  const [releaseEvidence, productionAssets] = await Promise.all([
    fetchReleaseEvidence(context.deploymentUrl),
    verifyProductionAssetManifest(signedReleaseManifests.assetManifest),
  ]);
  const deployed = await fetchDeploymentVersion(context.deploymentUrl);
  const cloudflareRelease = await verifyLiveCloudflareRelease(manifest, deployed);
  const releaseReceiptIdentity = verifyReleaseReceiptRemote({
    receipt: releaseReceipt,
    deployed,
    cloudflareRelease,
  });
  if (
    deployedBefore.versionId !== deployed.versionId ||
    deployedBefore.commitSha?.toLowerCase() !== deployed.commitSha?.toLowerCase() ||
    cloudflareBefore.versionId !== cloudflareRelease.versionId ||
    cloudflareBefore.scriptEtag !== cloudflareRelease.scriptEtag
  ) {
    throw new Error(
      "Production release identity changed while static assets and evidence were being verified.",
    );
  }

  const approvedArtifactDigests = new Set(releaseEvidence.approvedArtifactDigests);
  for (const [name, digest] of Object.entries(artifactHashes)) {
    if (!approvedArtifactDigests.has(digest)) {
      throw new Error(`${name} 제출 파일이 배포본에서 실제 원본 검증·독립 승인된 artifact와 일치하지 않습니다.`);
    }
  }
  const evidenceContext = {
    ...context,
    approvedArtifactDigests: releaseEvidence.approvedArtifactDigests,
    consentLedgerSha: artifactHashes.consentLedger,
  };
  const result = evaluateEvidence(datasets, evidenceContext);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  const remoteArtifacts = await verifyDatasetArtifactReferences(
    datasets,
    evidenceContext,
  );
  return {
    ...result,
    deployment: deployed,
    cloudflareRelease,
    releaseReceipt: {
      ...releaseReceiptIdentity,
      ...signedReleaseManifests.identity,
      attestation: releaseAttestation,
      productionAssets,
    },
    releaseEvidence: {
      overall: releaseEvidence.report.overall,
      verified: `${releaseEvidence.report.verifiedCount}/${releaseEvidence.report.totalCount}`,
      approvedArtifactDigests: releaseEvidence.approvedArtifactDigests.length,
      fetchedRemoteArtifacts: remoteArtifacts.length,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.structureOnly
    ? await verifyStructure()
    : await runFullGate(args.manifest);
  console.log(JSON.stringify(result, null, 2));
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`SUBMISSION_GATE_FAILED\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
