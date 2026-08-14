import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

function openWindowRequest(server, extra = {}) {
  const base = {
    origin: {
      latitude: 37.5665,
      longitude: 126.978,
      label: "서울광장",
    },
    incident: "delay",
    availableMinutes: 180,
    audience: "general",
    travelMode: "walk",
    openWindow: {
      availableUntil: new Date(server.getTime() + 4 * 60 * 60_000).toISOString(),
      plannedStayMinutes: 60,
    },
  };
  return {
    ...base,
    ...extra,
    openWindow: {
      ...base.openWindow,
      ...(extra.openWindow ?? {}),
    },
  };
}

test("current 기준은 클라이언트 시계가 아니라 서버 수신 시각으로 고정한다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const { resolveRecoveryReferenceTime } = await import(
    "../lib/recovery/reference-time.ts"
  );
  const server = new Date();
  const parsed = recoveryRequestSchema.parse(
    openWindowRequest(server, {
      referenceTime: { mode: "current" },
      availableMinutes: 180,
      openWindow: {
        availableUntil: new Date(
          server.getTime() + 180 * 60_000,
        ).toISOString(),
      },
    }),
  );
  const result = resolveRecoveryReferenceTime(parsed, server);
  assert.equal(result.success, true);
  assert.deepEqual(result.referenceTime, {
    mode: "current",
    at: server.toISOString(),
  });
  assert.equal(result.input.openWindow.departureAt, server.toISOString());
  assert.equal(
    Date.parse(result.input.openWindow.availableUntil) -
      Date.parse(result.input.openWindow.departureAt),
    180 * 60_000,
    "클라이언트와 서버의 밀리초 차이로 180분이 179분이 되면 안 된다",
  );
});

test("현재 시각 보정은 같은 다음 장소 시각만 옮기고 더 늦은 약속은 보존한다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const { resolveRecoveryReferenceTime } = await import(
    "../lib/recovery/reference-time.ts"
  );
  const server = new Date();
  const end = new Date(server.getTime() + 120 * 60_000).toISOString();
  const later = new Date(server.getTime() + 150 * 60_000).toISOString();
  const nextPlace = {
    latitude: 37.57,
    longitude: 126.99,
    label: "다음 약속",
  };
  const resolve = (arriveBy) =>
    resolveRecoveryReferenceTime(
      recoveryRequestSchema.parse(
        openWindowRequest(server, {
          referenceTime: { mode: "current" },
          availableMinutes: 120,
          openWindow: {
            availableUntil: end,
            plannedStayMinutes: 60,
            nextPlace: { ...nextPlace, arriveBy },
          },
        }),
      ),
      server,
    );
  const matching = resolve(end);
  assert.equal(matching.success, true);
  assert.equal(matching.input.openWindow.nextPlace.arriveBy, end);
  const preserved = resolve(later);
  assert.equal(preserved.success, true);
  assert.equal(preserved.input.openWindow.nextPlace.arriveBy, later);
});

test("미래 가정 시각은 경로·창의 공통 출발 시각이 된다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const { resolveRecoveryReferenceTime } = await import(
    "../lib/recovery/reference-time.ts"
  );
  const server = new Date();
  const at = new Date(server.getTime() + 2 * 60 * 60_000).toISOString();
  const parsed = recoveryRequestSchema.parse(
    openWindowRequest(server, {
      referenceTime: { mode: "assumed", at },
      availableMinutes: 120,
      openWindow: {
        availableUntil: new Date(
          Date.parse(at) + 120 * 60_000,
        ).toISOString(),
      },
    }),
  );
  const result = resolveRecoveryReferenceTime(parsed, server);
  assert.equal(result.success, true);
  assert.deepEqual(result.referenceTime, { mode: "assumed", at });
  assert.equal(result.input.openWindow.departureAt, at);
});

test("과거와 경로별 시각 충돌은 fail-closed 하고, 먼 미래는 통과시킨다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const { resolveRecoveryReferenceTime } = await import(
    "../lib/recovery/reference-time.ts"
  );
  const server = new Date();
  const resolveAt = (at, departureAt) => {
    const parsed = recoveryRequestSchema.parse(
      openWindowRequest(server, {
        referenceTime: { mode: "assumed", at },
        ...(departureAt
          ? {
              openWindow: {
                availableUntil: new Date(
                  server.getTime() + 4 * 60 * 60_000,
                ).toISOString(),
                plannedStayMinutes: 60,
                departureAt,
              },
            }
          : {}),
      }),
    );
    return resolveRecoveryReferenceTime(parsed, server);
  };

  const past = resolveAt(
    new Date(server.getTime() - 2 * 60_000).toISOString(),
  );
  assert.equal(past.success, false);
  assert.equal(past.error.code, "REFERENCE_TIME_IN_PAST");

  /* 6시간 상한은 없앴다. 서버도 먼 미래를 거절하지 않는다 — 도착 시각이
     운영시간 안인지가 판정을 가르고, 그 원천은 시각과 무관하게 유효하다.
     자유 시간의 끝은 그 가정 시각에서 다시 재야 하므로 함께 옮겨 보낸다. */
  const nextWeekAt = new Date(
    server.getTime() + 7 * 24 * 60 * 60_000,
  ).toISOString();
  const farFuture = resolveRecoveryReferenceTime(
    recoveryRequestSchema.parse(
      openWindowRequest(server, {
        referenceTime: { mode: "assumed", at: nextWeekAt },
        availableMinutes: 180,
        openWindow: {
          departureAt: nextWeekAt,
          availableUntil: new Date(
            Date.parse(nextWeekAt) + 180 * 60_000,
          ).toISOString(),
          plannedStayMinutes: 60,
        },
      }),
    ),
    server,
  );
  assert.equal(farFuture.success, true, "다음 주 조회를 서버가 막았다");
  assert.equal(farFuture.referenceTime.at, nextWeekAt);

  const at = new Date(server.getTime() + 2 * 60 * 60_000).toISOString();
  const conflict = resolveAt(
    at,
    new Date(server.getTime() + 90 * 60_000).toISOString(),
  );
  assert.equal(conflict.success, false);
  assert.equal(conflict.error.code, "REFERENCE_TIME_CONFLICT");
});

test("가정 시각과 자유 시간 길이가 충돌하면 종료 시각을 임의로 고치지 않는다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const { resolveRecoveryReferenceTime } = await import(
    "../lib/recovery/reference-time.ts"
  );
  const server = new Date();
  const at = new Date(server.getTime() + 60 * 60_000).toISOString();
  const parsed = recoveryRequestSchema.parse(
    openWindowRequest(server, {
      referenceTime: { mode: "assumed", at },
      availableMinutes: 120,
      openWindow: {
        departureAt: at,
        /* declared 120 minutes, but this absolute end says 180 minutes */
        availableUntil: new Date(
          Date.parse(at) + 180 * 60_000,
        ).toISOString(),
        plannedStayMinutes: 60,
      },
    }),
  );
  const result = resolveRecoveryReferenceTime(parsed, server);
  assert.equal(result.success, false);
  assert.equal(result.error.code, "REFERENCE_TIME_CONFLICT");
});

test("가정 시각이 다음 고정 약속을 넘으면 일정 잠금을 바꾸지 않고 거절한다", async () => {
  const { recoveryRequestSchema } = await import("../lib/recovery/schema.ts");
  const { resolveRecoveryReferenceTime } = await import(
    "../lib/recovery/reference-time.ts"
  );
  const server = new Date();
  const fixedAt = new Date(server.getTime() + 2 * 60 * 60_000).toISOString();
  const request = {
    origin: {
      latitude: 37.5665,
      longitude: 126.978,
      label: "서울광장",
    },
    incident: "delay",
    availableMinutes: 180,
    itinerary: {
      title: "서울 일정",
      timezone: "Asia/Seoul",
      audience: "general",
      disruptedNodeId: "visit",
      nextFixedNodeId: "reservation",
      nodes: [
        {
          id: "visit",
          sequence: 0,
          type: "visit",
          title: "현재 일정",
          startAt: new Date(server.getTime() + 10 * 60_000).toISOString(),
          locked: false,
          reservation: false,
        },
        {
          id: "reservation",
          sequence: 1,
          type: "reservation",
          title: "고정 약속",
          startAt: fixedAt,
          locked: true,
          reservation: true,
          location: {
            latitude: 37.57,
            longitude: 126.99,
            label: "고정 약속",
          },
        },
      ],
    },
  };
  const validAt = new Date(server.getTime() + 60 * 60_000).toISOString();
  const valid = resolveRecoveryReferenceTime(
    recoveryRequestSchema.parse({
      ...request,
      referenceTime: { mode: "assumed", at: validAt },
    }),
    server,
  );
  assert.equal(valid.success, true);
  assert.equal(valid.input.itinerary.occurredAt, validAt);

  const afterLock = new Date(server.getTime() + 150 * 60_000).toISOString();
  const invalid = resolveRecoveryReferenceTime(
    recoveryRequestSchema.parse({
      ...request,
      referenceTime: { mode: "assumed", at: afterLock },
    }),
    server,
  );
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.code, "REFERENCE_TIME_CONTRACT_INVALID");
  assert.ok(
    invalid.error.fields.some((field) =>
      field.path.includes("nextFixedNodeId"),
    ),
  );
});

test("미래 조회의 0시간 날씨는 현재 실황이 아니라 해당 시각 예보다", async () => {
  const { weatherGlance } = await import("../lib/weather/window.ts");
  const evidence = {
    status: "available",
    observedAt: "2026-08-14T01:00:00.000Z",
    temperatureCelsius: 35,
    apparentTemperatureCelsius: 36,
    precipitationMillimeters: 0,
    weatherCode: 0,
    windSpeedKph: 2,
    raining: false,
    provider: "kma_short_term",
    attribution: "기상청",
    forecast: [
      { at: "2026-08-14T12:00:00+09:00", temperatureCelsius: 31 },
      {
        at: "2026-08-14T13:00:00+09:00",
        temperatureCelsius: 29,
        precipitationProbabilityPercent: 70,
        precipitationType: 1,
      },
      { at: "2026-08-14T14:00:00+09:00", temperatureCelsius: 28 },
      { at: "2026-08-14T15:00:00+09:00", temperatureCelsius: 27 },
    ],
  };
  const glance = weatherGlance(
    evidence,
    new Date("2026-08-14T13:20:00+09:00"),
  );
  assert.equal(glance[0].hoursAhead, 0);
  assert.equal(glance[0].at, "2026-08-14T13:00:00+09:00");
  assert.equal(glance[0].temperatureCelsius, 29);
  assert.equal(glance[0].precipitationType, 1);
});

test("30분 뒤를 가정해도 현재 실황을 미래 날씨처럼 재사용하지 않는다", async () => {
  const { weatherGlance } = await import("../lib/weather/window.ts");
  const observedAt = "2026-08-14T10:00:00+09:00";
  const evidence = {
    status: "available",
    observedAt,
    temperatureCelsius: 35,
    apparentTemperatureCelsius: 36,
    precipitationMillimeters: 0,
    weatherCode: 0,
    windSpeedKph: 2,
    raining: false,
    provider: "kma_short_term",
    attribution: "기상청",
    forecast: [
      {
        at: "2026-08-14T10:00:00+09:00",
        temperatureCelsius: 29,
        precipitationProbabilityPercent: 70,
        precipitationType: 1,
      },
    ],
  };
  const assumed = weatherGlance(
    evidence,
    new Date("2026-08-14T10:30:00+09:00"),
    { preferForecast: true },
  );
  assert.equal(assumed[0].at, "2026-08-14T10:00:00+09:00");
  assert.equal(assumed[0].temperatureCelsius, 29);
  assert.equal(assumed[0].precipitationType, 1);
});

test("first-party와 partner API가 같은 resolver를 통과한다", async () => {
  const [firstParty, partner] = await Promise.all([
    readFile(new URL("../app/api/v1/recover/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/v1/partner/recover/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(firstParty, /resolveRecoveryReferenceTime\(/);
  assert.match(partner, /resolveRecoveryReferenceTime\(/);
  assert.match(firstParty, /occurredAt: referenceAt/);
});
