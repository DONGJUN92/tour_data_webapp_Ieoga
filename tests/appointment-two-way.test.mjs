import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 일정 복구 화면의 "다음 예약까지 쓸 수 있는 시간"은 표시용 복사본이었다.
 *
 * 무엇이 잘못됐었나.
 *  1. 30초마다 도는 시계가 그 복사본을 덮어썼다. 여행자가 숫자를 넣어도 1분 안에
 *     원래대로 돌아갔다 — 고칠 수 있는 것처럼 보이는데 고쳐지지 않는 칸이었다.
 *  2. 그 값은 서버로 보내지도 않았다. 요청은 제출 시각에 약속 시각에서 다시
 *     계산한다. 즉 그 칸을 고쳐도 결과가 달라지지 않았다.
 *  3. 카드의 설명은 "여유 15분을 반영해 자동 계산했어요"였는데, 위의 숫자는
 *     여유를 빼지 않은 약속까지의 시간이었다. 문장이 숫자를 잘못 설명했다.
 *
 * 이제 약속 시각이 원본이고 남은 시간은 거기서 나온다. 이 파일은 두 방향이
 * 실제로 맞물리는지를 계산으로 확인한다. */

const KST = "+09:00";

test("남은 시간 → 약속 시각 → 남은 시간이 제자리로 돌아온다", async () => {
  const {
    appointmentFromAvailableMinutes,
    availableMinutesFromAppointment,
  } = await import("../app/product-app-model.ts");

  /* 2026-08-19 11:30 KST를 기준 시각으로 둔다. */
  const reference = Date.parse(`2026-08-19T11:30:00${KST}`);

  for (const minutes of [15, 30, 45, 90, 140, 300, 720, 1439, 1440]) {
    const appointment = appointmentFromAvailableMinutes(reference, minutes);
    assert.ok(appointment, `${minutes}분에서 약속 시각을 만들지 못했다`);
    const back = availableMinutesFromAppointment(
      appointment.date,
      appointment.time,
      reference,
    );
    assert.equal(
      back,
      minutes,
      `${minutes}분 → ${appointment.date} ${appointment.time} → ${back}분으로 어긋났다`,
    );
  }
});

test("초가 남아 있어도 넣은 분이 그대로 남는다", async () => {
  const { appointmentFromAvailableMinutes, availableMinutesFromAppointment } =
    await import("../app/product-app-model.ts");

  /* 실제 화면은 초가 붙은 시각에서 계산한다. 프로덕션 실측에서 15:41:23에 60을
     넣었더니 약속이 16:41이 되고 다시 세면 59분이 나왔다 — 방금 넣은 값이
     1 줄어드는 것은 여행자에게 고장으로 보인다. 분 경계로 올려 막는다. */
  for (const seconds of [0, 1, 23, 30, 59]) {
    const reference = Date.parse(`2026-08-19T15:41:${String(seconds).padStart(2, "0")}${KST}`);
    for (const minutes of [15, 60, 140, 300]) {
      const appointment = appointmentFromAvailableMinutes(reference, minutes);
      assert.ok(appointment);
      const back = availableMinutesFromAppointment(
        appointment.date,
        appointment.time,
        reference,
      );
      assert.equal(
        back,
        minutes,
        `${seconds}초에서 ${minutes}분을 넣었더니 ${back}분이 됐다`,
      );
    }
  }
});

test("자정을 넘는 약속은 날짜까지 함께 옮긴다", async () => {
  const { appointmentFromAvailableMinutes, availableMinutesFromAppointment } =
    await import("../app/product-app-model.ts");

  /* 23:00 KST에서 150분 뒤는 다음 날 01:30이다. 시각만 옮기고 날짜를 그대로 두면
     "18시간 전"이 되어 여행자가 넣은 값과 정반대가 된다. */
  const reference = Date.parse(`2026-08-19T23:00:00${KST}`);
  const appointment = appointmentFromAvailableMinutes(reference, 150);
  assert.deepEqual(appointment, { date: "2026-08-20", time: "01:30" });
  assert.equal(
    availableMinutesFromAppointment("2026-08-20", "01:30", reference),
    150,
  );
});

test("서버가 거절할 값은 약속을 옮기지 않는다", async () => {
  const { appointmentFromAvailableMinutes, MIN_APPOINTMENT_MINUTES, MAX_APPOINTMENT_MINUTES } =
    await import("../app/product-app-model.ts");
  const reference = Date.parse(`2026-08-19T11:30:00${KST}`);

  /* 범위 밖 값을 조용히 잘라 넣으면 여행자가 넣은 값과 화면에 남는 값이
     달라진다. 옮기지 않고 `null`을 준다 — 화면은 원래 값을 그대로 둔다. */
  assert.equal(appointmentFromAvailableMinutes(reference, MIN_APPOINTMENT_MINUTES - 1), null);
  assert.equal(appointmentFromAvailableMinutes(reference, MAX_APPOINTMENT_MINUTES + 1), null);
  assert.equal(appointmentFromAvailableMinutes(reference, 0), null);
  assert.equal(appointmentFromAvailableMinutes(reference, -30), null);
  assert.equal(appointmentFromAvailableMinutes(reference, 90.5), null);
  assert.equal(appointmentFromAvailableMinutes(Number.NaN, 90), null);

  /* 경계값은 통과해야 한다 — 서버 스키마도 15~1,440을 받는다. */
  assert.ok(appointmentFromAvailableMinutes(reference, MIN_APPOINTMENT_MINUTES));
  assert.ok(appointmentFromAvailableMinutes(reference, MAX_APPOINTMENT_MINUTES));
});

test("약속이 이미 지났으면 지난 대로 알린다", async () => {
  const { availableMinutesFromAppointment } = await import(
    "../app/product-app-model.ts"
  );
  const reference = Date.parse(`2026-08-19T11:30:00${KST}`);
  /* 0이나 15로 눌러 적으면 "아직 갈 수 있다"는 거짓이 된다. */
  assert.equal(
    availableMinutesFromAppointment("2026-08-19", "10:00", reference),
    -90,
  );
  /* 잘못된 값은 숫자를 지어내지 않는다. */
  assert.equal(availableMinutesFromAppointment("2026-02-30", "10:00", reference), null);
  assert.equal(availableMinutesFromAppointment("2026-08-19", "25:00", reference), null);
  assert.equal(availableMinutesFromAppointment("", "", reference), null);
});

test("표시용 복사본과 그것을 덮어쓰던 효과가 사라졌다", async () => {
  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );

  /* 복사본 state와 그 setter가 남아 있으면 시계가 다시 덮어쓴다. */
  assert.ok(
    !/const \[availableMinutes, setAvailableMinutes\]/.test(product),
    "표시용 복사본 state가 남아 있다",
  );
  assert.ok(
    !/setAvailableMinutes\(/.test(product),
    "복사본을 쓰는 코드가 남아 있다",
  );

  /* 파생값으로 바뀌었는가. */
  assert.match(product, /const availableMinutes =\s*\n?\s*nextAppointmentMinutes === null/);

  /* 두 방향이 모두 있는가. */
  assert.match(product, /function changeAvailableMinutes\(/);
  assert.match(product, /function changeAppointmentTime\(/);
  assert.match(product, /appointmentFromAvailableMinutes\(/);

  /* 값을 바꾸면 화면에 남은 옛 결과를 무효화해야 한다. 그러지 않으면 바뀌기 전
     계약으로 계산된 결과가 남아 적용 시점에 거절된다. */
  const move = product.slice(
    product.indexOf("function moveAppointment("),
    product.indexOf("function changeAvailableMinutes("),
  );
  assert.match(move, /invalidateRecoveryForReferenceTime\(\)/);
  /* 초안도 함께 옮긴다 — 두 벌이 어긋나면 편집 폼에서 방금 고친 시각이 사라진다. */
  assert.match(move, /setJourneyDraft\(/);
  assert.match(move, /setJourneyPlan\(/);
});

test("중요한 두 값은 접힌 패널이 아니라 계산 카드 옆에 있다", async () => {
  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );

  const card = product.indexOf('className="derived-time-card"');
  const hoisted = product.indexOf('className="essential-constraints field-grid"');
  const details = product.indexOf('className="advanced-constraints"');
  assert.ok(card > 0 && hoisted > 0 && details > 0);
  /* 계산 카드 → 조작하는 값 → 나머지 순서여야 한다. */
  assert.ok(card < hoisted, "조작하는 값이 계산 카드보다 위에 있다");
  assert.ok(hoisted < details, "조작하는 값이 접힌 패널보다 아래에 있다");

  /* 접힌 패널에는 결과를 크게 바꾸지 않는 값만 남는다. */
  const collapsed = product.slice(details, details + 1400);
  assert.ok(
    !/예약 전에 남겨 둘 여유/.test(collapsed),
    "여유는 접힌 패널이 아니라 위로 올라가야 한다",
  );
  assert.match(collapsed, /가면 최소 이만큼은 머물기/);

  /* 카드의 설명이 숫자를 바르게 설명하는가. 예전 문장은 여유를 "반영해 자동
     계산했다"고 했지만 숫자는 여유를 빼지 않은 값이었다. */
  const cardBlock = product.slice(card, card + 1600);
  assert.ok(
    !/여유 \$\{safetyBufferMinutes\}분을 반영해 자동 계산했어요/.test(cardBlock),
    "숫자를 잘못 설명하는 문장이 남아 있다",
  );
  assert.match(cardBlock, /약속 시각까지 남은 시간이에요/);
});

test("제출은 여전히 약속 시각에서 다시 계산한다", async () => {
  const product = await readFile(
    new URL("../app/ProductApp.tsx", import.meta.url),
    "utf8",
  );
  /* 이 이름은 다른 테스트도 고정하고 있다. 표시값을 그대로 보내도록 바꾸면
     기준 시각을 막 바꾼 직후에 옛 값이 서버로 간다. */
  assert.match(product, /availableMinutes: requestNextAppointmentMinutes/);
  assert.match(product, /const requestNextAppointmentMinutes = appointmentMinutesFromNow\(/);
});
