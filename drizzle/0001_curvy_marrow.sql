PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
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
	`analytics_eligible` integer DEFAULT false NOT NULL,
	`failure_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`expires_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_recovery_runs`("id", "session_id", "incident", "audience", "region_code", "district_code", "time_budget_bucket", "distance_bucket", "indoor_required", "status", "rule_version", "option_count", "rejected_count", "analytics_eligible", "failure_code", "created_at", "completed_at", "expires_at", "deleted_at") SELECT "id", "session_id", "incident", "audience", "region_code", COALESCE("district_code", '_all'), "time_budget_bucket", "distance_bucket", "indoor_required", "status", "rule_version", "option_count", "rejected_count", "analytics_eligible", "failure_code", "created_at", "completed_at", "expires_at", "deleted_at" FROM `recovery_runs`;--> statement-breakpoint
DROP TABLE `recovery_runs`;--> statement-breakpoint
ALTER TABLE `__new_recovery_runs` RENAME TO `recovery_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `recovery_runs_session_idx` ON `recovery_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `recovery_runs_region_idx` ON `recovery_runs` (`region_code`,`district_code`);--> statement-breakpoint
CREATE INDEX `recovery_runs_started_idx` ON `recovery_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `__new_region_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text DEFAULT '_all' NOT NULL,
	`base_month` text NOT NULL,
	`calculation_version` text NOT NULL,
	`object_key` text NOT NULL,
	`checksum` text NOT NULL,
	`status` text NOT NULL,
	`coverage_percent` real NOT NULL,
	`source_updated_at` text NOT NULL,
	`activated_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_region_packs`("id", "region_code", "district_code", "base_month", "calculation_version", "object_key", "checksum", "status", "coverage_percent", "source_updated_at", "activated_at", "created_at") SELECT "id", "region_code", COALESCE("district_code", '_all'), "base_month", "calculation_version", "object_key", "checksum", "status", "coverage_percent", "source_updated_at", "activated_at", "created_at" FROM `region_packs`;--> statement-breakpoint
DROP TABLE `region_packs`;--> statement-breakpoint
ALTER TABLE `__new_region_packs` RENAME TO `region_packs`;--> statement-breakpoint
CREATE UNIQUE INDEX `region_packs_object_idx` ON `region_packs` (`object_key`);--> statement-breakpoint
CREATE INDEX `region_packs_scope_idx` ON `region_packs` (`region_code`,`district_code`,`activated_at`);--> statement-breakpoint
CREATE TABLE `__new_region_policy_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text DEFAULT '_all' NOT NULL,
	`base_month` text NOT NULL,
	`status` text NOT NULL,
	`coverage_percent` real NOT NULL,
	`metrics_json` text NOT NULL,
	`source_ledger_json` text NOT NULL,
	`calculation_version` text NOT NULL,
	`checksum` text NOT NULL,
	`r2_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_region_policy_snapshots`("id", "region_code", "district_code", "base_month", "status", "coverage_percent", "metrics_json", "source_ledger_json", "calculation_version", "checksum", "r2_key", "created_at") SELECT "id", "region_code", COALESCE("district_code", '_all'), "base_month", "status", "coverage_percent", "metrics_json", "source_ledger_json", "calculation_version", "checksum", "r2_key", "created_at" FROM `region_policy_snapshots`;--> statement-breakpoint
DROP TABLE `region_policy_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_region_policy_snapshots` RENAME TO `region_policy_snapshots`;--> statement-breakpoint
CREATE UNIQUE INDEX `region_policy_snapshot_unique_idx` ON `region_policy_snapshots` (`region_code`,`district_code`,`base_month`,`calculation_version`);--> statement-breakpoint
CREATE INDEX `region_policy_snapshot_region_idx` ON `region_policy_snapshots` (`region_code`,`district_code`);--> statement-breakpoint
CREATE TABLE `__new_sync_partitions` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text DEFAULT '_all' NOT NULL,
	`region_name` text NOT NULL,
	`district_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`next_run_at` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sync_partitions`("id", "region_code", "district_code", "region_name", "district_name", "status", "last_attempt_at", "last_success_at", "next_run_at", "failure_count", "last_error_code", "updated_at") SELECT "id", "region_code", COALESCE("district_code", '_all'), "region_name", "district_name", "status", "last_attempt_at", "last_success_at", "next_run_at", "failure_count", "last_error_code", "updated_at" FROM `sync_partitions`;--> statement-breakpoint
DROP TABLE `sync_partitions`;--> statement-breakpoint
ALTER TABLE `__new_sync_partitions` RENAME TO `sync_partitions`;--> statement-breakpoint
CREATE UNIQUE INDEX `sync_partitions_scope_idx` ON `sync_partitions` (`region_code`,`district_code`);--> statement-breakpoint
CREATE INDEX `sync_partitions_due_idx` ON `sync_partitions` (`next_run_at`,`status`);
