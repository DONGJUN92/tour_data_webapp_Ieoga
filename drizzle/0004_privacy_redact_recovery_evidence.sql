DELETE FROM `proof_shares`;--> statement-breakpoint
UPDATE `recovery_options`
SET
	`route_evidence_json` = CASE
		WHEN `route_evidence_json` IS NULL THEN NULL
		ELSE '{"status":"privacy_redacted","reason":"legacy_raw_route_evidence_removed"}'
	END,
	`continuity_proof_json` = CASE
		WHEN `continuity_proof_json` IS NULL THEN NULL
		ELSE '{"privacyStatus":"legacy_raw_evidence_removed","routeEvidence":{"status":"privacy_redacted","reason":"legacy_raw_route_evidence_removed"}}'
	END;--> statement-breakpoint
UPDATE `recovery_runs`
SET `decision_proof_json` = CASE
	WHEN `decision_proof_json` IS NULL THEN NULL
	ELSE '{"privacyStatus":"legacy_raw_evidence_removed","routeEvidence":{"status":"privacy_redacted","reason":"legacy_raw_route_evidence_removed"}}'
END;
