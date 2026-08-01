ALTER TABLE `field_evidence_registry` ADD `independent_audit_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `field_evidence_registry` ADD `approved_at` text;--> statement-breakpoint
ALTER TABLE `field_evidence_registry` ADD `approved_by` text;--> statement-breakpoint
ALTER TABLE `field_evidence_registry` ADD `audit_notes` text;--> statement-breakpoint
CREATE INDEX `field_evidence_audit_status_idx` ON `field_evidence_registry` (`independent_audit_status`,`evidence_type`);