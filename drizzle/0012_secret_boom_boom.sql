CREATE TABLE `regional_gap_counters` (
	`id` text PRIMARY KEY NOT NULL,
	`region_code` text NOT NULL,
	`district_code` text DEFAULT '_all' NOT NULL,
	`reason_code` text NOT NULL,
	`day_part` text NOT NULL,
	`incident` text NOT NULL,
	`audience` text NOT NULL,
	`rejection_count` integer DEFAULT 0 NOT NULL,
	`observation_count` integer DEFAULT 0 NOT NULL,
	`empty_result_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `regional_gap_scope_idx` ON `regional_gap_counters` (`region_code`,`district_code`,`reason_code`,`day_part`,`incident`,`audience`);--> statement-breakpoint
CREATE INDEX `regional_gap_region_idx` ON `regional_gap_counters` (`region_code`,`last_seen_at`);