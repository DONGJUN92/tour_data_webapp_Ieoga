import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));

const { env } = await import("./cloudflare-workers.stub.mjs");
const { NextRequest } = await import("next/server");
const { requireSameOriginJsonMutation } = await import("../lib/http.ts");
const {
  activateRecoveryExecution,
  areKnownAdministrativeScopes,
  createProofShare,
  getProofShare,
  persistHealth,
  persistRecovery,
  recordRecoveryOutcome,
  revokeProofShare,
  saveItinerary,
  updateActiveJourneyExecution,
} = await import("../lib/db/repository.ts");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const { REQUIRED_KTO_HEALTH_SOURCES } = await import(
  "../lib/kto/health-snapshot.ts"
);
const { RECOVERY_RULE_VERSION } = await import(
  "../lib/recovery/engine.ts"
);
const {
  APPLICATION_SAFETY_CONTRACT_VERSION,
  createItineraryImpactSnapshot,
  encryptApplicationSnapshot,
} = await import("../lib/recovery/application-snapshot.ts");
const EXECUTION_SIGNING_KEY =
  "q8V4mN1pR7xK2tF9wD5sH0jL6aC3uE8zB1gY7kM";

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

class FakeD1 {
  constructor({
    failBatch = false,
    allResults = [],
    batchDelayMs = 0,
    enforceCommitDeadline = false,
  } = {}) {
    this.failBatch = failBatch;
    this.allResults = [...allResults];
    this.batchDelayMs = batchDelayMs;
    this.enforceCommitDeadline = enforceCommitDeadline;
    this.batchCalls = 0;
    this.batchedStatements = [];
    this.committedStatements = [];
    this.executedStatements = [];
  }

  prepare(sql) {
    const statement = {
      sql,
      bind: (...params) => {
        const bound = {
          sql,
          params,
          raw: async () => this.allResults.shift() ?? [],
          all: async () => ({
            results: this.allResults.shift() ?? [],
          }),
          run: async () => {
            this.executedStatements.push({ sql, params });
            return {
              success: true,
              results: [],
              meta: {},
            };
          },
        };
        return bound;
      },
    };
    return statement;
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.batchedStatements = statements;
    if (this.batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.batchDelayMs));
    }
    if (this.failBatch) throw new Error("D1_BATCH_FAILED");
    const finalStatement = statements.at(-1);
    if (
      this.enforceCommitDeadline &&
      /strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)/i.test(
        finalStatement?.sql ?? "",
      )
    ) {
      const deadline = finalStatement.params?.find(
        (value) =>
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T/.test(value),
      );
      if (!deadline || Date.now() >= Date.parse(deadline)) {
        throw new Error("D1_COMMIT_DEADLINE_GUARD");
      }
    }
    this.committedStatements = [...statements];
    return statements.map(() => ({
      success: true,
      results: [],
      meta: {},
    }));
  }
}

function itinerary() {
  return {
    id: "00000000-0000-4000-8000-000000000111",
    title: "원자 저장 검증 일정",
    timezone: "Asia/Seoul",
    audience: "general",
    nodes: [
      {
        id: "changeable",
        sequence: 0,
        type: "visit",
        title: "변경 가능 일정",
        startAt: "2026-07-16T10:00:00+09:00",
        locked: false,
        reservation: false,
      },
      {
        id: "fixed",
        sequence: 1,
        type: "reservation",
        title: "다음 예약",
        startAt: "2026-07-16T12:00:00+09:00",
        locked: true,
        reservation: true,
        location: {
          latitude: 37.57,
          longitude: 126.98,
          label: "예약 장소",
          areaCode: "11",
          sigunguCode: "11110",
        },
      },
    ],
  };
}

function recoveryParams() {
  return {
    sessionId: "00000000-0000-4000-8000-000000000222",
    input: {
      origin: {
        latitude: 37.5665,
        longitude: 126.978,
        label: "서울광장",
        areaCode: "11",
        sigunguCode: "11110",
      },
      incident: "delay",
      availableMinutes: 60,
      maxDistanceMeters: 3000,
      audience: "general",
      indoorOnly: false,
      radiusMeters: 5000,
      analyticsConsent: false,
      itinerary: {
        ...itinerary(),
        occurredAt: "2026-07-16T10:30:00+09:00",
        disruptedNodeId: "changeable",
        nextFixedNodeId: "fixed",
      },
    },
    result: {
      requestId: "00000000-0000-4000-8000-000000000333",
      status: "no_valid_candidate",
      recoveryMode: "registered_itinerary",
      itinerarySummary: {
        itineraryId: "00000000-0000-4000-8000-000000000111",
        title: "원자 저장 검증 일정",
        disruptedNodeId: "changeable",
        nextFixedNodeId: "fixed",
        lockedNodeCount: 1,
      },
      scope: {
        coverage: "nationwide",
        regionCode: "11",
        districtCode: "11110",
        originLabel: "서울광장",
      },
      options: [],
      rejectedCount: 0,
      dataContributions: [],
      sourceLedger: [],
      warnings: [],
      generatedAt: "2026-07-16T01:30:00.000Z",
      ruleVersion: "test-v1",
    },
  };
}

function recoveryParamsWithRawRouteGeometry() {
  const params = recoveryParams();
  params.result.status = "verified";
  params.result.options = [
    {
      id: "privacy-option-000000000001",
      evidenceGaps: [],
      confirmationRequired: false,
      strategy: "minimum_change",
      strategyLabel: "최소 변경",
      contentId: "candidate-privacy-1",
      contentTypeId: "14",
      title: "좌표 비저장 검증 장소",
      address: "서울특별시 종로구",
      latitude: 37.56789,
      longitude: 126.98123,
      score: 92,
      distanceMeters: 850,
      estimatedTravelMinutes: 14,
      routeGeometry: [
        { latitude: 37.5665, longitude: 126.978 },
        { latitude: 37.56789, longitude: 126.98123 },
      ],
      availability: {
        status: "confirmed_open",
        checkedAt: "2026-07-16T01:30:00.000Z",
        note: "운영시간 확인",
      },
      accessibility: {
        status: "not_required",
      },
      crowd: {
        status: "unavailable",
      },
      sources: ["KorService2"],
      scheduleDiff: {
        mode: "registered_itinerary",
        replacedNodeId: "changeable",
        replacementContentId: "candidate-privacy-1",
        changedNodeIds: ["changeable"],
        unchangedNodeIds: ["fixed"],
        lockedNodeIds: ["fixed"],
        preservedLockedNodeIds: ["fixed"],
        changedNodeCount: 1,
        nextFixedAppointmentPreserved: true,
        replacementNode: {
          id: "replacement-candidate-privacy-1",
          title: "좌표 비저장 검증 장소",
          startAt: "2026-07-16T10:40:00+09:00",
          endAt: "2026-07-16T11:10:00+09:00",
          durationMinutes: 30,
          location: {
            label: "저장하면 안 되는 위치",
            latitude: 37.56789,
            longitude: 126.98123,
          },
        },
        nextFixedAppointment: {
          nodeId: "fixed",
          title: "다음 예약",
          scheduledAt: "2026-07-16T12:00:00+09:00",
          estimatedArrivalAt: "2026-07-16T11:35:00+09:00",
          arrivalBufferMinutes: 25,
          safetyBufferMinutes: 15,
          status: "preserved",
        },
      },
      continuityProof: {
        schemaVersion: "2026-07-v2",
        objective: "minimize_changed_nodes_then_travel_minutes",
        recoveryMode: "registered_itinerary",
        changedNodeCount: 1,
        lockedNodesTotal: 1,
        lockedNodesPreserved: 1,
        nextFixedAppointmentPreserved: true,
        routeEvidence: {
          status: "routed",
          provider: "openstreetmap_osrm",
          distanceMeters: 1_500,
          durationMinutes: 24,
          legs: [
            { distanceMeters: 850, durationMinutes: 14 },
            { distanceMeters: 650, durationMinutes: 10 },
          ],
          geometry: [
            { latitude: 37.5665, longitude: 126.978 },
            { latitude: 37.56789, longitude: 126.98123 },
          ],
          routeGeometry: [
            [126.978, 37.5665],
            [126.98123, 37.56789],
          ],
          coordinates: [
            [126.978, 37.5665],
            [126.98123, 37.56789],
          ],
          calculatedAt: "2026-07-16T01:30:00.000Z",
          attribution: "© OpenStreetMap contributors",
        },
        availabilityEvidence: {
          status: "confirmed_open",
          checkedAt: "2026-07-16T01:30:00.000Z",
          note: "운영시간 확인",
        },
        generatedAt: "2026-07-16T01:30:00.000Z",
      },
      dataContributions: [],
    },
  ];
  params.result.dataContributions = [];
  return params;
}

test("persistRecovery submits all writes through one D1 atomic batch", async () => {
  const fake = new FakeD1();
  env.DB = fake;

  const result = await persistRecovery(recoveryParams());

  assert.deepEqual(result, { persisted: true });
  assert.equal(fake.batchCalls, 1);
  assert.ok(fake.batchedStatements.length >= 2);
  assert.ok(
    fake.batchedStatements.some((statement) =>
      /insert into "recovery_runs"/i.test(statement.sql),
    ),
  );
});

test("saveItinerary atomically replaces the header and complete node set", async () => {
  const fake = new FakeD1();
  env.DB = fake;

  const result = await saveItinerary({
    sessionId: "00000000-0000-4000-8000-000000000222",
    itinerary: itinerary(),
  });

  assert.equal(result.saved, true);
  assert.equal(fake.batchCalls, 1);
  assert.ok(
    fake.batchedStatements.some((statement) =>
      /insert into "itineraries"/i.test(statement.sql),
    ),
  );
  assert.ok(
    fake.batchedStatements.some(
      (statement) =>
        /delete from "itineraries"/i.test(statement.sql) &&
        /not in/i.test(statement.sql) &&
        statement.params.includes(9),
    ),
    "new itinerary batch must replace rows older than the newest nine",
  );
  assert.ok(
    fake.batchedStatements.some((statement) =>
      /delete from "itinerary_nodes"/i.test(statement.sql),
    ),
  );
  assert.equal(
    fake.batchedStatements.filter((statement) =>
      /insert into "itinerary_nodes"/i.test(statement.sql),
    ).length,
    2,
  );
});

test("saveItinerary never persists a declared ephemeral current-origin location", async () => {
  const fake = new FakeD1();
  env.DB = fake;
  const transientItinerary = itinerary();
  transientItinerary.nodes[0].location = {
    latitude: 37.5665,
    longitude: 126.978,
    label: "일회성 현재 위치",
    areaCode: "11",
    sigunguCode: "11110",
  };

  const result = await saveItinerary({
    sessionId: "00000000-0000-4000-8000-000000000222",
    itinerary: transientItinerary,
    ephemeralLocationNodeIds: ["changeable"],
  });

  assert.equal(result.saved, true);
  if (!result.saved) return;
  assert.equal(result.itinerary.nodes[0].location, undefined);
  const nodeInserts = fake.batchedStatements.filter((statement) =>
    /insert into "itinerary_nodes"/i.test(statement.sql),
  );
  assert.equal(nodeInserts.length, 2);
  const transientBinds = JSON.stringify(nodeInserts[0].params);
  assert.doesNotMatch(transientBinds, /37\.5665|126\.978|일회성 현재 위치/);
  const fixedBinds = JSON.stringify(nodeInserts[1].params);
  assert.match(fixedBinds, /37\.57|126\.98|예약 장소/);
});

test("locked nodes cannot be mislabeled as ephemeral", async () => {
  const fake = new FakeD1();
  env.DB = fake;
  const result = await saveItinerary({
    sessionId: "00000000-0000-4000-8000-000000000222",
    itinerary: itinerary(),
    ephemeralLocationNodeIds: ["fixed"],
  });
  assert.deepEqual(result, {
    saved: false,
    reason: "INVALID_EPHEMERAL_LOCATION_NODE",
  });
  assert.equal(fake.batchCalls, 0);
});

test("a D1 batch failure is returned as an unpersisted recovery", async () => {
  const fake = new FakeD1({ failBatch: true });
  env.DB = fake;

  const result = await persistRecovery(recoveryParams());

  assert.deepEqual(result, {
    persisted: false,
    reason: "DB_UNAVAILABLE",
  });
  assert.equal(fake.batchCalls, 1);
});

test("a delayed D1 batch rolls back at the commit deadline", async () => {
  const fake = new FakeD1({
    batchDelayMs: 80,
    enforceCommitDeadline: true,
  });
  env.DB = fake;

  const result = await persistRecovery({
    ...recoveryParams(),
    commitDeadlineAt: Date.now() + 50,
  });

  assert.deepEqual(result, {
    persisted: false,
    reason: "RECOVERY_DEADLINE_EXCEEDED",
  });
  assert.equal(fake.batchCalls, 1);
  assert.equal(fake.committedStatements.length, 0);
  assert.match(
    fake.batchedStatements.at(-1)?.sql ?? "",
    /ELSE NULL/i,
  );
});

test("administrative scope validation requires every stored official district", async () => {
  env.DB = new FakeD1({
    allResults: [
      [
        ["11110", "11"],
        ["26350", "26"],
      ],
    ],
  });
  assert.equal(
    await areKnownAdministrativeScopes([
      { regionCode: "11", districtCode: "11110" },
      { regionCode: "26", districtCode: "26350" },
      { regionCode: "11", districtCode: "11110" },
    ]),
    true,
  );

  env.DB = new FakeD1({
    allResults: [[ ["11110", "11"] ]],
  });
  assert.equal(
    await areKnownAdministrativeScopes([
      { regionCode: "11", districtCode: "11110" },
      { regionCode: "26", districtCode: "26350" },
    ]),
    false,
  );
});

function completeHealthAudits() {
  return REQUIRED_KTO_HEALTH_SOURCES.map((apiName) => ({
    apiName,
    operation: "contractProbe",
    status: "success",
    latencyMs: 10,
    resultCount: 1,
    totalCount: 1,
    fieldsUsed: ["code"],
  }));
}

test("KTO health persistence is one all-or-nothing eight-source batch", async () => {
  const fake = new FakeD1();
  env.DB = fake;
  assert.deepEqual(await persistHealth(completeHealthAudits()), {
    persisted: true,
  });
  assert.equal(fake.batchCalls, 1);
  assert.equal(fake.batchedStatements.length, 8);
  assert.equal(fake.executedStatements.length, 0);
  const checkedAtValues = fake.batchedStatements.map((statement) =>
    statement.params?.find(
      (value) =>
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T/.test(value),
    ),
  );
  assert.equal(new Set(checkedAtValues).size, 1);
});

test("KTO health batch failure cannot leave a partial fresh generation", async () => {
  const fake = new FakeD1({ failBatch: true });
  env.DB = fake;
  assert.deepEqual(await persistHealth(completeHealthAudits()), {
    persisted: false,
    reason: "DB_UNAVAILABLE",
  });
  assert.equal(fake.batchCalls, 1);
  assert.equal(fake.committedStatements.length, 0);

  const incomplete = completeHealthAudits().slice(0, 7);
  const rejected = new FakeD1();
  env.DB = rejected;
  assert.deepEqual(await persistHealth(incomplete), {
    persisted: false,
    reason: "INVALID_HEALTH_SNAPSHOT",
  });
  assert.equal(rejected.batchCalls, 0);
});

async function executionQueryResults() {
  const sessionId = "00000000-0000-4000-8000-000000000222";
  const itineraryId = "00000000-0000-4000-8000-000000000111";
  const runId = "00000000-0000-4000-8000-000000000333";
  const optionId = "recovery-option-000000000001";
  const expiresAt = "2099-08-16T01:30:00.000Z";
  const checkedAt = new Date().toISOString();
  const scheduleDiff = JSON.stringify({
    replacementNode: {
      startAt: "2099-07-16T10:15:00+09:00",
      endAt: "2099-07-16T10:45:00+09:00",
      durationMinutes: 30,
    },
    preservedWaypoints: [
      {
        nodeId: "preserved",
        estimatedArrivalAt: "2099-07-16T11:00:00+09:00",
      },
      {
        nodeId: "fixed",
        estimatedArrivalAt: "2099-07-16T11:50:00+09:00",
      },
    ],
    nextFixedAppointment: {
      nodeId: "fixed",
      title: "다음 예약",
      scheduledAt: "2099-07-16T12:00:00+09:00",
      estimatedArrivalAt: "2099-07-16T11:50:00+09:00",
      arrivalBufferMinutes: 10,
      safetyBufferMinutes: 10,
      status: "preserved",
    },
  });
  const sourceNodes = [
    {
      id: "changeable",
      sequence: 0,
      type: "visit",
      title: "변경할 장소",
      startAt: "2099-07-16T10:00:00+09:00",
      endAt: null,
      durationMinutes: 30,
      locked: false,
      reservation: false,
      location: {
        label: "서울",
        latitude: 37.56,
        longitude: 126.97,
      },
    },
    {
      id: "preserved",
      sequence: 1,
      type: "meal",
      title: "보존 식사",
      startAt: "2099-07-16T11:10:00+09:00",
      endAt: null,
      durationMinutes: 30,
      locked: false,
      reservation: false,
      location: {
        label: "서울 종로구",
        latitude: 37.571,
        longitude: 126.981,
      },
    },
    {
      id: "fixed",
      sequence: 2,
      type: "reservation",
      title: "다음 예약",
      startAt: "2099-07-16T12:00:00+09:00",
      endAt: null,
      durationMinutes: 60,
      locked: true,
      reservation: true,
      location: {
        label: "서울 중구",
        latitude: 37.572,
        longitude: 126.982,
      },
    },
    {
      id: "after",
      sequence: 3,
      type: "visit",
      title: "남은 원래 일정",
      startAt: "2099-07-16T14:00:00+09:00",
      endAt: null,
      durationMinutes: 60,
      locked: false,
      reservation: false,
      location: {
        label: "서울 용산구",
        latitude: 37.53,
        longitude: 126.99,
      },
    },
  ];
  const itineraryImpact = await createItineraryImpactSnapshot({
    itineraryId,
    disruptedNodeId: "changeable",
    nextFixedNodeId: "fixed",
    nodes: sourceNodes,
  });
  assert.ok(itineraryImpact);
  process.env.SESSION_SIGNING_KEY = EXECUTION_SIGNING_KEY;
  const applicationSnapshot = await encryptApplicationSnapshot(
    {
      contentId: "candidate-1",
      title: "공식 대체 장소",
      address: "서울 종로구",
      latitude: 37.57,
      longitude: 126.98,
      generatedAt: checkedAt,
      contractVersion: APPLICATION_SAFETY_CONTRACT_VERSION,
      ruleVersion: RECOVERY_RULE_VERSION,
      recoveryMode: "registered_itinerary",
      availability: { status: "confirmed_open", checkedAt },
      confirmationRequired: false,
      evidenceGapCodes: [],
      visitStartAt: "2099-07-16T10:15:00+09:00",
      visitEndAt: "2099-07-16T10:45:00+09:00",
      nextFixed: {
        nodeId: "fixed",
        scheduledAt: "2099-07-16T12:00:00+09:00",
        estimatedArrivalAt: "2099-07-16T11:50:00+09:00",
        status: "preserved",
      },
      itineraryImpact,
    },
    runId,
    optionId,
  );
  assert.ok(applicationSnapshot);
  const fixture = {
    sessionId,
    itineraryId,
    runId,
    optionId,
    allResults: [
      [],
      [[
        runId,
        itineraryId,
        "changeable",
        "fixed",
        "registered_itinerary",
        "general",
        "verified",
        RECOVERY_RULE_VERSION,
        itineraryImpact.hash,
        checkedAt,
        expiresAt,
      ]],
      [
        [
          optionId,
          "candidate-1",
          "공식 대체 장소",
          "applicable",
          scheduleDiff,
          1,
          applicationSnapshot,
          APPLICATION_SAFETY_CONTRACT_VERSION,
          "confirmed_open",
          checkedAt,
          "2099-07-16T10:15:00+09:00",
          "2099-07-16T10:45:00+09:00",
          0,
          0,
        ],
      ],
      [[itineraryId]],
      [
        [
          "changeable",
          0,
          "visit",
          "변경 전 장소",
          "2099-07-16T10:00:00+09:00",
          null,
          30,
          0,
          0,
          "서울",
          37.56,
          126.97,
          null,
          null,
        ],
        [
          "preserved",
          1,
          "meal",
          "보존 식사",
          "2099-07-16T11:10:00+09:00",
          null,
          30,
          0,
          0,
          "서울 종로구",
          37.571,
          126.981,
          null,
          null,
        ],
        [
          "fixed",
          2,
          "reservation",
          "다음 예약",
          "2099-07-16T12:00:00+09:00",
          null,
          60,
          1,
          1,
          "서울 중구",
          37.572,
          126.982,
          null,
          null,
        ],
        [
          "after",
          3,
          "visit",
          "남은 원래 일정",
          "2099-07-16T14:00:00+09:00",
          null,
          60,
          0,
          0,
          "서울 용산구",
          37.53,
          126.99,
          null,
          null,
        ],
      ],
      [
        [
          "execution-1",
          itineraryId,
          runId,
          optionId,
          "active",
          0,
          2,
          "2026-07-16T01:30:00.000Z",
          "2026-07-16T02:45:00.000Z",
          null,
          null,
          null,
          "2026-07-16T01:30:00.000Z",
          expiresAt,
        ],
      ],
      [
        [
          "execution-1:0",
          0,
          null,
          "replacement",
          "candidate-1",
          "공식 대체 장소",
          "visit",
          "2099-07-16T10:15:00+09:00",
          null,
          30,
          "서울 종로구",
          37.57,
          126.98,
          0,
          0,
          "continuity_verified",
          "current",
          null,
        ],
        [
          "execution-1:1",
          1,
          "preserved",
          "preserved",
          null,
          "보존 식사",
          "meal",
          "2099-07-16T11:10:00+09:00",
          "2099-07-16T11:00:00+09:00",
          30,
          "서울 종로구",
          37.571,
          126.981,
          0,
          0,
          "continuity_verified",
          "pending",
          null,
        ],
        [
          "execution-1:2",
          2,
          "fixed",
          "next_fixed",
          null,
          "다음 예약",
          "reservation",
          "2099-07-16T12:00:00+09:00",
          "2099-07-16T11:50:00+09:00",
          60,
          "서울 중구",
          37.572,
          126.982,
          1,
          1,
          "continuity_verified",
          "pending",
          null,
        ],
        [
          "execution-1:3",
          3,
          "after",
          "remaining_original",
          null,
          "남은 원래 일정",
          "visit",
          "2099-07-16T14:00:00+09:00",
          null,
          60,
          "서울 용산구",
          37.53,
          126.99,
          0,
          0,
          "resumed_original",
          "pending",
          null,
        ],
      ],
    ],
  };
  fixture.allResults[4] = sourceNodes.map((node) => [
    node.id,
    node.sequence,
    node.type,
    node.title,
    node.startAt,
    node.endAt,
    node.durationMinutes,
    Number(node.locked),
    Number(node.reservation),
    node.location?.label ?? null,
    node.location?.latitude ?? null,
    node.location?.longitude ?? null,
    node.location?.areaCode ?? null,
    node.location?.sigunguCode ?? null,
  ]);
  return fixture;
}

async function withOfficialKtoDetail(run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  process.env.KTO_SERVICE_KEY = "execution-test-key";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: {
          header: { resultCode: "0000", resultMsg: "OK" },
          body: {
            items: {
              item: [
                {
                  contentid: "candidate-1",
                  title: "공식 대체 장소",
                  addr1: "서울 종로구",
                  mapy: "37.57",
                  mapx: "126.98",
                },
              ],
            },
            totalCount: 1,
            pageNo: 1,
            numOfRows: 1,
          },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = originalKey;
  }
}

test("applying a recovery atomically creates an executable X-B-C-D journey", async () => {
  const fixture = await executionQueryResults();
  const rowImpact = await createItineraryImpactSnapshot({
    itineraryId: fixture.itineraryId,
    disruptedNodeId: "changeable",
    nextFixedNodeId: "fixed",
    nodes: fixture.allResults[4].map((row) => ({
      id: row[0],
      sequence: row[1],
      type: row[2],
      title: row[3],
      startAt: row[4] ?? undefined,
      endAt: row[5] ?? undefined,
      durationMinutes: row[6] ?? undefined,
      locked: Boolean(row[7]),
      reservation: Boolean(row[8]),
      location: row[9]
        ? {
            label: row[9],
            latitude: row[10],
            longitude: row[11],
            areaCode: row[12] ?? undefined,
            sigunguCode: row[13] ?? undefined,
          }
        : undefined,
    })),
  });
  assert.equal(rowImpact?.hash, fixture.allResults[1][0][8]);
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await withOfficialKtoDetail(() =>
    activateRecoveryExecution({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      optionId: fixture.optionId,
    }),
  );

  assert.equal(result.activated, true);
  if (!result.activated) return;
  assert.deepEqual(
    result.execution.steps.map((step) => step.role),
    ["replacement", "preserved", "next_fixed", "remaining_original"],
  );
  const fixedStep = result.execution.steps.find(
    (step) => step.role === "next_fixed",
  );
  assert.equal(
    fixedStep?.scheduledAt,
    "2099-07-16T12:00:00+09:00",
    "예상 도착시각이 원래 잠금 예약시각을 덮어쓰면 안 된다",
  );
  assert.equal(fixedStep?.estimatedArrivalAt, "2099-07-16T11:50:00+09:00");
  assert.equal(fixedStep?.locked, true);
  assert.equal(fixedStep?.reservation, true);
  assert.equal(fixedStep?.locationLabel, "서울 중구");
  assert.equal(fixedStep?.latitude, 37.572);
  assert.equal(fixedStep?.longitude, 126.982);
  assert.equal(fake.batchCalls, 1);
  assert.ok(
    fake.batchedStatements.some((statement) =>
      /insert into "journey_executions"/i.test(statement.sql),
    ),
  );
  assert.equal(
    fake.batchedStatements.filter((statement) =>
      /insert into "journey_execution_steps"/i.test(statement.sql),
    ).length,
    4,
  );
  const stepBinds = fake.batchedStatements
    .filter((statement) =>
      /insert into "journey_execution_steps"/i.test(statement.sql),
    )
    .map((statement) => JSON.stringify(statement.params));
  assert.match(stepBinds[0], /공식 대체 장소/);
  assert.match(stepBinds[1], /보존 식사/);
  assert.match(stepBinds[2], /다음 예약/);
  assert.match(stepBinds[3], /남은 원래 일정/);
  assert.ok(
    fake.batchedStatements.some((statement) =>
      /insert into "recovery_outcomes"/i.test(statement.sql),
    ),
  );
});

test("execution activation rejects a recommendation whose locked appointment proof drifted", async () => {
  const fixture = await executionQueryResults();
  const scheduleDiff = JSON.parse(fixture.allResults[2][0][4]);
  scheduleDiff.nextFixedAppointment.scheduledAt =
    scheduleDiff.nextFixedAppointment.estimatedArrivalAt;
  fixture.allResults[2][0][4] = JSON.stringify(scheduleDiff);
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await withOfficialKtoDetail(() =>
    activateRecoveryExecution({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      optionId: fixture.optionId,
    }),
  );

  assert.deepEqual(result, {
    activated: false,
    reason: "INVALID_STATE",
  });
  assert.equal(fake.batchCalls, 0);
});

test("execution activation rejects drift in every impacted waypoint before writing", async () => {
  const fixture = await executionQueryResults();
  fixture.allResults[4][1][3] = "추천 이후 수정된 중간 일정";
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await activateRecoveryExecution({
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    optionId: fixture.optionId,
  });

  assert.deepEqual(result, { activated: false, reason: "INVALID_STATE" });
  assert.equal(fake.batchCalls, 0);
});

test("execution activation rejects unsafe option columns even with a valid encrypted snapshot", async () => {
  for (const [columnIndex, unsafeValue] of [
    [3, "applied"],
    [8, "unknown"],
    [12, 1],
    [13, 1],
  ]) {
    const fixture = await executionQueryResults();
    fixture.allResults[2][0][columnIndex] = unsafeValue;
    const fake = new FakeD1({ allResults: fixture.allResults });
    env.DB = fake;
    const result = await activateRecoveryExecution({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      optionId: fixture.optionId,
    });
    assert.deepEqual(result, { activated: false, reason: "INVALID_STATE" });
    assert.equal(fake.batchCalls, 0);
  }
});

test("execution activation batch failure leaves the application uncommitted", async () => {
  const fixture = await executionQueryResults();
  const fake = new FakeD1({
    allResults: fixture.allResults,
    failBatch: true,
  });
  env.DB = fake;

  const result = await withOfficialKtoDetail(() =>
    activateRecoveryExecution({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      optionId: fixture.optionId,
    }),
  );

  assert.deepEqual(result, {
    activated: false,
    reason: "DB_UNAVAILABLE",
  });
  assert.equal(fake.batchCalls, 1);
});

test("execution activation uses the encrypted verified snapshot without a second KTO dependency", async () => {
  const previousSigningKey = process.env.SESSION_SIGNING_KEY;
  process.env.SESSION_SIGNING_KEY =
    "m7Q2vK9xD4pL8rT1wN6cF3hJ0sA5uE2zB7gY4kM";
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("upstream must not be called");
  };
  try {
    const { encryptApplicationSnapshot } = await import(
      "../lib/recovery/application-snapshot.ts"
    );
    const fixture = await executionQueryResults();
    fixture.allResults[2][0][5] =
      await encryptApplicationSnapshot(
        {
          contentId: "candidate-1",
          title: "공식 대체 장소",
          address: "서울 종로구",
          latitude: 37.57,
          longitude: 126.98,
          generatedAt: "2026-07-16T01:30:00.000Z",
        },
        fixture.runId,
        fixture.optionId,
      );
    const fake = new FakeD1({ allResults: fixture.allResults });
    env.DB = fake;

    const result = await activateRecoveryExecution({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      optionId: fixture.optionId,
    });

    assert.equal(result.activated, true);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSigningKey === undefined) {
      delete process.env.SESSION_SIGNING_KEY;
    } else {
      process.env.SESSION_SIGNING_KEY = previousSigningKey;
    }
  }
});

test("execution activation rejects a missing legacy safety contract without an upstream bypass", async () => {
  const fixture = await executionQueryResults();
  fixture.allResults[2][0][6] = null;
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KTO_SERVICE_KEY;
  process.env.KTO_SERVICE_KEY = "execution-test-key";
  globalThis.fetch = async () => {
    throw new Error("KTO unavailable");
  };
  try {
    const result = await activateRecoveryExecution({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      optionId: fixture.optionId,
    });
    assert.deepEqual(result, {
      activated: false,
      reason: "INVALID_STATE",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = originalKey;
  }
});

test("execution activation rejects original waypoints outside Korea bounds", async () => {
  const fixture = await executionQueryResults();
  fixture.allResults[4][1][10] = 0;
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await withOfficialKtoDetail(() =>
    activateRecoveryExecution({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      optionId: fixture.optionId,
    }),
  );

  assert.deepEqual(result, {
    activated: false,
    reason: "INVALID_STATE",
  });
  assert.equal(fake.batchCalls, 0);
});

test("execution activation never bypasses a corrupt encrypted snapshot", async () => {
  const fixture = await executionQueryResults();
  fixture.allResults[2][0][6] = JSON.stringify({
    version: 1,
    iv: "tampered",
    ciphertext: "tampered",
  });
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await activateRecoveryExecution({
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    optionId: fixture.optionId,
  });

  assert.deepEqual(result, {
    activated: false,
    reason: "INVALID_STATE",
  });
  assert.equal(fake.batchCalls, 0);
});

function journeyActionResults({
  role = "next_fixed",
  scheduledAt,
  resultingStatus,
  initialStatus = "active",
  initialContractMetAt = null,
  initialContractMissedAt = null,
  contractMetAt = null,
  contractMissedAt = null,
  resultingCompletedAt =
    resultingStatus === "completed" || resultingStatus === "contract_missed"
      ? "2026-08-11T01:10:00.000Z"
      : null,
  finalStepStatus = "arrived",
}) {
  const sessionId = "00000000-0000-4000-8000-000000000222";
  const expiresAt = "2099-08-16T01:30:00.000Z";
  const header = (status, metAt, missedAt, completedAt) => [[
    "execution-action-1",
    "00000000-0000-4000-8000-000000000111",
    "00000000-0000-4000-8000-000000000333",
    "recovery-option-000000000001",
    status,
    0,
    0,
    "2026-08-11T01:00:00.000Z",
    "2026-08-11T01:05:00.000Z",
    metAt,
    missedAt,
    completedAt,
    "2026-08-11T01:00:00.000Z",
    expiresAt,
  ]];
  const steps = (status, arrivedAt = null) => [[
    "execution-action-1:0",
    0,
    role === "next_fixed" ? "fixed" : null,
    role,
    role === "replacement" ? "candidate-1" : null,
    role === "replacement" ? "검증 장소" : "다음 예약",
    role === "replacement" ? "visit" : "reservation",
    scheduledAt,
    null,
    20,
    "서울",
    37.57,
    126.98,
    Number(role === "next_fixed"),
    Number(role === "next_fixed"),
    "continuity_verified",
    status,
    arrivedAt,
  ]];
  return {
    sessionId,
    allResults: [
      header(
        initialStatus,
        initialContractMetAt,
        initialContractMissedAt,
        null,
      ),
      steps("current"),
      header(
        resultingStatus,
        contractMetAt,
        contractMissedAt,
        resultingCompletedAt,
      ),
      steps(
        finalStepStatus,
        finalStepStatus === "arrived"
          ? "2026-08-11T01:10:00.000Z"
          : null,
      ),
    ],
  };
}

test("late next-fixed arrival atomically records an explicit contract_missed truth", async () => {
  const fixture = journeyActionResults({
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    resultingStatus: "contract_missed",
    contractMissedAt: "2026-08-11T01:10:00.000Z",
  });
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await updateActiveJourneyExecution({
    sessionId: fixture.sessionId,
    action: { action: "arrive", stepId: "execution-action-1:0" },
  });

  assert.equal(result.updated, true);
  if (!result.updated) return;
  assert.equal(result.execution.status, "contract_missed");
  assert.equal(result.execution.contractMetAt, undefined);
  assert.equal(
    result.execution.contractMissedAt,
    "2026-08-11T01:10:00.000Z",
  );
  assert.match(fake.batchedStatements[0].sql, /case[\s\S]+status[\s\S]+active_session_key[\s\S]+expires_at/i);
  assert.match(fake.batchedStatements[1].sql, /case[\s\S]+current/i);
  const executionUpdate = fake.batchedStatements.find((statement) =>
    /update "journey_executions"/i.test(statement.sql) &&
    statement.params.includes("contract_missed"),
  );
  assert.ok(executionUpdate);
  const outcome = fake.batchedStatements.find((statement) =>
    /insert into "recovery_outcomes"/i.test(statement.sql),
  );
  assert.ok(outcome);
  assert.ok(outcome.params.includes(0));
});

test("open-window synthetic replacement completion is never classified as a missed booking", async () => {
  const fixture = journeyActionResults({
    role: "replacement",
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    resultingStatus: "completed",
    contractMetAt: null,
    contractMissedAt: null,
  });
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await updateActiveJourneyExecution({
    sessionId: fixture.sessionId,
    action: { action: "arrive", stepId: "execution-action-1:0" },
  });

  assert.equal(result.updated, true);
  if (!result.updated) return;
  assert.equal(result.execution.status, "completed");
  assert.equal(result.execution.contractMissedAt, undefined);
  assert.equal(
    fake.batchedStatements.some((statement) =>
      /insert into "recovery_outcomes"/i.test(statement.sql),
    ),
    false,
  );
});

test("abandon after a contract miss preserves contract truth without claiming completion", async () => {
  const missedAt = "2026-08-11T01:09:00.000Z";
  const fixture = journeyActionResults({
    role: "remaining_original",
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    initialStatus: "contract_missed",
    initialContractMissedAt: missedAt,
    resultingStatus: "abandoned",
    contractMissedAt: missedAt,
    resultingCompletedAt: null,
    finalStepStatus: "skipped",
  });
  const fake = new FakeD1({ allResults: fixture.allResults });
  env.DB = fake;

  const result = await updateActiveJourneyExecution({
    sessionId: fixture.sessionId,
    action: { action: "abandon", reasonCode: "USER_ABANDONED" },
  });

  assert.equal(result.updated, true);
  if (!result.updated) return;
  assert.equal(result.execution.status, "abandoned");
  assert.equal(result.execution.contractMissedAt, missedAt);
  assert.equal(result.execution.contractMetAt, undefined);
  assert.equal(result.execution.completedAt, undefined);
  const outcome = fake.batchedStatements.find((statement) =>
    /insert into "recovery_outcomes"/i.test(statement.sql),
  );
  assert.ok(outcome);
  assert.ok(
    outcome.params.some(
      (value) =>
        typeof value === "string" && value.endsWith(":abandoned"),
    ),
  );
  assert.ok(
    outcome.params.some(
      (value) =>
        typeof value === "string" && value.includes("contract_missed"),
    ),
  );
});

test("A to B to A reapply cannot revive a superseded execution", async () => {
  const fake = new FakeD1({
    allResults: [[[
      "execution-a",
      "superseded",
      null,
      "2099-08-16T01:30:00.000Z",
    ]]],
  });
  env.DB = fake;

  const result = await activateRecoveryExecution({
    sessionId: "00000000-0000-4000-8000-000000000222",
    runId: "00000000-0000-4000-8000-000000000333",
    optionId: "recovery-option-000000000001",
  });

  assert.deepEqual(result, { activated: false, reason: "INVALID_STATE" });
  assert.equal(fake.batchCalls, 0);
});

test("generic outcome repository accepts selection telemetry only", async () => {
  const fake = new FakeD1();
  env.DB = fake;

  const result = await recordRecoveryOutcome({
    sessionId: "00000000-0000-4000-8000-000000000222",
    runId: "00000000-0000-4000-8000-000000000333",
    outcome: {
      optionId: "recovery-option-000000000001",
      event: "arrived",
    },
  });

  assert.deepEqual(result, { recorded: false, reason: "INVALID_STATE" });
  assert.equal(fake.executedStatements.length, 0);
  assert.equal(fake.batchCalls, 0);
});

test("recovery persistence fails closed when no stable snapshot key exists", async () => {
  const previousSession = process.env.SESSION_SIGNING_KEY;
  const previousOps = process.env.OPS_API_KEY;
  delete process.env.SESSION_SIGNING_KEY;
  delete process.env.OPS_API_KEY;
  const fake = new FakeD1();
  env.DB = fake;
  try {
    const result = await persistRecovery(
      recoveryParamsWithRawRouteGeometry(),
    );
    assert.deepEqual(result, {
      persisted: false,
      reason: "APPLICATION_SNAPSHOT_UNAVAILABLE",
    });
    assert.equal(fake.batchCalls, 0);
  } finally {
    if (previousSession === undefined) delete process.env.SESSION_SIGNING_KEY;
    else process.env.SESSION_SIGNING_KEY = previousSession;
    if (previousOps === undefined) delete process.env.OPS_API_KEY;
    else process.env.OPS_API_KEY = previousOps;
  }
});

test("recovery persistence strips exact route and location coordinates from D1 bind values", async () => {
  const previousSigningKey = process.env.SESSION_SIGNING_KEY;
  process.env.SESSION_SIGNING_KEY =
    "R5nC1xV8mQ3pT7kD2wL9hF4sJ0aE6uB1zG5yK8dP";
  const fake = new FakeD1();
  env.DB = fake;
  try {
    const result = await persistRecovery(
      recoveryParamsWithRawRouteGeometry(),
    );

    assert.deepEqual(result, { persisted: true });
    const serializedBinds = JSON.stringify(
      fake.batchedStatements.flatMap(
        (statement) => statement.params ?? [],
      ),
    );
    assert.match(serializedBinds, /distanceMeters/);
    for (const forbidden of [
      "geometry",
      "routeGeometry",
      "coordinates",
      "latitude",
      "longitude",
      "37.56789",
      "126.98123",
    ]) {
      assert.doesNotMatch(serializedBinds, new RegExp(forbidden, "i"));
    }
  } finally {
    if (previousSigningKey === undefined) {
      delete process.env.SESSION_SIGNING_KEY;
    } else {
      process.env.SESSION_SIGNING_KEY = previousSigningKey;
    }
  }
});

test("new proof shares re-sanitize stored legacy evidence before public serialization", async () => {
  const unsafeContinuityProof =
    recoveryParamsWithRawRouteGeometry().result.options[0]
      .continuityProof;
  const unsafeScheduleDiff =
    recoveryParamsWithRawRouteGeometry().result.options[0].scheduleDiff;
  const fake = new FakeD1({
    allResults: [
      [
        [
          "00000000-0000-4000-8000-000000000333",
          "delay",
          "general",
          "11",
          "11110",
          "verified",
          "registered_itinerary",
          "changeable",
          "fixed",
          "test-v1",
          "2026-07-16T01:30:00.000Z",
          JSON.stringify({
            reason: "legacy",
            geometry: [[126.978, 37.5665]],
          }),
          "privacy-option-000000000001",
          1,
          "candidate-privacy-1",
          "좌표 비저장 검증 장소",
          "14",
          92,
          "500-999m",
          "10-19m",
          "not_required",
          "unavailable",
          JSON.stringify(["KorService2"]),
          JSON.stringify(unsafeScheduleDiff),
          JSON.stringify(
            unsafeContinuityProof,
          ),
        ],
      ],
      [],
    ],
  });
  env.DB = fake;

  const result = await createProofShare({
    sessionId: "00000000-0000-4000-8000-000000000222",
    runId: "00000000-0000-4000-8000-000000000333",
    optionId: "privacy-option-000000000001",
  });

  assert.deepEqual(result, {
    created: false,
    reason: "INVALID_STATE",
  });
  if (!result.created) return;
  const serializedProof = JSON.stringify(result.proof);
  assert.match(serializedProof, /distanceMeters/);
  for (const forbidden of [
    "geometry",
    "routeGeometry",
    "coordinates",
    "latitude",
    "longitude",
    "37.56789",
    "126.98123",
  ]) {
    assert.doesNotMatch(serializedProof, new RegExp(forbidden, "i"));
  }
  const persistedShare = JSON.stringify(fake.executedStatements);
  for (const forbidden of [
    "geometry",
    "routeGeometry",
    "coordinates",
    "latitude",
    "longitude",
    "37.56789",
    "126.98123",
  ]) {
    assert.doesNotMatch(persistedShare, new RegExp(forbidden, "i"));
  }
});

test("proof sharing requires a current protected contract and exposes self-report provenance", async () => {
  process.env.SESSION_SIGNING_KEY = EXECUTION_SIGNING_KEY;
  const nowMs = Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const visitStartAt = new Date(nowMs + 10 * 60_000).toISOString();
  const visitEndAt = new Date(nowMs + 30 * 60_000).toISOString();
  const windowStartAt = new Date(nowMs - 10_000).toISOString();
  const windowEndAt = new Date(nowMs + 60 * 60_000).toISOString();
  const runId = "00000000-0000-4000-8000-000000000333";
  const optionId = "open-window-option-000000001";
  const scheduleDiff = {
    replacementNode: {
      startAt: visitStartAt,
      endAt: visitEndAt,
      durationMinutes: 20,
    },
    openWindow: {
      windowStartAt,
      windowEndAt,
      status: "fits",
      returnMinutes: 10,
      returnBasis: "origin_return_route",
      returnProvider: "openstreetmap_osrm",
      returnDistanceMeters: 700,
      returnCalculatedAt: checkedAt,
      requiredBufferMinutes: 15,
      leftoverMinutes: 20,
    },
  };
  const snapshot = await encryptApplicationSnapshot(
    {
      contentId: "open-place-1",
      title: "검증 장소",
      address: "서울",
      latitude: 37.57,
      longitude: 126.98,
      generatedAt: checkedAt,
      contractVersion: APPLICATION_SAFETY_CONTRACT_VERSION,
      ruleVersion: RECOVERY_RULE_VERSION,
      recoveryMode: "open_window",
      availability: { status: "confirmed_open", checkedAt },
      confirmationRequired: false,
      evidenceGapCodes: [],
      visitStartAt,
      visitEndAt,
      openWindow: scheduleDiff.openWindow,
    },
    runId,
    optionId,
  );
  assert.ok(snapshot);
  const fake = new FakeD1({
    allResults: [
      [[
        runId,
        "delay",
        "general",
        "11",
        "11110",
        "verified",
        "open_window",
        null,
        null,
        null,
        RECOVERY_RULE_VERSION,
        null,
        checkedAt,
        new Date(nowMs + 24 * 60 * 60_000).toISOString(),
        null,
        optionId,
        1,
        "open-place-1",
        "검증 장소",
        "12",
        90,
        "500-999m",
        "10-19m",
        "not_required",
        "unavailable",
        JSON.stringify(["KorService2"]),
        JSON.stringify(scheduleDiff),
        JSON.stringify({
          availabilityEvidence: {
            status: "confirmed_open",
            checkedAt,
          },
        }),
        "applicable",
        snapshot,
        APPLICATION_SAFETY_CONTRACT_VERSION,
        "confirmed_open",
        checkedAt,
        visitStartAt,
        visitEndAt,
        0,
        0,
      ]],
      [[
        "arrived",
        checkedAt,
        checkedAt,
        0,
        JSON.stringify({ arrivalEvidence: "self_reported" }),
      ]],
    ],
  });
  env.DB = fake;

  const result = await createProofShare({
    sessionId: "00000000-0000-4000-8000-000000000222",
    runId,
    optionId,
  });

  assert.equal(result.created, true);
  if (!result.created) return;
  assert.equal(result.proof.shareExpiresAt, result.expiresAt);
  assert.equal(result.proof.proofKind, "actionable_recovery");
  assert.equal(result.proof.actionability, "current_at_share");
  assert.equal(result.proof.execution, null);
  assert.deepEqual(result.proof.outcomes, [
    {
      event: "arrived",
      occurredAt: checkedAt,
      actualArrivalAt: checkedAt,
      arrivedOnTime: false,
      evidenceKind: "traveler_self_report",
      verificationLevel: "self_reported_unverified",
    },
  ]);
  assert.equal(fake.executedStatements.length, 1);
});

test("proof read and revoke distinguish D1 outages from missing links", async () => {
  env.DB = {
    prepare() {
      throw new Error("D1_UNAVAILABLE");
    },
  };

  assert.deepEqual(await getProofShare("a".repeat(48)), {
    found: false,
    reason: "DB_UNAVAILABLE",
  });
  assert.deepEqual(
    await revokeProofShare({
      token: "b".repeat(48),
      sessionId: "00000000-0000-4000-8000-000000000222",
    }),
    { revoked: false, reason: "DB_UNAVAILABLE" },
  );

  const route = await source("app/api/v1/share/[token]/route.ts");
  assert.match(route, /result\.reason === "DB_UNAVAILABLE"[\s\S]+503/);
});

test("privacy migration removes legacy shares and raw route evidence", async () => {
  const [migration, journal] = await Promise.all([
    source("drizzle/0004_privacy_redact_recovery_evidence.sql"),
    source("drizzle/meta/_journal.json"),
  ]);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE proof_shares (
        id TEXT PRIMARY KEY,
        proof_json TEXT NOT NULL
      );
      CREATE TABLE recovery_options (
        id TEXT PRIMARY KEY,
        route_evidence_json TEXT,
        continuity_proof_json TEXT
      );
      CREATE TABLE recovery_runs (
        id TEXT PRIMARY KEY,
        decision_proof_json TEXT
      );
    `);
    const rawEvidence = JSON.stringify({
      routeEvidence: {
        geometry: [
          { latitude: 37.56789, longitude: 126.98123 },
        ],
      },
    });
    db.prepare(
      "INSERT INTO proof_shares (id, proof_json) VALUES (?, ?)",
    ).run("share-1", rawEvidence);
    db.prepare(
      "INSERT INTO recovery_options (id, route_evidence_json, continuity_proof_json) VALUES (?, ?, ?)",
    ).run("option-1", rawEvidence, rawEvidence);
    db.prepare(
      "INSERT INTO recovery_runs (id, decision_proof_json) VALUES (?, ?)",
    ).run("run-1", rawEvidence);

    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM proof_shares").get()
        .count,
      0,
    );
    const option = db
      .prepare(
        "SELECT route_evidence_json, continuity_proof_json FROM recovery_options WHERE id = ?",
      )
      .get("option-1");
    const run = db
      .prepare(
        "SELECT decision_proof_json FROM recovery_runs WHERE id = ?",
      )
      .get("run-1");
    const redacted = JSON.stringify({ option, run });
    assert.match(redacted, /privacy_redacted/);
    assert.doesNotMatch(
      redacted,
      /geometry|latitude|longitude|37\.56789|126\.98123/i,
    );
    assert.match(
      journal,
      /0004_privacy_redact_recovery_evidence/,
    );
  } finally {
    db.close();
  }
});

test("cookie-backed mutations require exact same-origin JSON requests", async () => {
  const request = (headers, method = "POST") =>
    new NextRequest("https://ieoga.example/api/v1/recover", {
      method,
      headers,
    });

  assert.equal(
    requireSameOriginJsonMutation(
      request({
        origin: "https://ieoga.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json; charset=utf-8",
      }),
    ),
    null,
  );
  assert.equal(
    requireSameOriginJsonMutation(
      request({
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      }),
    )?.status,
    403,
  );
  assert.equal(
    requireSameOriginJsonMutation(
      request({
        origin: "https://ieoga.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      }),
    )?.status,
    403,
  );
  assert.equal(
    requireSameOriginJsonMutation(
      request({
        origin: "https://ieoga.example",
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
      }),
    )?.status,
    415,
  );
  assert.equal(
    requireSameOriginJsonMutation(
      request(
        {
          origin: "https://ieoga.example",
          "sec-fetch-site": "same-origin",
        },
        "DELETE",
      ),
      { requireJson: false },
    ),
    null,
  );
});

test("every first-party cookie mutation route invokes the common CSRF guard", async () => {
  const guardedRoutes = [
    "app/api/v1/itineraries/route.ts",
    "app/api/v1/recover/route.ts",
    "app/api/v1/recover/[runId]/apply/route.ts",
    "app/api/v1/recover/[runId]/outcome/route.ts",
    "app/api/v1/share/route.ts",
    "app/api/v1/share/[token]/route.ts",
    "app/api/v1/journey/active/route.ts",
    "app/api/v1/privacy/session/route.ts",
  ];
  for (const route of guardedRoutes) {
    assert.match(
      await source(route),
      /requireSameOriginJsonMutation\(request/,
      route,
    );
  }
  assert.doesNotMatch(
    await source("app/api/v1/partner/recover/route.ts"),
    /requireSameOriginJsonMutation/,
  );
});

test("recover API and UI expose persistence as an action gate", async () => {
  const [route, product] = await Promise.all([
    source("app/api/v1/recover/route.ts"),
    source("app/ProductApp.tsx"),
  ]);

  assert.match(route, /RECOVERY_PERSISTENCE_FAILED/);
  assert.match(
    route,
    /persistence:\s*\{\s*status:\s*"failed"[\s\S]{0,400}status:\s*503/,
  );
  assert.match(
    route,
    /persistence:\s*\{\s*status:\s*"persisted",\s*runId:\s*result\.requestId/,
  );
  assert.match(route, /X-Recovery-Persisted",\s*"false"/);
  assert.match(route, /X-Recovery-Persisted[\s\S]{0,100}"unknown"/);
  assert.match(route, /X-Recovery-Persisted",\s*"true"/);
  assert.doesNotMatch(route, /result\.warnings\.push/);

  assert.match(product, /const recoveryPersisted\s*=/);
  assert.match(
    product,
    /recovery\?\.persistence\.status === "persisted"/,
  );
  assert.match(product, /disabled=\{[\s\S]{0,160}!recoveryPersisted/);
  assert.match(
    product,
    /!recoveryPersisted \|\|\s*!recovery\.requestId/,
  );
});
