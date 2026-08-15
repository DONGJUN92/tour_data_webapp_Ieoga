import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

const base = {
  availability: { status: "confirmed_open", checkedAt: new Date().toISOString() },
  evidenceGapCodes: [],
};

/* 운영시간을 대조하지 못한 안을 목록에 올리면서 실행 계약이 그것을 담지 못하면,
   저장이 실패하고 **응답 전체가 버려진다.** 실제로 그렇게 됐다 — 화면에는
   "실행 전체를 안전하게 저장하지 못해 결과를 제공하지 않습니다"만 남고 후보는
   한 곳도 나오지 않았다. 계약이 두 갈래를 아는지 여기서 고정한다. */
test("실행 계약은 완전 검증과 운영시간 미확인을 모두 담는다", async () => {
  const { applicationSnapshotClass } = await import(
    "../lib/recovery/application-snapshot.ts"
  );

  assert.equal(applicationSnapshotClass(base), "verified");

  assert.equal(
    applicationSnapshotClass({
      availability: {
        status: "official_hours_unstructured",
        checkedAt: new Date().toISOString(),
      },
      evidenceGapCodes: ["OPERATING_HOURS_UNVERIFIED"],
    }),
    "hours_unconfirmed",
  );

  assert.equal(
    applicationSnapshotClass({
      availability: { status: "unknown", checkedAt: new Date().toISOString() },
      evidenceGapCodes: ["OPERATING_HOURS_UNVERIFIED"],
    }),
    "hours_unconfirmed",
  );
});

test("휴무·다른 근거 공백은 어느 계약에도 들지 못한다", async () => {
  const { applicationSnapshotClass } = await import(
    "../lib/recovery/application-snapshot.ts"
  );
  const at = new Date().toISOString();

  /* 닫혀 있다고 **확인된** 곳. 동의를 받는다고 문이 열리지 않는다. */
  assert.equal(
    applicationSnapshotClass({
      availability: { status: "confirmed_closed", checkedAt: at },
      evidenceGapCodes: [],
    }),
    undefined,
  );

  /* 접근성처럼 다른 조건이 미확인이면 동의로 열리지 않는다. */
  assert.equal(
    applicationSnapshotClass({
      availability: { status: "official_hours_unstructured", checkedAt: at },
      evidenceGapCodes: [
        "OPERATING_HOURS_UNVERIFIED",
        "ACCESSIBILITY_UNVERIFIED",
      ],
    }),
    undefined,
  );

  /* 운영시간은 확인됐는데 공백이 남아 있는 조합도 통과시키지 않는다. */
  assert.equal(
    applicationSnapshotClass({
      availability: { status: "confirmed_open", checkedAt: at },
      evidenceGapCodes: ["ACCESSIBILITY_UNVERIFIED"],
    }),
    undefined,
  );
});

/* 화면의 체크박스는 화면의 약속일 뿐이다. 요청을 직접 만들면 지나갈 수 있으므로,
   계약을 만드는 서버가 다시 물어야 한다. */
test("운영시간 미확인 안은 서버에서도 동의 없이 적용되지 않는다", async () => {
  const repository = await readFile(
    new URL("../lib/db/repository.ts", import.meta.url),
    "utf8",
  );
  const activate = repository.slice(
    repository.indexOf("export async function activateRecoveryExecution"),
  );
  assert.match(
    activate.slice(0, 8_000),
    /applicationSnapshotClass\(applicationSnapshot\) === "hours_unconfirmed"/,
  );
  assert.match(
    activate.slice(0, 8_000),
    /params\.acknowledgeUnverifiedHours !== true/,
  );
  assert.match(activate.slice(0, 8_000), /ACKNOWLEDGEMENT_REQUIRED/);

  /* 요청 스키마가 그 값을 받아야 서버까지 도달한다. */
  const schema = await readFile(
    new URL("../lib/recovery/schema.ts", import.meta.url),
    "utf8",
  );
  assert.match(schema, /acknowledgeUnverifiedHours: z\.boolean\(\)\.optional\(\)/);

  /* 두 화면 모두 동의를 요청에 실어 보낸다. */
  for (const file of ["../app/ProductApp.tsx", "../app/flow/FlowApp.tsx"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(
      source,
      /acknowledged \? \{ acknowledgeUnverifiedHours: true \} : \{\}/,
      `${file}가 동의를 서버로 보내지 않는다`,
    );
  }
});

/* 계약의 뜻이 바뀌었으므로 예전에 저장된 스냅숏이 새 규칙으로 읽히면 안 된다. */
test("계약 버전은 규칙이 바뀌면 함께 올라간다", async () => {
  const source = await readFile(
    new URL("../lib/recovery/application-snapshot.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /APPLICATION_SAFETY_CONTRACT_VERSION = "2026-08-v3"/,
  );
});
