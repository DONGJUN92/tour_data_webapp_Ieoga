CREATE TABLE `place_hours_snapshots` (
	`content_id` text PRIMARY KEY NOT NULL,
	`content_type_id` text NOT NULL,
	`source_modified_at` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `place_hours_snapshots_expiry_idx` ON `place_hours_snapshots` (`expires_at`);--> statement-breakpoint
CREATE TABLE `route_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`origin_cell` text NOT NULL,
	`destination_key` text NOT NULL,
	`payload` text NOT NULL,
	`calculated_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `route_snapshots_expiry_idx` ON `route_snapshots` (`expires_at`);