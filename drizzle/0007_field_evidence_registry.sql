CREATE TABLE `durable_rate_limit_windows` (
	`key` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`reset_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `durable_rate_limit_expiry_idx` ON `durable_rate_limit_windows` (`expires_at`);--> statement-breakpoint
CREATE TABLE `field_evidence_registry` (
	`id` text PRIMARY KEY NOT NULL,
	`evidence_type` text NOT NULL,
	`sample_size` integer NOT NULL,
	`regions_json` text DEFAULT '[]' NOT NULL,
	`metrics_json` text DEFAULT '{}' NOT NULL,
	`artifact_reference` text NOT NULL,
	`reviewers_json` text DEFAULT '[]' NOT NULL,
	`measured_at` text NOT NULL,
	`reviewed_at` text NOT NULL,
	`validated` integer DEFAULT false NOT NULL,
	`validation_errors_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `field_evidence_type_date_idx` ON `field_evidence_registry` (`evidence_type`,`reviewed_at`);--> statement-breakpoint
CREATE INDEX `field_evidence_validated_idx` ON `field_evidence_registry` (`validated`,`evidence_type`);--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `application_snapshot_json` text;