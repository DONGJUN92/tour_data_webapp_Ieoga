import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 지정과제 1번의 실시간 변수 중 **동선 꼬임**.
 *
 * 배경: 이 앱에는 탐지 코드가 아예 없었다. 진행 중 실행이 받는 동작은
 * `arrive_step`과 `abandon` 둘뿐이고, 도착이 예정보다 늦어도 아무 일이
 * 일어나지 않았다. 사용자가 스스로 "이러다 다음 약속을 놓치겠다"고 깨닫고
 * 복구를 다시 요청해야 했다 — 위기 순간에 그 판단을 하기 어려워서 이 앱을
 * 쓰는 것이다.
 *
 * 필요한 값은 이미 `journey_execution_steps`에 있다(`scheduledAt`,
 * `estimatedArrivalAt`, `durationMinutes`, `arrivedAt`). 원격 D1 마이그레이션이
 * 토큰 권한으로 막혀 있으므로 이 점이 결정적이다. */

async function src(rel) {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

function step(overrides) {
  return {
    id: `step-${overrides.sequence}`,
    sequence: 0,
    role: "replacement",
    title: "대체 장소",
    type: "visit",
    latitude: 37.5,
    longitude: 127,
    locked: false,
    reservation: false,
    verificationStatus: "continuity_verified",
    status: "pending",
    ...overrides,
  };
}

function execution(steps, overrides = {}) {
  return {
    status: "active",
    nextFixedStepSequence: 1,
    steps,
    ...overrides,
  };
}

test("예정보다 이르거나 오차 범위면 경고하지 않는다", async () => {
  const { assessJourneyDrift, DRIFT_REPORT_THRESHOLD_MINUTES } = await import(
    "../lib/recovery/drift.ts"
  );
  /* 자가 보고 도착은 몇 분씩 흔들린다. 그 흔들림으로 경고를 띄우면 경고가
     무의미해지고, 무의미한 경고는 정직한 경고까지 무시하게 만든다. */
  assert.equal(DRIFT_REPORT_THRESHOLD_MINUTES, 10);
  const early = assessJourneyDrift(
    execution([
      step({
        sequence: 0,
        status: "arrived",
        scheduledAt: "2026-08-05T10:00:00+09:00",
        arrivedAt: "2026-08-05T09:52:00+09:00",
      }),
    ]),
  );
  assert.equal(early.status, "on_track");
  assert.equal(early.delayMinutes, -8);

  const jitter = assessJourneyDrift(
    execution([
      step({
        sequence: 0,
        status: "arrived",
        scheduledAt: "2026-08-05T10:00:00+09:00",
        arrivedAt: "2026-08-05T10:07:00+09:00",
      }),
    ]),
  );
  assert.equal(jitter.status, "on_track");
  assert.equal(jitter.delayMinutes, 7);
});

test("지연이 계획의 여유를 넘으면 다음 고정 일정이 위험하다고 판정한다", async () => {
  const { assessJourneyDrift } = await import("../lib/recovery/drift.ts");
  /* 계획은 다음 고정 일정에 여유를 확보해 두었다(`scheduledAt` 대비
     `estimatedArrivalAt`). 지연이 그 여유를 넘으면 약속을 지킬 수 없다.
     새 경로 계산을 하지 않고 계획이 이미 검증해 둔 숫자를 쓴다 — 도착을 찍는
     순간에 외부 호출을 넣으면 그 탭이 느려지고 실패하면 도착 기록 자체가
     위험해진다. */
  const drift = assessJourneyDrift(
    execution([
      step({
        sequence: 0,
        status: "arrived",
        scheduledAt: "2026-08-05T10:00:00+09:00",
        arrivedAt: "2026-08-05T10:35:00+09:00",
      }),
      step({
        sequence: 1,
        role: "next_fixed",
        title: "예약한 공연",
        reservation: true,
        locked: true,
        /* 계획은 12:00 약속에 11:40 도착을 잡았다 — 여유 20분. */
        scheduledAt: "2026-08-05T12:00:00+09:00",
        estimatedArrivalAt: "2026-08-05T11:40:00+09:00",
      }),
    ]),
  );
  assert.equal(drift.status, "behind");
  assert.equal(drift.delayMinutes, 35);
  assert.equal(drift.slackMinutes, 20);
  assert.equal(drift.nextFixedAtRisk, true);
  assert.equal(drift.nextFixedTitle, "예약한 공연");
  assert.match(drift.note, /35분 늦었습니다/);
  assert.match(drift.note, /여유는 20분/);
  assert.match(drift.noteEn, /no longer fits/);
});

test("여유 안의 지연은 늦었다고만 말하고 위험으로 부풀리지 않는다", async () => {
  const { assessJourneyDrift } = await import("../lib/recovery/drift.ts");
  const drift = assessJourneyDrift(
    execution([
      step({
        sequence: 0,
        status: "arrived",
        scheduledAt: "2026-08-05T10:00:00+09:00",
        arrivedAt: "2026-08-05T10:15:00+09:00",
      }),
      step({
        sequence: 1,
        role: "next_fixed",
        title: "예약한 공연",
        scheduledAt: "2026-08-05T12:00:00+09:00",
        estimatedArrivalAt: "2026-08-05T11:00:00+09:00",
      }),
    ]),
  );
  assert.equal(drift.status, "behind");
  assert.equal(drift.slackMinutes, 60);
  assert.equal(drift.nextFixedAtRisk, false);
  assert.match(drift.note, /아직 지킬 수 있습니다/);
});

test("여유를 알 수 없으면 위험하다고 단정하지 않는다", async () => {
  const { assessJourneyDrift } = await import("../lib/recovery/drift.ts");
  /* 근거 없이 "약속을 놓친다"고 말하면 사용자를 불필요하게 움직이게 만든다. */
  const drift = assessJourneyDrift(
    execution([
      step({
        sequence: 0,
        status: "arrived",
        scheduledAt: "2026-08-05T10:00:00+09:00",
        arrivedAt: "2026-08-05T10:40:00+09:00",
      }),
      step({ sequence: 1, role: "next_fixed", title: "다음 장소" }),
    ]),
  );
  assert.equal(drift.status, "behind");
  assert.equal(drift.slackMinutes, undefined);
  assert.equal(drift.nextFixedAtRisk, false);
  assert.match(drift.note, /다음 고정 일정은 확인되지 않았습니다/);
});

test("판정할 근거가 없으면 판정하지 않는다", async () => {
  const { assessJourneyDrift } = await import("../lib/recovery/drift.ts");
  /* 도착을 아직 찍지 않았거나 예정 시각이 없으면 모른다고 해야 한다. */
  assert.equal(
    assessJourneyDrift(execution([step({ sequence: 0, status: "current" })]))
      .status,
    "unknown",
  );
  assert.equal(
    assessJourneyDrift(
      execution([
        step({
          sequence: 0,
          status: "arrived",
          arrivedAt: "2026-08-05T10:35:00+09:00",
        }),
      ]),
    ).status,
    "unknown",
  );
  /* 끝난 여행은 판정 대상이 아니다. */
  assert.equal(
    assessJourneyDrift(
      execution(
        [
          step({
            sequence: 0,
            status: "arrived",
            scheduledAt: "2026-08-05T10:00:00+09:00",
            arrivedAt: "2026-08-05T11:00:00+09:00",
          }),
        ],
        { status: "completed" },
      ),
    ).status,
    "unknown",
  );
});

test("역할별로 다른 컬럼에 든 시각을 모두 읽는다", async () => {
  const { assessJourneyDrift } = await import("../lib/recovery/drift.ts");
  /* 실제 저장을 보면 `replacement`는 `scheduled_at`, `next_fixed`는
     `estimated_arrival_at`에 시각이 들어간다. 한쪽만 보면 판정이 통째로
     `unknown`이 된다. */
  const drift = assessJourneyDrift(
    execution([
      step({
        sequence: 0,
        status: "arrived",
        estimatedArrivalAt: "2026-08-05T10:00:00+09:00",
        arrivedAt: "2026-08-05T10:30:00+09:00",
      }),
    ]),
  );
  assert.equal(drift.status, "behind");
  assert.equal(drift.delayMinutes, 30);
});

test("조회 경로와 갱신 경로가 같은 판정을 쓴다", async () => {
  const repo = await src("../lib/db/repository.ts");
  /* 두 곳에 따로 계산하면 갈라진다. 이 프로젝트에서 점수와 라벨이 갈려
     라벨이 자기 카드의 수치와 반대가 된 일이 있었다. */
  assert.match(repo, /import \{ assessJourneyDrift \} from "@\/lib\/recovery\/drift"/);
  assert.match(repo, /return \{ \.\.\.mapped, drift: assessJourneyDrift\(mapped\) \}/);
  /* 새 호출도, 스키마 변경도 없어야 한다 — 원격 마이그레이션이 막혀 있다. */
  const drift = await src("../lib/recovery/drift.ts");
  assert.ok(!/fetch\(|getRoute|await /.test(drift), "판정에 외부 호출이 들어갔다");
});

test("화면이 사실을 알리고 선택은 사용자가 한다", async () => {
  const cockpit = await src("../app/ActiveJourneyCockpit.tsx");
  assert.match(cockpit, /execution\.drift\?\.status === "behind"/);
  assert.match(cockpit, /이대로면 다음 고정 일정을 지키기 어렵습니다/);
  assert.match(cockpit, /Your next fixed stop no longer fits\./);
  /* 우리가 대신 다시 복구하지 않는다. 버튼을 주고 누르는 것은 사용자다. */
  assert.match(cockpit, /지금 상황으로 다시 찾기/);
  assert.match(cockpit, /execution\.drift\.nextFixedAtRisk && onRecoverAgain/);
  /* 위험하지 않은 지연에는 버튼을 만들지 않는다 — 아직 지킬 수 있다. */
  const product = await src("../app/ProductApp.tsx");
  assert.match(product, /onRecoverAgain=\{\(\) => \{/);

  /* 색 대비는 자체 선언 기준(본문 4.5:1)을 지켜야 한다. 이음 틸 #0e9594는
     흰 텍스트와 3.66:1로 미달이므로 버튼에 쓰지 않는다. */
  const css = await src("../app/globals.css");
  const block = css.slice(
    css.indexOf(".cockpit-drift button {"),
    css.indexOf(".cockpit-itinerary {"),
  );
  assert.ok(
    !/background:\s*#0e9594/i.test(block),
    "대비 미달 색이 버튼 배경으로 쓰였다",
  );
  assert.match(block, /background: var\(--accent\)/);
});
