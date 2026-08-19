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
    for (const line of sql.split(/\r?\n/)) {
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
  /* 이미 들어온 한 건은 그대로 둔다 — 고치려면 테이블 재구축이 필요하고, 릴리스
     워크플로가 `drizzle/` 을 매 배포마다 원격에 자동 적용하므로 사람 확인 없이
     운영 데이터에 DROP TABLE 을 실행하게 된다. 준비된 마이그레이션은
     `db/proposed/` 에 두었다. 그 사이의 안전은 위 두 시험이 지킨다. */
  assert.deepEqual(offenders, [
    "0002_past_xorn.sql: ALTER TABLE `recovery_runs` ADD `itinerary_id` text REFERENCES itineraries(id);--> statement-breakpoint",
  ]);
});

test("준비된 마이그레이션은 자동 적용 경로에 두지 않는다", async () => {
  const proposed = await readFile(
    new URL(
      "../db/proposed/0013_recovery_runs_itinerary_set_null.sql",
      import.meta.url,
    ),
    "utf8",
  );
  /* 선언대로(set null) 만드는 내용이어야 한다. */
  assert.match(proposed, /ON DELETE set null/);
  assert.match(proposed, /__new_recovery_runs/);
  /* 왜 여기 있는지 파일 스스로 밝혀야 한다. */
  assert.match(proposed, /drizzle\/. 로 옮기지 말 것|drizzle\/` 로 옮기지 말 것/);

  const files = await readdir(new URL("../drizzle/", import.meta.url));
  assert.ok(
    !files.some((name) => name.startsWith("0013")),
    "재구축 마이그레이션이 자동 적용 디렉터리에 들어갔다",
  );
});
