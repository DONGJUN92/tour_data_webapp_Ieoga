CREATE TABLE `resilience_mission_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mission_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`note` text,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `resilience_missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resilience_mission_events_mission_idx` ON `resilience_mission_events` (`mission_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `resilience_missions` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text DEFAULT '_all' NOT NULL,
	`mission_type` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`action_text` text NOT NULL,
	`evidence_json` text NOT NULL,
	`interventions_json` text NOT NULL,
	`recommended_plan_json` text NOT NULL,
	`baseline_value` real,
	`current_value` real,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`minimum_sample_size` integer DEFAULT 30 NOT NULL,
	`privacy_state` text NOT NULL,
	`policy_base_month` text,
	`calculation_version` text NOT NULL,
	`first_detected_at` text NOT NULL,
	`last_evaluated_at` text NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resilience_missions_scope_type_idx` ON `resilience_missions` (`region_code`,`district_code`,`mission_type`,`calculation_version`);--> statement-breakpoint
CREATE INDEX `resilience_missions_status_idx` ON `resilience_missions` (`status`,`priority`,`last_evaluated_at`);--> statement-breakpoint
CREATE INDEX `resilience_missions_scope_idx` ON `resilience_missions` (`region_code`,`district_code`);