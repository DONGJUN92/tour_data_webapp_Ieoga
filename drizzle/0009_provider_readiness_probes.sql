CREATE TABLE `provider_probe_snapshots` (
	`provider` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`configuration_fingerprint` text NOT NULL,
	`endpoint_count` integer NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`checked_at` text NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `provider_probe_status_idx` ON `provider_probe_snapshots` (`status`,`checked_at`);