CREATE TABLE `administrative_areas` (
	`code` text PRIMARY KEY NOT NULL,
	`parent_code` text,
	`name` text NOT NULL,
	`level` text NOT NULL,
	`code_version` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`source_updated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `administrative_areas_parent_idx` ON `administrative_areas` (`parent_code`);--> statement-breakpoint
CREATE INDEX `administrative_areas_level_idx` ON `administrative_areas` (`level`);--> statement-breakpoint
CREATE TABLE `api_audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text,
	`request_id` text NOT NULL,
	`api_name` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`latency_ms` integer NOT NULL,
	`result_count` integer DEFAULT 0 NOT NULL,
	`source_reference_date` text,
	`fields_used_json` text DEFAULT '[]' NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `recovery_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `api_audit_run_idx` ON `api_audit_logs` (`run_id`);--> statement-breakpoint
CREATE INDEX `api_audit_request_idx` ON `api_audit_logs` (`request_id`);--> statement-breakpoint
CREATE INDEX `api_audit_source_idx` ON `api_audit_logs` (`api_name`,`created_at`);--> statement-breakpoint
CREATE TABLE `consent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`action` text NOT NULL,
	`consent_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `consent_events_session_idx` ON `consent_events` (`session_id`);--> statement-breakpoint
CREATE TABLE `partner_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`daily_limit` integer DEFAULT 500 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partner_clients_key_idx` ON `partner_clients` (`key_hash`);--> statement-breakpoint
CREATE TABLE `partner_usage_daily` (
	`client_id` text NOT NULL,
	`usage_date` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `partner_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partner_usage_unique_idx` ON `partner_usage_daily` (`client_id`,`usage_date`);--> statement-breakpoint
CREATE TABLE `proof_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`option_id` text,
	`token_hash` text NOT NULL,
	`proof_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `recovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_id`) REFERENCES `recovery_options`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proof_shares_token_idx` ON `proof_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `proof_shares_run_idx` ON `proof_shares` (`run_id`);--> statement-breakpoint
CREATE TABLE `recovery_options` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`rank` integer NOT NULL,
	`content_id` text,
	`title` text NOT NULL,
	`content_type_id` text,
	`status` text NOT NULL,
	`score` real NOT NULL,
	`distance_bucket` text NOT NULL,
	`travel_minutes_bucket` text NOT NULL,
	`accessibility_status` text NOT NULL,
	`crowd_status` text NOT NULL,
	`source_names_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `recovery_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_options_rank_idx` ON `recovery_options` (`run_id`,`rank`);--> statement-breakpoint
CREATE INDEX `recovery_options_content_idx` ON `recovery_options` (`content_id`);--> statement-breakpoint
CREATE TABLE `recovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`incident` text NOT NULL,
	`audience` text NOT NULL,
	`region_code` text,
	`district_code` text,
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
CREATE INDEX `recovery_runs_session_idx` ON `recovery_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `recovery_runs_region_idx` ON `recovery_runs` (`region_code`,`district_code`);--> statement-breakpoint
CREATE INDEX `recovery_runs_started_idx` ON `recovery_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `region_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text,
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
CREATE UNIQUE INDEX `region_packs_object_idx` ON `region_packs` (`object_key`);--> statement-breakpoint
CREATE INDEX `region_packs_scope_idx` ON `region_packs` (`region_code`,`district_code`,`activated_at`);--> statement-breakpoint
CREATE TABLE `region_policy_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text,
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
CREATE UNIQUE INDEX `region_policy_snapshot_unique_idx` ON `region_policy_snapshots` (`region_code`,`district_code`,`base_month`,`calculation_version`);--> statement-breakpoint
CREATE INDEX `region_policy_snapshot_region_idx` ON `region_policy_snapshots` (`region_code`,`district_code`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`analytics_consent` integer DEFAULT false NOT NULL,
	`consent_version` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `source_health` (
	`source_name` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`result_count` integer NOT NULL,
	`source_reference_date` text,
	`checked_at` text NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE TABLE `sync_partitions` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text,
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
CREATE UNIQUE INDEX `sync_partitions_scope_idx` ON `sync_partitions` (`region_code`,`district_code`);--> statement-breakpoint
CREATE INDEX `sync_partitions_due_idx` ON `sync_partitions` (`next_run_at`,`status`);