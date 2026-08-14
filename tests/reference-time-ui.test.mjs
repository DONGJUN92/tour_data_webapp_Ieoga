import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const src = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("조회 기준 시간은 현재·직접 선택과 한국시간 검증을 제공한다", async () => {
  const [picker, helper] = await Promise.all([
    src("../app/ReferenceTimePicker.tsx"),
    src("../app/reference-time.ts"),
  ]);

  assert.match(picker, /현재 시각/);
  assert.match(picker, /날짜·시각 선택/);
  assert.match(picker, /type="datetime-local"/);
  assert.match(picker, /현재 시각으로 되돌리기/);
  assert.match(picker, /aria-invalid/);
  assert.match(picker, /role="alert"/);
  /* 미래 상한은 없앴다. 도착 시각이 운영시간 안인지가 판정을 가르고, 그 원천은
     시각과 무관하게 유효하다. 대신 확인할 수 없는 것(3일 밖 날씨)은 조회를
     막지 않고 화면이 미리 말한다. */
  assert.ok(
    !/MAX_REFERENCE_TIME_FUTURE_MINUTES/.test(helper),
    "미래 상한이 되살아났다",
  );
  assert.match(helper, /KMA_FORECAST_HORIZON_MINUTES/);
  assert.match(helper, /export function referenceTimeCaveat/);
  assert.match(picker, /referenceTimeCaveat/);
  assert.match(helper, /timestamp < nowMs - 60_000/);
  assert.match(helper, /Asia\/Seoul/);
  assert.match(picker, /useState\(0\)/);
});

test("한국시간 직접 입력은 과거만 거절하고 먼 미래도 ISO로 보존한다", async () => {
  const { koreaDateTimeLocalValue, referenceTimeCaveat, resolveReferenceTime } =
    await import("../app/reference-time.ts");
  const now = Date.parse("2026-08-14T01:00:00.000Z"); // 한국시간 오전 10시
  assert.equal(koreaDateTimeLocalValue(now), "2026-08-14T10:00");
  assert.equal(
    resolveReferenceTime("scheduled", "2026-08-14T09:58", "ko", now).ok,
    false,
    "지난 시각은 계속 거절해야 한다",
  );
  assert.deepEqual(
    resolveReferenceTime("scheduled", "2026-08-14T16:00", "ko", now),
    {
      ok: true,
      iso: "2026-08-14T07:00:00.000Z",
      timestamp: Date.parse("2026-08-14T07:00:00.000Z"),
    },
  );
  /* 예전에는 여기서 거절했다. 여섯 시간을 넘겼다는 이유였는데, 운영시간·경로는
     그 너머에서도 확인된다. */
  const nextWeek = resolveReferenceTime(
    "scheduled",
    "2026-08-21T14:00",
    "ko",
    now,
  );
  assert.equal(nextWeek.ok, true, "다음 주 조회를 막아서는 안 된다");
  assert.equal(nextWeek.iso, "2026-08-21T05:00:00.000Z");
  /* 대신 확인할 수 없는 것은 조회 전에 말한다. */
  assert.equal(referenceTimeCaveat(nextWeek.timestamp, "ko", now).length > 0, true);
  assert.equal(
    referenceTimeCaveat(Date.parse("2026-08-14T07:00:00.000Z"), "ko", now),
    "",
    "예보가 닿는 범위에는 단서를 붙이지 않는다",
  );
});

test("두 제품 탭은 같은 기준시간 계약을 전송하고 이전 응답을 폐기한다", async () => {
  const [product, discover] = await Promise.all([
    src("../app/ProductApp.tsx"),
    src("../app/DiscoverWindowPanel.tsx"),
  ]);

  for (const source of [product, discover]) {
    assert.match(source, /<ReferenceTimePicker/);
    assert.match(source, /mode: "current"/);
    assert.match(source, /mode: "assumed", at: requestReferenceTime\.iso/);
    assert.match(source, /requestGeneration !== .*GenerationRef\.current/);
    assert.match(source, /formatReferenceTime/);
    assert.doesNotMatch(source, /assumedAt/);
  }
  assert.match(product, /requestReferenceTime\.iso,\s*\)/);
  assert.match(product, /availableMinutes: requestNextAppointmentMinutes/);
  assert.match(product, /가정 시각 ·/);
  assert.match(discover, /가정 시각 ·/);
  assert.doesNotMatch(product, /useState\(\(\) =>\s*scheduledReferenceFromOffset/);
  assert.doesNotMatch(discover, /useState\(\(\) =>\s*scheduledReferenceFromOffset/);
  assert.match(discover, /requestReferenceTime\.timestamp \+ windowMinutes \* 60_000/);
  assert.doesNotMatch(discover, /windowMinutes - departureDelayMinutes/);
});

test("일정 계약은 조회 기준 시각을 occurredAt으로 고정할 수 있다", async () => {
  const model = await src("../app/product-app-model.ts");
  assert.match(model, /occurredAt = new Date\(\)\.toISOString\(\)/);
  assert.match(model, /\n\s*occurredAt,\n/);
});
