ALTER TABLE `journey_executions` ADD `contract_missed_at` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `safety_contract_version` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `availability_status` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `availability_checked_at` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `visit_start_at` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `visit_end_at` text;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `confirmation_required` integer;--> statement-breakpoint
ALTER TABLE `recovery_options` ADD `evidence_gap_count` integer;--> statement-breakpoint
ALTER TABLE `recovery_runs` ADD `itinerary_impact_hash` text;