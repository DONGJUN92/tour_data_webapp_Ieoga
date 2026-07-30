CREATE TABLE `itineraries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Seoul' NOT NULL,
	`audience` text DEFAULT 'general' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`node_count` integer DEFAULT 0 NOT NULL,
	`locked_node_count` integer DEFAULT 0 NOT NULL,
	`analytics_eligible` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `itineraries_session_idx` ON `itineraries` (`session_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `itineraries_status_idx` ON `itineraries` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `itinerary_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`itinerary_id` text NOT NULL,
	`client_node_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`start_at` text,
	`end_at` text,
	`duration_minutes` integer,
	`locked` integer DEFAULT false NOT NULL,
	`reservation` integer DEFAULT false NOT NULL,
	`location_label` text,
	`latitude` real,
	`longitude` real,
	`region_code` text,
	`district_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `itinerary_nodes_client_idx` ON `itinerary_nodes` (`itinerary_id`,`client_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `itinerary_nodes_sequence_idx` ON `itinerary_nodes` (`itinerary_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `itinerary_nodes_schedule_idx` ON `itinerary_nodes` (`itinerary_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `recovery_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`option_id` text,
	`session_id` text NOT NULL,
	`event` text NOT NULL,
	`occurred_at` text NOT NULL,
	`actual_arrival_at` text,
	`arrived_on_time` integer,
	`reason_code` text,
	`changed_node_count` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `recovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_id`) REFERENCES `recovery_options`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_outcomes_run_idx` ON `recovery_outcomes` (`run_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `recovery_outcomes_session_idx` ON `recovery_outcomes` (`session_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `recovery_outcomes_event_idx` ON `recovery_outcomes` (`event`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `changed_node_count` integer;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `next_fixed_status` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `arrival_buffer_minutes` integer;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `route_evidence_json` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `schedule_diff_json` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `continuity_proof_json` text;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `itinerary_id` text REFERENCES itineraries(id);--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `disrupted_node_id` text;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `next_fixed_node_id` text;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `recovery_mode` text DEFAULT 'proximity_fallback' NOT NULL;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `changed_node_count` integer;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `locked_node_count` integer;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `locked_nodes_preserved` integer;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `next_fixed_preserved` integer;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `decision_proof_json` text;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `counterfactual_json` text;--> statement-breakpoint
CREATE INDEX `recovery_runs_itinerary_idx` ON `recovery_runs` (`itinerary_id`,`created_at`);