-- recovery_runs.itinerary_id 에 빠져 있던 ON DELETE SET NULL 을 실제로 적용한다.
--
-- 왜 필요한가. db/schema.ts 는 처음부터 `onDelete: "set null"` 로 선언했지만,
-- 0002 에서 이 열이 `ALTER TABLE ... ADD COLUMN` 으로 추가되면서 생성된 SQL 에
-- ON DELETE 절이 빠졌다:
--
--   ALTER TABLE `recovery_runs` ADD `itinerary_id` text REFERENCES itineraries(id);
--
-- SQLite 기본값은 NO ACTION 이고, 그것은 자식 행이 있으면 부모 삭제를 **막는다**.
-- 선언과 실제가 어긋난 채로 지나갔고, drizzle 스냅샷에는 set null 로 적혀 있어
-- 이후 generate 로도 드러나지 않았다.
--
-- 무엇이 깨졌는가 (2026-08-19 실측):
--   (1) 세션당 활성 일정 10건 상한을 넘기면 가장 오래된 일정을 지우는 문장이
--       저장 배치에 들어간다. 그 일정에 복구 실행 기록이 붙어 있으면 삭제가
--       막혀 배치 전체가 롤백되고, 여행자에게는 DB_UNAVAILABLE 이 돌아간다.
--       한 번 걸리면 그 세션은 영구히 저장할 수 없다. 실측: 세션
--       f5efe532-a6a0-477b-8cd0-a10161c33c01 이 활성 10건, 그중 5건에 복구 기록.
--   (2) 보관기간 정리(lib/sync/policy-sync.ts)가 만료 일정을 하드 삭제하는데,
--       복구 기록이 아직 만료되지 않았으면 같은 FK 에 막힌다. 지워야 할 데이터가
--       남으므로 보관기간 약속이 조용히 깨진다.
--
-- 이 파일은 additive 가 아니다 — 테이블 재구축(DROP TABLE + RENAME)이다.
-- 릴리스 워크플로가 `drizzle/` 전체를 매 배포마다 원격에 적용하므로, 재구축을
-- 여기 두는 것은 그 자체가 결정이다. 2026-08-19 사용자 승인을 받고 옮겼고,
-- 적용 전 recovery_runs 59행을 내보내 두었다. 한 번 적용된 뒤로는 d1_migrations
-- 에 기록되어 이후 배포에서는 아무 일도 하지 않는다.
--
-- 자식 테이블(recovery_options 등)의 FK 는 0001 에서 같은 재구축을 거쳤을 때
-- 정상 유지됐음을 운영 DB 에서 확인했다.
--
-- 앱 쪽 링크 해제(lib/db/repository.ts, lib/sync/policy-sync.ts)는 이 마이그레이션
-- 뒤에도 남긴다. 환경마다 스키마가 앞서거나 뒤처질 수 있는데, 동작이 어느 쪽인지에
-- 따라 달라지지 않는 편이 낫다.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`itinerary_id` text,
	`disrupted_node_id` text,
	`next_fixed_node_id` text,
	`recovery_mode` text DEFAULT 'proximity_fallback' NOT NULL,
	`incident` text NOT NULL,
	`audience` text NOT NULL,
	`region_code` text,
	`district_code` text DEFAULT '_all' NOT NULL,
	`time_budget_bucket` text NOT NULL,
	`distance_bucket` text NOT NULL,
	`indoor_required` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`rule_version` text NOT NULL,
	`option_count` integer DEFAULT 0 NOT NULL,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`changed_node_count` integer,
	`locked_node_count` integer,
	`locked_nodes_preserved` integer,
	`next_fixed_preserved` integer,
	`decision_proof_json` text,
	`itinerary_impact_hash` text,
	`counterfactual_json` text,
	`analytics_eligible` integer DEFAULT false NOT NULL,
	`failure_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`expires_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_recovery_runs`("id", "session_id", "itinerary_id", "disrupted_node_id", "next_fixed_node_id", "recovery_mode", "incident", "audience", "region_code", "district_code", "time_budget_bucket", "distance_bucket", "indoor_required", "status", "rule_version", "option_count", "rejected_count", "changed_node_count", "locked_node_count", "locked_nodes_preserved", "next_fixed_preserved", "decision_proof_json", "itinerary_impact_hash", "counterfactual_json", "analytics_eligible", "failure_code", "created_at", "completed_at", "expires_at", "deleted_at") SELECT "id", "session_id", "itinerary_id", "disrupted_node_id", "next_fixed_node_id", "recovery_mode", "incident", "audience", "region_code", "district_code", "time_budget_bucket", "distance_bucket", "indoor_required", "status", "rule_version", "option_count", "rejected_count", "changed_node_count", "locked_node_count", "locked_nodes_preserved", "next_fixed_preserved", "decision_proof_json", "itinerary_impact_hash", "counterfactual_json", "analytics_eligible", "failure_code", "created_at", "completed_at", "expires_at", "deleted_at" FROM `recovery_runs`;--> statement-breakpoint
DROP TABLE `recovery_runs`;--> statement-breakpoint
ALTER TABLE `__new_recovery_runs` RENAME TO `recovery_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `recovery_runs_session_idx` ON `recovery_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `recovery_runs_itinerary_idx` ON `recovery_runs` (`itinerary_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `recovery_runs_region_idx` ON `recovery_runs` (`region_code`,`district_code`);--> statement-breakpoint
CREATE INDEX `recovery_runs_started_idx` ON `recovery_runs` (`created_at`);--> statement-breakpoint
-- 이미 사라진 일정을 가리키는 값은 SET NULL 이 원래 했어야 할 일을 해 준다.
-- FK 를 끈 상태로 옮겼으므로 SQLite 가 되돌아가 검사하지 않는다.
UPDATE `recovery_runs` SET `itinerary_id` = NULL WHERE `itinerary_id` IS NOT NULL AND `itinerary_id` NOT IN (SELECT `id` FROM `itineraries`);
