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

/* 한국관광공사 상세 운영정보(`detailIntro2`) 원문의 로컬 사본.

   **판정이 아니라 원문을 저장한다.** 저장된 값은 매 요청마다
   `evaluateAvailabilityItem`으로 그 요청의 실제 체류 구간에 다시 대조된다. 그래서
   "09:00~18:00"을 저장해 두었더라도 밤 10시 20분 요청에서는 여전히
   `confirmed_closed`가 나온다. 판정 결과를 저장하면 그 순간 캐시가 거짓말을 하기
   시작한다.

   신선도는 시간이 아니라 **공사가 알려 주는 변경 시각**으로 판정한다. 후보 탐색
   응답(`locationBasedList2`)에는 각 콘텐츠의 `modifiedtime`이 들어 있고, 그 값이
   저장 당시와 같다면 지금 다시 호출해도 같은 응답이 온다는 뜻이다. HTTP의 ETag와
   같은 성질이고, "며칠 지났으니 아마 괜찮다"는 추측과는 다르다. 값이 다르면 그
   즉시 무효로 보고 실시간으로 다시 부른다.

   `expiresAt`은 그 위에 얹는 상한이다. `modifiedtime`이 운영시간 변경을 반드시
   반영한다고 보장할 수는 없으므로, 일치하더라도 일정 기간이 지나면 다시 부른다.

   이 표를 두는 이유는 호출 예산이다. Cloudflare 무료 플랜은 요청당 **외부** 호출을
   50건으로 막지만 D1·R2 같은 내부 서비스는 1,000건까지 허용한다. 후보 한 곳을
   검증하는 데 드는 외부 호출이 운영정보 1건 + 경로 1건이었는데, 운영정보를 이
   표에서 읽으면 같은 예산으로 검증할 수 있는 후보 수가 두 배가 된다. */
export const placeHoursSnapshots = sqliteTable(
  "place_hours_snapshots",
  {
    contentId: text("content_id").primaryKey(),
    contentTypeId: text("content_type_id").notNull(),
    /* 저장 당시 공사가 알린 콘텐츠 수정 시각. 신선도 판정의 기준값이다. */
    sourceModifiedAt: text("source_modified_at").notNull(),
    /* `detailIntro2` 항목 원문(JSON). 판정하지 않은 그대로를 담는다. */
    payload: text("payload").notNull(),
    fetchedAt: text("fetched_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    /* 만료된 행을 지우는 정리 작업용. */
    index("place_hours_snapshots_expiry_idx").on(table.expiresAt),
  ],
);

/* 실제 경로 조회 결과의 로컬 사본.

   출발지 좌표를 그대로 키로 쓰면 GPS가 1m만 흔들려도 사본을 쓸 수 없다. 그래서
   출발지를 약 150m 격자로 양자화해 키로 삼는다. 그 정도 거리에서 같은 목적지까지의
   보행 시간 차이는 경로 제공자의 표시 단위(분)보다 작다.

   도보·자전거는 시간과 무관한 값이다 — 이미 `lib/mobility/routing.ts`가 그렇게
   판단해 `${mode}:static:` 키로 캐시하고 있다. 자동차·대중교통은 교통 상황과
   시간표에 달려 있으므로 훨씬 짧은 상한을 쓴다. 어느 쪽이든 측정 시각
   (`calculatedAt`)이 근거와 함께 화면까지 전달되므로, 여행자는 이 숫자가 언제
   측정된 것인지 볼 수 있다. */
export const routeSnapshots = sqliteTable(
  "route_snapshots",
  {
    /* `${mode}:${originCell}:${destinationKey}` */
    id: text("id").primaryKey(),
    mode: text("mode").notNull(),
    /* 양자화한 출발지 격자 좌표. 사람이 읽고 검산할 수 있게 문자열로 둔다. */
    originCell: text("origin_cell").notNull(),
    destinationKey: text("destination_key").notNull(),
    /* `WalkingRouteEvidence` 원문(JSON). 여기서도 판정이 아니라 근거를 담는다. */
    payload: text("payload").notNull(),
    calculatedAt: text("calculated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("route_snapshots_expiry_idx").on(table.expiresAt)],
);

/* 지역별 "여행이 끊긴 이유"의 익명 집계.

   기획안 6.5는 `감지된 공백 → 자동 생성 미션 → 개선 확인` 루프를 약속한다 —
   "운영시간 누락으로 반복 탈락", "우천·유모차 대안 0개", "야간 복구 불가"처럼
   **실제 복구 실패에서** 미션이 나와야 한다. 그런데 지금까지 저장한 것은
   `recovery_runs.rejected_count` 숫자 하나뿐이어서, 그 루프의 재료가 쌓이지
   않고 있었다. 화면에 나오는 미션이 "정책 근거 데이터 완성도 점검"처럼 우리
   파이프라인 점검 항목뿐이었던 이유다.

   이 표는 사유별 건수만 담는다. 장소명도, 좌표도, 세션도 담지 않는다 — 엔진의
   `rejectionSummary`가 이미 "counts only, no place names"로 설계돼 있고, 그
   성질이 이 표를 지자체와 공유할 수 있게 만든다. 시군구·시각대·상황·대상만
   함께 담아 "어느 지역에서, 언제, 어떤 여행자에게, 무엇이 막았는가"를 답한다. */
export const regionalGapCounters = sqliteTable(
  "regional_gap_counters",
  {
    id: text("id").primaryKey(),
    regionCode: text("region_code").notNull(),
    districtCode: text("district_code").notNull().default("_all"),
    /* 탈락 사유 코드. 엔진의 `RejectionReasonCode`를 그대로 쓴다. */
    reasonCode: text("reason_code").notNull(),
    /* 낮과 밤을 가른다. "야간 복구 불가"는 기획안이 따로 든 공백이다. */
    dayPart: text("day_part").notNull(),
    /* 상황과 대상. "우천·유모차 대안 0개"를 답하려면 둘이 함께 필요하다. */
    incident: text("incident").notNull(),
    audience: text("audience").notNull(),
    /* 이 조합으로 누적된 탈락 건수와, 그 조합이 관측된 요청 수. */
    rejectionCount: integer("rejection_count").notNull().default(0),
    observationCount: integer("observation_count").notNull().default(0),
    /* 추천이 0곳이었던 요청 수. 공백의 심각도를 가른다. */
    emptyResultCount: integer("empty_result_count").notNull().default(0),
    firstSeenAt: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("regional_gap_scope_idx").on(
      table.regionCode,
      table.districtCode,
      table.reasonCode,
      table.dayPart,
      table.incident,
      table.audience,
    ),
    index("regional_gap_region_idx").on(table.regionCode, table.lastSeenAt),
  ],
);
