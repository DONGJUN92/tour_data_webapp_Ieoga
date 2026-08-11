import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const APPLICATION_SAFETY_CONTRACT_VERSION = "2026-08-v2";
const RECOVERY_RULE_VERSION = "2026.08-continuity-v3";

export const PLAYWRIGHT_D1_FIXTURE = Object.freeze({
  primarySessionId: "11111111-1111-4111-8111-111111111111",
  lateSessionId: "22222222-2222-4222-8222-222222222222",
  expiredSessionId: "33333333-3333-4333-8333-333333333333",
  runA: "10000000-0000-4000-8000-000000000001",
  runB: "10000000-0000-4000-8000-000000000002",
  staleRun: "10000000-0000-4000-8000-000000000003",
  optionA: "e2e-open-window-option-a",
  optionB: "e2e-open-window-option-b",
  staleOption: "e2e-open-window-option-stale",
  lateExecutionId: "e2e-late-contract-execution",
  lateCurrentStepId: "e2e-late-next-fixed-step",
  lateRemainingStepId: "e2e-late-remaining-step",
  expiredExecutionId: "e2e-expired-execution",
  expiredCurrentStepId: "e2e-expired-current-step",
});

function iso(nowMs, deltaMs) {
  return new Date(nowMs + deltaMs).toISOString();
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite SQL fixture value.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insert(table, values) {
  const columns = Object.keys(values)
    .map((column) => `\`${column}\``)
    .join(", ");
  const literals = Object.values(values).map(sqlLiteral).join(", ");
  return `INSERT INTO \`${table}\` (${columns}) VALUES (${literals});`;
}

function encryptApplicationSnapshot(snapshot, runId, optionId, signingKey) {
  const key = createHash("sha256")
    .update(`ieoga-recovery-application-snapshot-v2:${signingKey}`)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${runId}:${optionId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(snapshot), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({
    version: 2,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function recoveryRun({
  id,
  sessionId,
  now,
  expiresAt,
  optionCount = 1,
}) {
  return insert("recovery_runs", {
    id,
    session_id: sessionId,
    recovery_mode: "open_window",
    incident: "delay",
    audience: "general",
    region_code: "11",
    district_code: "11110",
    time_budget_bucket: "45-59m",
    distance_bucket: "500-999m",
    indoor_required: false,
    status: "verified",
    rule_version: RECOVERY_RULE_VERSION,
    option_count: optionCount,
    rejected_count: 0,
    changed_node_count: 1,
    locked_node_count: 0,
    locked_nodes_preserved: 1,
    next_fixed_preserved: null,
    analytics_eligible: false,
    created_at: now,
    completed_at: now,
    expires_at: expiresAt,
  });
}

function openWindowOption({
  runId,
  optionId,
  contentId,
  title,
  address,
  checkedAt,
  visitStartAt,
  visitEndAt,
  windowStartAt,
  windowEndAt,
  signingKey,
}) {
  const openWindow = {
    windowStartAt,
    windowEndAt,
    status: "fits",
    returnMinutes: 10,
    returnBasis: "origin_return_route",
    returnProvider: "openstreetmap_osrm",
    returnDistanceMeters: 700,
    returnCalculatedAt: checkedAt,
    requiredBufferMinutes: 15,
    leftoverMinutes: 45,
  };
  const scheduleDiff = {
    recoveryMode: "open_window",
    replacementNode: {
      id: "inserted-stop",
      title,
      startAt: visitStartAt,
      endAt: visitEndAt,
      durationMinutes: 20,
    },
    openWindow,
    preservedWaypoints: [],
  };
  const snapshot = {
    contentId,
    title,
    address,
    latitude: 37.5759,
    longitude: 126.9768,
    generatedAt: checkedAt,
    contractVersion: APPLICATION_SAFETY_CONTRACT_VERSION,
    ruleVersion: RECOVERY_RULE_VERSION,
    recoveryMode: "open_window",
    availability: { status: "confirmed_open", checkedAt },
    confirmationRequired: false,
    evidenceGapCodes: [],
    visitStartAt,
    visitEndAt,
    openWindow,
  };
  return insert("recovery_options", {
    id: optionId,
    run_id: runId,
    rank: 1,
    content_id: contentId,
    title,
    content_type_id: "12",
    status: "applicable",
    score: 91,
    distance_bucket: "500-999m",
    travel_minutes_bucket: "10-19m",
    accessibility_status: "not_required",
    crowd_status: "unavailable",
    source_names_json: JSON.stringify(["KorService2", "OSRM"]),
    changed_node_count: 1,
    next_fixed_status: "open_window_fits",
    arrival_buffer_minutes: 10,
    schedule_diff_json: JSON.stringify(scheduleDiff),
    continuity_proof_json: JSON.stringify({
      availabilityEvidence: {
        status: "confirmed_open",
        checkedAt,
      },
      openWindow,
    }),
    application_snapshot_json: encryptApplicationSnapshot(
      snapshot,
      runId,
      optionId,
      signingKey,
    ),
    safety_contract_version: APPLICATION_SAFETY_CONTRACT_VERSION,
    availability_status: "confirmed_open",
    availability_checked_at: checkedAt,
    visit_start_at: visitStartAt,
    visit_end_at: visitEndAt,
    confirmation_required: false,
    evidence_gap_count: 0,
  });
}

function lifecycleFixture({
  sessionId,
  runId,
  optionId,
  itineraryId,
  executionId,
  currentStepId,
  remainingStepId,
  now,
  executionExpiresAt,
  runExpiresAt,
  scheduledAt,
}) {
  const rows = [
    recoveryRun({
      id: runId,
      sessionId,
      now,
      expiresAt: runExpiresAt,
    }),
    insert("recovery_options", {
      id: optionId,
      run_id: runId,
      rank: 1,
      content_id: `${optionId}-content`,
      title: "Lifecycle fixture",
      status: "applied",
      score: 80,
      distance_bucket: "0-499m",
      travel_minutes_bucket: "0-9m",
      accessibility_status: "not_required",
      crowd_status: "unavailable",
      source_names_json: "[]",
    }),
    insert("itineraries", {
      id: itineraryId,
      session_id: sessionId,
      title: "Lifecycle fixture itinerary",
      timezone: "Asia/Seoul",
      audience: "general",
      status: "active",
      node_count: remainingStepId ? 2 : 1,
      locked_node_count: 1,
      analytics_eligible: false,
      created_at: now,
      updated_at: now,
      expires_at: runExpiresAt,
    }),
    insert("journey_executions", {
      id: executionId,
      session_id: sessionId,
      base_itinerary_id: itineraryId,
      source_run_id: runId,
      source_option_id: optionId,
      version_key: `${runId}:${optionId}`,
      active_session_key: sessionId,
      status: "active",
      current_step_sequence: 0,
      next_fixed_step_sequence: 0,
      activated_at: now,
      outcome_prompt_at: now,
      contract_met_at: null,
      contract_missed_at: null,
      completed_at: null,
      updated_at: now,
      expires_at: executionExpiresAt,
    }),
    insert("journey_execution_steps", {
      id: currentStepId,
      execution_id: executionId,
      sequence: 0,
      original_node_id: `${executionId}-fixed-node`,
      role: "next_fixed",
      title: "Next fixed reservation",
      type: "reservation",
      scheduled_at: scheduledAt,
      estimated_arrival_at: scheduledAt,
      duration_minutes: 30,
      location_label: "Seoul",
      latitude: 37.5759,
      longitude: 126.9768,
      locked: true,
      reservation: true,
      verification_status: "continuity_verified",
      status: "current",
    }),
  ];
  if (remainingStepId) {
    rows.push(
      insert("journey_execution_steps", {
        id: remainingStepId,
        execution_id: executionId,
        sequence: 1,
        original_node_id: `${executionId}-remaining-node`,
        role: "remaining_original",
        title: "Remaining original stop",
        type: "visit",
        scheduled_at: iso(Date.parse(now), 60 * 60_000),
        estimated_arrival_at: iso(Date.parse(now), 55 * 60_000),
        duration_minutes: 30,
        location_label: "Seoul",
        latitude: 37.576,
        longitude: 126.977,
        locked: false,
        reservation: false,
        verification_status: "resumed_original",
        status: "pending",
      }),
    );
  }
  return rows;
}

export function createPlaywrightSessionCookie(sessionId, signingKey) {
  const signature = createHmac("sha256", signingKey)
    .update(`ieoga-session-v1:${sessionId}`)
    .digest("base64url");
  return `ieoga_session=v1.${sessionId}.${signature}`;
}

export function buildPlaywrightD1FixtureSql({ signingKey, now = new Date() }) {
  if (typeof signingKey !== "string" || Buffer.byteLength(signingKey) !== 32) {
    throw new TypeError("Playwright fixture requires the exact 32-byte test key.");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid fixture clock.");
  const createdAt = now.toISOString();
  const sessionExpiresAt = iso(nowMs, 24 * 60 * 60_000);
  const checkedAt = iso(nowMs, 30_000);
  const staleCheckedAt = iso(nowMs, -20 * 60_000);
  const visitStartAt = iso(nowMs, 45 * 60_000);
  const visitEndAt = iso(nowMs, 65 * 60_000);
  const windowStartAt = iso(nowMs, -5 * 60_000);
  const windowEndAt = iso(nowMs, 2 * 60 * 60_000);
  const statements = [];

  for (const sessionId of [
    PLAYWRIGHT_D1_FIXTURE.primarySessionId,
    PLAYWRIGHT_D1_FIXTURE.lateSessionId,
    PLAYWRIGHT_D1_FIXTURE.expiredSessionId,
  ]) {
    statements.push(
      insert("sessions", {
        id: sessionId,
        analytics_consent: false,
        created_at: createdAt,
        updated_at: createdAt,
        expires_at: sessionExpiresAt,
      }),
    );
  }

  for (const [runId, optionId, suffix] of [
    [PLAYWRIGHT_D1_FIXTURE.runA, PLAYWRIGHT_D1_FIXTURE.optionA, "A"],
    [PLAYWRIGHT_D1_FIXTURE.runB, PLAYWRIGHT_D1_FIXTURE.optionB, "B"],
  ]) {
    statements.push(
      recoveryRun({
        id: runId,
        sessionId: PLAYWRIGHT_D1_FIXTURE.primarySessionId,
        now: createdAt,
        expiresAt: sessionExpiresAt,
      }),
      openWindowOption({
        runId,
        optionId,
        contentId: `e2e-place-${suffix.toLowerCase()}`,
        title: `E2E safe stop ${suffix}`,
        address: "Seoul, Jongno-gu",
        checkedAt,
        visitStartAt,
        visitEndAt,
        windowStartAt,
        windowEndAt,
        signingKey,
      }),
    );
  }

  statements.push(
    recoveryRun({
      id: PLAYWRIGHT_D1_FIXTURE.staleRun,
      sessionId: PLAYWRIGHT_D1_FIXTURE.primarySessionId,
      now: createdAt,
      expiresAt: sessionExpiresAt,
    }),
    openWindowOption({
      runId: PLAYWRIGHT_D1_FIXTURE.staleRun,
      optionId: PLAYWRIGHT_D1_FIXTURE.staleOption,
      contentId: "e2e-place-stale",
      title: "E2E stale stop",
      address: "Seoul, Jongno-gu",
      checkedAt: staleCheckedAt,
      visitStartAt,
      visitEndAt,
      windowStartAt,
      windowEndAt,
      signingKey,
    }),
  );

  statements.push(
    ...lifecycleFixture({
      sessionId: PLAYWRIGHT_D1_FIXTURE.lateSessionId,
      runId: "20000000-0000-4000-8000-000000000001",
      optionId: "e2e-late-lifecycle-option",
      itineraryId: "20000000-0000-4000-8000-000000000002",
      executionId: PLAYWRIGHT_D1_FIXTURE.lateExecutionId,
      currentStepId: PLAYWRIGHT_D1_FIXTURE.lateCurrentStepId,
      remainingStepId: PLAYWRIGHT_D1_FIXTURE.lateRemainingStepId,
      now: createdAt,
      executionExpiresAt: sessionExpiresAt,
      runExpiresAt: sessionExpiresAt,
      scheduledAt: iso(nowMs, -60_000),
    }),
    ...lifecycleFixture({
      sessionId: PLAYWRIGHT_D1_FIXTURE.expiredSessionId,
      runId: "30000000-0000-4000-8000-000000000001",
      optionId: "e2e-expired-lifecycle-option",
      itineraryId: "30000000-0000-4000-8000-000000000002",
      executionId: PLAYWRIGHT_D1_FIXTURE.expiredExecutionId,
      currentStepId: PLAYWRIGHT_D1_FIXTURE.expiredCurrentStepId,
      remainingStepId: null,
      now: iso(nowMs, -2 * 60 * 60_000),
      executionExpiresAt: iso(nowMs, -60_000),
      runExpiresAt: sessionExpiresAt,
      scheduledAt: iso(nowMs, -90 * 60_000),
    }),
  );

  return `${statements.join("\n")}\n`;
}
