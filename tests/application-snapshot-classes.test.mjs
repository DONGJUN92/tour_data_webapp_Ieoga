import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 엔진이 실제로 만드는 옵션과 **같은 모양**으로 스냅숏을 짓는다.
   처음 이 파일을 쓸 때는 손으로 만든 객체에 `availability`와 `evidenceGapCodes`만
   담았다. 그래서 `confirmationRequired`가 빠진 것을 아무도 눈치채지 못했고,
   테스트는 통과하는데 운영에서는 계약이 만들어지지 않아 응답 전체가 503이 됐다.
   엔진은 근거 공백이 하나라도 있으면 그 값을 참으로 세운다 — 필드를 빠뜨리면
   검사도 함께 빠진다. 그래서 필요한 필드를 전부 갖춘 뒤 필요한 것만 바꾼다. */
function snapshotFor({ status, gaps }) {
  const at = new Date().toISOString();
  return {
    availability: { status, checkedAt: at },
    evidenceGapCodes: gaps,
    /* 엔진과 같은 규칙: 공백이 있으면 확인이 필요하다. */
    confirmationRequired: gaps.length > 0,
  };
}

/* 운영시간을 대조하지 못한 안을 목록에 올리면서 실행 계약이 그것을 담지 못하면,
   저장이 실패하고 **응답 전체가 버려진다.** 실제로 그렇게 됐다 — 화면에는
   "실행 전체를 안전하게 저장하지 못해 결과를 제공하지 않습니다"만 남고 후보는
   한 곳도 나오지 않았다. 계약이 두 갈래를 아는지 여기서 고정한다. */
test("실행 계약은 완전 검증과 운영시간 미확인을 모두 담는다", async () => {
  const { applicationSnapshotClass } = await import(
    "../lib/recovery/application-snapshot.ts"
  );

  assert.equal(
    applicationSnapshotClass(
      snapshotFor({ status: "confirmed_open", gaps: [] }),
    ),
    "verified",
  );

  for (const status of ["official_hours_unstructured", "unknown"]) {
    assert.equal(
      applicationSnapshotClass(
        snapshotFor({ status, gaps: ["OPERATING_HOURS_UNVERIFIED"] }),
      ),
      "hours_unconfirmed",
      `${status}가 계약에 들지 못한다`,
    );
  }
});

/* `confirmationRequired`는 공백과 같은 사실의 두 표현이다. 둘이 어긋난 스냅숏은
   어느 쪽이 참인지 알 수 없으므로 계약에 넣지 않는다. 이 검사가 없어서 실제
   장애가 났다. */
test("확인 필요 표시가 근거 공백과 어긋나면 계약에 들지 못한다", async () => {
  const { applicationSnapshotClass } = await import(
    "../lib/recovery/application-snapshot.ts"
  );
  const at = new Date().toISOString();

  assert.equal(
    applicationSnapshotClass({
      availability: { status: "official_hours_unstructured", checkedAt: at },
      evidenceGapCodes: ["OPERATING_HOURS_UNVERIFIED"],
      confirmationRequired: false,
    }),
    undefined,
    "공백이 있는데 확인 불필요라고 적힌 스냅숏",
  );

  assert.equal(
    applicationSnapshotClass({
      availability: { status: "confirmed_open", checkedAt: at },
      evidenceGapCodes: [],
      confirmationRequired: true,
    }),
    undefined,
    "공백이 없는데 확인 필요라고 적힌 스냅숏",
  );
});

test("휴무·다른 근거 공백은 어느 계약에도 들지 못한다", async () => {
  const { applicationSnapshotClass } = await import(
    "../lib/recovery/application-snapshot.ts"
  );

  /* 닫혀 있다고 **확인된** 곳. 동의를 받는다고 문이 열리지 않는다. */
  assert.equal(
    applicationSnapshotClass(
      snapshotFor({ status: "confirmed_closed", gaps: [] }),
    ),
    undefined,
  );

  /* 접근성처럼 다른 조건이 미확인이면 동의로 열리지 않는다. */
  assert.equal(
    applicationSnapshotClass(
      snapshotFor({
        status: "official_hours_unstructured",
        gaps: ["OPERATING_HOURS_UNVERIFIED", "ACCESSIBILITY_UNVERIFIED"],
      }),
    ),
    undefined,
  );

  /* 운영시간은 확인됐는데 공백이 남아 있는 조합도 통과시키지 않는다. */
  assert.equal(
    applicationSnapshotClass(
      snapshotFor({
        status: "confirmed_open",
        gaps: ["ACCESSIBILITY_UNVERIFIED"],
      }),
    ),
    undefined,
  );
});

/* 계약을 만들지 못한 안 하나가 조회 전체를 무너뜨리면 안 된다. 그 안은 어차피
   적용 경로가 거절하므로 목록에 남길 이유가 없고, 나머지 여덟 곳이 멀쩡한데
   전부 버릴 이유는 더더욱 없다. */
test("봉인하지 못한 안은 그 안만 빠지고 응답은 살아남는다", async () => {
  const repository = await readFile(
    new URL("../lib/db/repository.ts", import.meta.url),
    "utf8",
  );
  /* "봉인하지 못했다"에는 성격이 다른 두 가지가 섞여 있고, 목록에서 빼는 것은
     그중 하나뿐이다 — 계약이 담을 수 있어야 하는데 못 담은 안. 계약이 일부러
     배제하는 안(계단 없는 동선이 필요한데 무장애 정보를 확인하지 못한 곳)은
     규칙이 제대로 작동한 결과이므로 목록에 남는다. 둘을 구분하지 않던 동안,
     후자만 남는 조회는 응답 전체가 503이 됐다. */
  assert.match(repository, /contractExcluded/);
  assert.match(
    repository,
    /const unexpectedlyUnsealed = params\.result\.options\.filter/,
  );
  assert.match(
    repository,
    /return !snapshot\?\.sealed && !snapshot\?\.contractExcluded;/,
  );
  assert.match(repository, /적용 계약을 만들지 못해 목록에서 제외했습니다/);
  /* 그렇게 빼고 나서 남은 것이 하나도 없을 때만 요청 자체를 실패로 돌린다. */
  assert.match(
    repository,
    /if \(params\.result\.options\.length === 0\) \{[\s\S]{0,400}reason: "APPLICATION_SNAPSHOT_UNAVAILABLE"/,
  );
  /* 값을 눌러 넣는 캐스트가 되살아나면 같은 장애가 다시 난다. */
  assert.ok(
    !/confirmationRequired: option\.confirmationRequired as false/.test(
      repository,
    ),
    "확인 필요 값을 false로 눌러 담고 있다",
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
    /APPLICATION_SAFETY_CONTRACT_VERSION = "2026-08-v4"/,
  );
});
