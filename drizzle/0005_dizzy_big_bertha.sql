CREATE TABLE `journey_execution_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`original_node_id` text,
	`role` text NOT NULL,
	`content_id` text,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`scheduled_at` text,
	`estimated_arrival_at` text,
	`duration_minutes` integer,
	`location_label` text,
	`latitude` real,
	`longitude` real,
	`locked` integer DEFAULT false NOT NULL,
	`reservation` integer DEFAULT false NOT NULL,
	`verification_status` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`arrived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `journey_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journey_execution_steps_sequence_idx` ON `journey_execution_steps` (`execution_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `journey_execution_steps_status_idx` ON `journey_execution_steps` (`execution_id`,`status`);--> statement-breakpoint
CREATE TABLE `journey_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`base_itinerary_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`source_option_id` text NOT NULL,
	`version_key` text NOT NULL,
	`active_session_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`current_step_sequence` integer DEFAULT 0 NOT NULL,
	`next_fixed_step_sequence` integer NOT NULL,
	`activated_at` text NOT NULL,
	`outcome_prompt_at` text NOT NULL,
	`contract_met_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_itinerary_id`) REFERENCES `itineraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `recovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_option_id`) REFERENCES `recovery_options`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journey_executions_version_idx` ON `journey_executions` (`version_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `journey_executions_active_session_idx` ON `journey_executions` (`active_session_key`);--> statement-breakpoint
CREATE INDEX `journey_executions_session_idx` ON `journey_executions` (`session_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `journey_executions_run_idx` ON `journey_executions` (`source_run_id`);