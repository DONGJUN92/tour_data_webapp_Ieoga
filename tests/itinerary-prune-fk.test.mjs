import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

/* 일정을 지우는 자리와, 선언과 실제가 어긋난 외래키.
 *
 * 2026-08-19 실측 결함. `db/schema.ts`는 `recovery_runs.itinerary_id`를
 * `onDelete: "set null"`로 선언했지만, 0002에서 이 열이
 * `ALTER TABLE ... ADD COLUMN`으로 추가될 때 생성된 SQL에 그 절이 빠졌다:
 *
 *   ALTER TABLE `recovery_runs` ADD `itinerary_id` text REFERENCES itineraries(id);
 *
 * SQLite 기본값은 NO ACTION 이고, 그것은 자식 행이 있으면 부모 삭제를 **막는다**.
 * drizzle 스냅샷에는 set null 로 적혀 있어서 이후 generate 로도 드러나지 않았다.
 *
 * 무엇이 깨졌는가:
 *   · 세션당 활성 일정 10건 상한을 넘기면 저장 배치에 프루닝 삭제가 들어간다.
 *     복구를 한 번 돌린 세션이 상한에 닿으면 배치가 통째로 롤백되어, 그 세션은
 *     그 뒤로 영구히 일정을 저장할 수 없었다(여행자에게는 DB_UNAVAILABLE).
 *     운영 실측: 세션 f5efe532… 활성 10건 중 5건에 복구 기록.
 *   · 보관기간 정리도 만료 일정을 하드 삭제하므로 같은 FK 에 막힌다. 지워야 할
 *     데이터가 남으므로 보관기간 약속이 조용히 깨진다.
 *
 * 지금은 앱이 지우기 전에 링크를 끊는다 — set null 이 했어야 할 일과 같고, 복구
 * 기록 자체는 남으므로 감사 기록을 잃지 않는다. 로컬 실측(운영과 동일한 결함
 * 스키마): 가장 오래된 일정 삭제됨, 복구 기록 보존, itinerary_id 만 NULL,
 * 활성 10건 유지. */

test("일정을 지우기 전에 복구 기록의 링크를 끊는다", async () => {
  const repository = await readFile(
    new URL("../lib/db/repository.ts", import.meta.url),
    "utf8",
  );

  const detach = repository.indexOf(".set({ itineraryId: null })");
  const remove = repository.indexOf(".delete(itineraries)");
  assert.ok(detach > 0, "프루닝 전 링크 해제가 없다");
  assert.ok(remove > 0, "프루닝 삭제를 찾지 못했다");
  /* 순서가 곧 정확성이다. D1 은 배치를 순차 실행하므로 해제가 삭제보다 앞에
     있어야 FK 가 걸리지 않는다. */
  assert.ok(
    detach < remove,
    "링크 해제가 삭제보다 뒤에 있으면 FK 가 삭제를 막는다",
  );
  /* 지울 대상과 같은 조건으로 고른 집합이어야 한다 — 넓으면 살아 있는 일정의
     링크까지 끊고, 좁으면 막히는 행이 남는다. */
  assert.match(repository, /const prunedItineraries = db/);
  assert.match(
    repository,
    /inArray\(recoveryRuns\.itineraryId, prunedItineraries\)/,
  );
});

test("보관기간 정리도 지우기 전에 링크를 끊는다", async () => {
  const sync = await readFile(
    new URL("../lib/sync/policy-sync.ts", import.meta.url),
    "utf8",
  );
  const detach = sync.indexOf(".set({ itineraryId: null })");
  const remove = sync.indexOf(".delete(itineraries)");
  assert.ok(detach > 0, "보관기간 정리에 링크 해제가 없다");
  assert.ok(detach < remove, "해제가 삭제보다 앞에 있어야 한다");
  /* 두 만료 시각은 서로 다른 시계로 움직인다. 복구 기록이 아직 살아 있는 채
     일정이 만료되는 상태가 정상적으로 생기므로, 만료 일정 전체를 대상으로
     끊어야 한다. */
  assert.match(sync, /lte\(itineraries\.expiresAt, now\)/);
});

test("ON DELETE 없는 외래키를 새로 늘리지 않는다", async () => {
  const dir = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql"));
  const offenders = [];
  for (const name of files) {
    const sql = await readFile(new URL(name, dir), "utf8");
    for (const raw of sql.split(/\r?\n/)) {
      const line = raw.trim();
      /* 주석은 건너뛴다. 0013 은 무엇이 잘못됐는지 설명하려고 문제의 그 줄을
         그대로 인용하고 있어서, 걸러 내지 않으면 설명이 위반으로 잡힌다. */
      if (line.startsWith("--")) continue;
      /* `ALTER TABLE ... ADD ... REFERENCES ...` 에 ON DELETE 가 없으면 SQLite
         기본값 NO ACTION 이 되어 부모 삭제를 막는다. 열을 나중에 붙일 때 특히
         쉽게 놓친다 — 그렇게 이 결함이 들어왔다. */
      if (
        /ALTER TABLE/i.test(line) &&
        /\bADD\b/i.test(line) &&
        /REFERENCES/i.test(line) &&
        !/ON DELETE/i.test(line)
      ) {
        offenders.push(`${name}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  /* 0002 의 그 줄은 역사이므로 그대로 남는다 — 0013 이 테이블을 재구축해 실제
     DDL 을 선언과 맞췄지만, 이미 커밋된 마이그레이션 파일을 고칠 수는 없다.
     이 목록이 늘어나면 새로 같은 함정을 판 것이다. */
  assert.deepEqual(offenders, [
    "0002_past_xorn.sql: ALTER TABLE `recovery_runs` ADD `itinerary_id` text REFERENCES itineraries(id);--> statement-breakpoint",
  ]);
});

test("선언과 실제 DDL을 맞추는 마이그레이션이 있다", async () => {
  const migration = await readFile(
    new URL(
      "../drizzle/0013_recovery_runs_itinerary_set_null.sql",
      import.meta.url,
    ),
    "utf8",
  );
  /* 선언(db/schema.ts)이 말하는 것과 같아야 한다. */
  assert.match(migration, /FOREIGN KEY \(`itinerary_id`\)[\s\S]*?ON DELETE set null/);
  /* 세션 연쇄는 그대로 유지된다 — 「내 데이터 삭제」가 여기에 걸려 있다. */
  assert.match(migration, /FOREIGN KEY \(`session_id`\)[\s\S]*?ON DELETE cascade/);
  /* 재구축이므로 데이터를 옮기고 인덱스를 다시 만들어야 한다. */
  assert.match(migration, /INSERT INTO `__new_recovery_runs`/);
  assert.match(migration, /ALTER TABLE `__new_recovery_runs` RENAME TO `recovery_runs`/);
  for (const index of [
    "recovery_runs_session_idx",
    "recovery_runs_itinerary_idx",
    "recovery_runs_region_idx",
    "recovery_runs_started_idx",
  ]) {
    assert.ok(
      migration.includes(index),
      `재구축 뒤 인덱스 ${index} 를 다시 만들지 않는다`,
    );
  }
  /* additive 가 아니라는 사실과 승인 경위를 파일이 스스로 밝혀야 한다 — 릴리스
     워크플로가 이 디렉터리를 매 배포마다 원격에 적용하기 때문이다. */
  assert.match(migration, /additive 가 아니다/);
});

test("스키마를 고친 뒤에도 앱의 링크 해제를 남긴다", async () => {
  /* 환경마다 스키마가 앞서거나 뒤처질 수 있다. 동작이 어느 쪽인지에 따라
     달라지지 않는 편이 낫고, 위 두 시험이 그 순서를 계속 지킨다. */
  const [repository, sync] = await Promise.all([
    readFile(new URL("../lib/db/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sync/policy-sync.ts", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /\.set\(\{ itineraryId: null \}\)/);
  assert.match(sync, /\.set\(\{ itineraryId: null \}\)/);
});
