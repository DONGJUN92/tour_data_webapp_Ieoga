import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = () =>
  text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  analyticsConsent: integer("analytics_consent", { mode: "boolean" })
    .notNull()
    .default(false),
  consentVersion: text("consent_version"),
  createdAt: createdAt(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  deletedAt: text("deleted_at"),
});

export const administrativeAreas = sqliteTable(
  "administrative_areas",
  {
    code: text("code").primaryKey(),
    parentCode: text("parent_code"),
    name: text("name").notNull(),
    level: text("level").notNull(),
    codeVersion: text("code_version").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sourceUpdatedAt: text("source_updated_at"),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("administrative_areas_parent_idx").on(table.parentCode),
    index("administrative_areas_level_idx").on(table.level),
  ],
);

export const itineraries = sqliteTable(
  "itineraries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    timezone: text("timezone").notNull().default("Asia/Seoul"),
    audience: text("audience").notNull().default("general"),
    status: text("status").notNull().default("active"),
    nodeCount: integer("node_count").notNull().default(0),
    lockedNodeCount: integer("locked_node_count").notNull().default(0),
    analyticsEligible: integer("analytics_eligible", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("itineraries_session_idx").on(table.sessionId, table.updatedAt),
    index("itineraries_status_idx").on(table.status, table.expiresAt),
  ],
);

export const itineraryNodes = sqliteTable(
  "itinerary_nodes",
  {
    id: text("id").primaryKey(),
    itineraryId: text("itinerary_id")
      .notNull()
      .references(() => itineraries.id, { onDelete: "cascade" }),
    clientNodeId: text("client_node_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    startAt: text("start_at"),
    endAt: text("end_at"),
    durationMinutes: integer("duration_minutes"),
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    reservation: integer("reservation", { mode: "boolean" })
      .notNull()
      .default(false),
    locationLabel: text("location_label"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    regionCode: text("region_code"),
    districtCode: text("district_code"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("itinerary_nodes_client_idx").on(
      table.itineraryId,
      table.clientNodeId,
    ),
    uniqueIndex("itinerary_nodes_sequence_idx").on(
      table.itineraryId,
      table.sequence,
    ),
    index("itinerary_nodes_schedule_idx").on(
      table.itineraryId,
      table.startAt,
    ),
  ],
);

export const recoveryRuns = sqliteTable(
  "recovery_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    itineraryId: text("itinerary_id").references(() => itineraries.id, {
      onDelete: "set null",
    }),
    disruptedNodeId: text("disrupted_node_id"),
    nextFixedNodeId: text("next_fixed_node_id"),
    recoveryMode: text("recovery_mode")
      .notNull()
      .default("proximity_fallback"),
    incident: text("incident").notNull(),
    audience: text("audience").notNull(),
    regionCode: text("region_code"),
    districtCode: text("district_code").notNull().default("_all"),
    timeBudgetBucket: text("time_budget_bucket").notNull(),
    distanceBucket: text("distance_bucket").notNull(),
    indoorRequired: integer("indoor_required", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status").notNull(),
    ruleVersion: text("rule_version").notNull(),
    optionCount: integer("option_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    changedNodeCount: integer("changed_node_count"),
    lockedNodeCount: integer("locked_node_count"),
    lockedNodesPreserved: integer("locked_nodes_preserved"),
    nextFixedPreserved: integer("next_fixed_preserved", { mode: "boolean" }),
    decisionProofJson: text("decision_proof_json"),
    itineraryImpactHash: text("itinerary_impact_hash"),
    counterfactualJson: text("counterfactual_json"),
    analyticsEligible: integer("analytics_eligible", { mode: "boolean" })
      .notNull()
      .default(false),
    failureCode: text("failure_code"),
    startedAt: createdAt(),
    completedAt: text("completed_at"),
    expiresAt: text("expires_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("recovery_runs_session_idx").on(table.sessionId),
    index("recovery_runs_itinerary_idx").on(table.itineraryId, table.startedAt),
    index("recovery_runs_region_idx").on(table.regionCode, table.districtCode),
    index("recovery_runs_started_idx").on(table.startedAt),
  ],
);

export const recoveryOptions = sqliteTable(
  "recovery_options",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => recoveryRuns.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    contentId: text("content_id"),
    title: text("title").notNull(),
    contentTypeId: text("content_type_id"),
    status: text("status").notNull(),
    score: real("score").notNull(),
    distanceBucket: text("distance_bucket").notNull(),
    travelMinutesBucket: text("travel_minutes_bucket").notNull(),
    accessibilityStatus: text("accessibility_status").notNull(),
    crowdStatus: text("crowd_status").notNull(),
    sourceNamesJson: text("source_names_json").notNull(),
    changedNodeCount: integer("changed_node_count"),
    nextFixedStatus: text("next_fixed_status"),
    arrivalBufferMinutes: integer("arrival_buffer_minutes"),
    routeEvidenceJson: text("route_evidence_json"),
    scheduleDiffJson: text("schedule_diff_json"),
    continuityProofJson: text("continuity_proof_json"),
    applicationSnapshotJson: text("application_snapshot_json"),
    safetyContractVersion: text("safety_contract_version"),
    availabilityStatus: text("availability_status"),
    availabilityCheckedAt: text("availability_checked_at"),
    visitStartAt: text("visit_start_at"),
    visitEndAt: text("visit_end_at"),
    confirmationRequired: integer("confirmation_required", {
      mode: "boolean",
    }),
    evidenceGapCount: integer("evidence_gap_count"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("recovery_options_rank_idx").on(table.runId, table.rank),
    index("recovery_options_content_idx").on(table.contentId),
  ],
);

export const recoveryOutcomes = sqliteTable(
  "recovery_outcomes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => recoveryRuns.id, { onDelete: "cascade" }),
    optionId: text("option_id").references(() => recoveryOptions.id, {
      onDelete: "set null",
    }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    occurredAt: text("occurred_at").notNull(),
    actualArrivalAt: text("actual_arrival_at"),
    arrivedOnTime: integer("arrived_on_time", { mode: "boolean" }),
    reasonCode: text("reason_code"),
    changedNodeCount: integer("changed_node_count"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (table) => [
    index("recovery_outcomes_run_idx").on(table.runId, table.occurredAt),
    index("recovery_outcomes_session_idx").on(
      table.sessionId,
      table.occurredAt,
    ),
    index("recovery_outcomes_event_idx").on(table.event, table.occurredAt),
  ],
);

export const journeyExecutions = sqliteTable(
  "journey_executions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    baseItineraryId: text("base_itinerary_id")
      .notNull()
      .references(() => itineraries.id, { onDelete: "cascade" }),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => recoveryRuns.id, { onDelete: "cascade" }),
    sourceOptionId: text("source_option_id")
      .notNull()
      .references(() => recoveryOptions.id, { onDelete: "cascade" }),
    versionKey: text("version_key").notNull(),
    activeSessionKey: text("active_session_key"),
    status: text("status").notNull().default("active"),
    currentStepSequence: integer("current_step_sequence")
      .notNull()
      .default(0),
    nextFixedStepSequence: integer("next_fixed_step_sequence").notNull(),
    activatedAt: text("activated_at").notNull(),
    outcomePromptAt: text("outcome_prompt_at").notNull(),
    contractMetAt: text("contract_met_at"),
    contractMissedAt: text("contract_missed_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("journey_executions_version_idx").on(table.versionKey),
    uniqueIndex("journey_executions_active_session_idx").on(
      table.activeSessionKey,
    ),
    index("journey_executions_session_idx").on(
      table.sessionId,
      table.updatedAt,
    ),
    index("journey_executions_run_idx").on(table.sourceRunId),
  ],
);

export const journeyExecutionSteps = sqliteTable(
  "journey_execution_steps",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => journeyExecutions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    originalNodeId: text("original_node_id"),
    role: text("role").notNull(),
    contentId: text("content_id"),
    title: text("title").notNull(),
    type: text("type").notNull(),
    scheduledAt: text("scheduled_at"),
    estimatedArrivalAt: text("estimated_arrival_at"),
    durationMinutes: integer("duration_minutes"),
    locationLabel: text("location_label"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    reservation: integer("reservation", { mode: "boolean" })
      .notNull()
      .default(false),
    verificationStatus: text("verification_status").notNull(),
    status: text("status").notNull().default("pending"),
    arrivedAt: text("arrived_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("journey_execution_steps_sequence_idx").on(
      table.executionId,
      table.sequence,
    ),
    index("journey_execution_steps_status_idx").on(
      table.executionId,
      table.status,
    ),
  ],
);

export const apiAuditLogs = sqliteTable(
  "api_audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").references(() => recoveryRuns.id, {
      onDelete: "set null",
    }),
    requestId: text("request_id").notNull(),
    apiName: text("api_name").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    sourceReferenceDate: text("source_reference_date"),
    fieldsUsedJson: text("fields_used_json").notNull().default("[]"),
    errorCode: text("error_code"),
    calledAt: createdAt(),
  },
  (table) => [
    index("api_audit_run_idx").on(table.runId),
    index("api_audit_request_idx").on(table.requestId),
    index("api_audit_source_idx").on(table.apiName, table.calledAt),
  ],
);

export const sourceHealth = sqliteTable(
  "source_health",
  {
    sourceName: text("source_name").primaryKey(),
    operation: text("operation").notNull(),
    status: text("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    resultCount: integer("result_count").notNull(),
    sourceReferenceDate: text("source_reference_date"),
    checkedAt: text("checked_at").notNull(),
    errorCode: text("error_code"),
  },
);

export const providerProbeSnapshots = sqliteTable(
  "provider_probe_snapshots",
  {
    provider: text("provider").primaryKey(),
    mode: text("mode").notNull(),
    configurationFingerprint: text("configuration_fingerprint").notNull(),
    endpointCount: integer("endpoint_count").notNull(),
    status: text("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    checkedAt: text("checked_at").notNull(),
    errorCode: text("error_code"),
  },
  (table) => [
    index("provider_probe_status_idx").on(table.status, table.checkedAt),
  ],
);

export const fieldEvidenceRegistry = sqliteTable(
  "field_evidence_registry",
  {
    id: text("id").primaryKey(),
    evidenceType: text("evidence_type").notNull(),
    sampleSize: integer("sample_size").notNull(),
    regionsJson: text("regions_json").notNull().default("[]"),
    metricsJson: text("metrics_json").notNull().default("{}"),
    artifactReference: text("artifact_reference").notNull(),
    reviewersJson: text("reviewers_json").notNull().default("[]"),
    measuredAt: text("measured_at").notNull(),
    reviewedAt: text("reviewed_at").notNull(),
    validated: integer("validated", { mode: "boolean" })
      .notNull()
      .default(false),
    validationErrorsJson: text("validation_errors_json")
      .notNull()
      .default("[]"),
    independentAuditStatus: text("independent_audit_status")
      .notNull()
      .default("pending"),
    approvedAt: text("approved_at"),
    approvedBy: text("approved_by"),
    auditNotes: text("audit_notes"),
    createdAt: createdAt(),
  },
  (table) => [
    index("field_evidence_type_date_idx").on(
      table.evidenceType,
      table.reviewedAt,
    ),
    index("field_evidence_validated_idx").on(
      table.validated,
      table.evidenceType,
    ),
    index("field_evidence_audit_status_idx").on(
      table.independentAuditStatus,
      table.evidenceType,
    ),
  ],
);

export const durableRateLimitWindows = sqliteTable(
  "durable_rate_limit_windows",
  {
    key: text("key").primaryKey(),
    namespace: text("namespace").notNull(),
    count: integer("count").notNull().default(1),
    resetAt: text("reset_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("durable_rate_limit_expiry_idx").on(table.expiresAt),
  ],
);

export const regionPolicySnapshots = sqliteTable(
  "region_policy_snapshots",
  {
    id: text("id").primaryKey(),
    regionCode: text("region_code").notNull(),
    districtCode: text("district_code").notNull().default("_all"),
    baseMonth: text("base_month").notNull(),
    status: text("status").notNull(),
    coveragePercent: real("coverage_percent").notNull(),
    metricsJson: text("metrics_json").notNull(),
    sourceLedgerJson: text("source_ledger_json").notNull(),
    calculationVersion: text("calculation_version").notNull(),
    checksum: text("checksum").notNull(),
    r2Key: text("r2_key"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("region_policy_snapshot_unique_idx").on(
      table.regionCode,
      table.districtCode,
      table.baseMonth,
      table.calculationVersion,
    ),
    index("region_policy_snapshot_region_idx").on(
      table.regionCode,
      table.districtCode,
    ),
  ],
);

export const syncPartitions = sqliteTable(
  "sync_partitions",
  {
    id: text("id").primaryKey(),
    regionCode: text("region_code").notNull(),
    districtCode: text("district_code").notNull().default("_all"),
    regionName: text("region_name").notNull(),
    districtName: text("district_name"),
    status: text("status").notNull().default("pending"),
    lastAttemptAt: text("last_attempt_at"),
    lastSuccessAt: text("last_success_at"),
    nextRunAt: text("next_run_at").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("sync_partitions_scope_idx").on(
      table.regionCode,
      table.districtCode,
    ),
    index("sync_partitions_due_idx").on(table.nextRunAt, table.status),
  ],
);

export const regionPacks = sqliteTable(
  "region_packs",
  {
    id: text("id").primaryKey(),
    regionCode: text("region_code").notNull(),
    districtCode: text("district_code").notNull().default("_all"),
    baseMonth: text("base_month").notNull(),
    calculationVersion: text("calculation_version").notNull(),
    objectKey: text("object_key").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status").notNull(),
    coveragePercent: real("coverage_percent").notNull(),
    sourceUpdatedAt: text("source_updated_at").notNull(),
    activatedAt: text("activated_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("region_packs_object_idx").on(table.objectKey),
    index("region_packs_scope_idx").on(
      table.regionCode,
      table.districtCode,
      table.activatedAt,
    ),
  ],
);

export const resilienceMissions = sqliteTable(
  "resilience_missions",
  {
    id: text("id").primaryKey(),
    regionCode: text("region_code").notNull(),
    districtCode: text("district_code").notNull().default("_all"),
    missionType: text("mission_type").notNull(),
    failureCategory: text("failure_category")
      .notNull()
      .default("data_gap"),
    status: text("status").notNull().default("open"),
    priority: integer("priority").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    actionText: text("action_text").notNull(),
    ownerOrganization: text("owner_organization")
      .notNull()
      .default("한국관광공사 관광데이터 운영 담당"),
    ownerRole: text("owner_role")
      .notNull()
      .default("미션 책임자"),
    deadlineAt: text("deadline_at")
      .notNull()
      .default("1970-01-01T00:00:00.000Z"),
    successCondition: text("success_condition")
      .notNull()
      .default("동일 시나리오 재검증에서 공백이 해소되어야 합니다."),
    evidenceRequirement: text("evidence_requirement")
      .notNull()
      .default("조치 전후를 확인할 수 있는 공식 증빙이 필요합니다."),
    scenarioJson: text("scenario_json").notNull().default("{}"),
    actionEvidenceJson: text("action_evidence_json")
      .notNull()
      .default("{}"),
    actionRecordedAt: text("action_recorded_at"),
    lastRevalidatedAt: text("last_revalidated_at"),
    lastRevalidationResult: text("last_revalidation_result"),
    revalidationCount: integer("revalidation_count")
      .notNull()
      .default(0),
    evidenceJson: text("evidence_json").notNull(),
    interventionsJson: text("interventions_json").notNull(),
    recommendedPlanJson: text("recommended_plan_json").notNull(),
    baselineValue: real("baseline_value"),
    currentValue: real("current_value"),
    sampleSize: integer("sample_size").notNull().default(0),
    minimumSampleSize: integer("minimum_sample_size").notNull().default(30),
    privacyState: text("privacy_state").notNull(),
    policyBaseMonth: text("policy_base_month"),
    calculationVersion: text("calculation_version").notNull(),
    firstDetectedAt: text("first_detected_at").notNull(),
    lastEvaluatedAt: text("last_evaluated_at").notNull(),
    resolvedAt: text("resolved_at"),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("resilience_missions_scope_type_idx").on(
      table.regionCode,
      table.districtCode,
      table.missionType,
      table.calculationVersion,
    ),
    index("resilience_missions_status_idx").on(
      table.status,
      table.priority,
      table.lastEvaluatedAt,
    ),
    index("resilience_missions_scope_idx").on(
      table.regionCode,
      table.districtCode,
    ),
    index("resilience_missions_failure_idx").on(
      table.failureCategory,
      table.status,
    ),
  ],
);

export const resilienceMissionEvents = sqliteTable(
  "resilience_mission_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    missionId: text("mission_id")
      .notNull()
      .references(() => resilienceMissions.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull().default("system"),
    note: text("note"),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (table) => [
    index("resilience_mission_events_mission_idx").on(
      table.missionId,
      table.createdAt,
    ),
  ],
);

export const proofShares = sqliteTable(
  "proof_shares",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => recoveryRuns.id, { onDelete: "cascade" }),
    optionId: text("option_id").references(() => recoveryOptions.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull(),
    proofJson: text("proof_json").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("proof_shares_token_idx").on(table.tokenHash),
    index("proof_shares_run_idx").on(table.runId),
  ],
);

export const consentEvents = sqliteTable(
  "consent_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    consentVersion: text("consent_version").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("consent_events_session_idx").on(table.sessionId)],
);

export const partnerClients = sqliteTable(
  "partner_clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    dailyLimit: integer("daily_limit").notNull().default(500),
    createdAt: createdAt(),
    revokedAt: text("revoked_at"),
  },
  (table) => [uniqueIndex("partner_clients_key_idx").on(table.keyHash)],
);

export const partnerUsageDaily = sqliteTable(
  "partner_usage_daily",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => partnerClients.id, { onDelete: "cascade" }),
    usageDate: text("usage_date").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("partner_usage_unique_idx").on(
      table.clientId,
      table.usageDate,
    ),
  ],
);
