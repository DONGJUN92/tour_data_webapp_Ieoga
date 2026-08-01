import { releaseSecretTopologyStatus } from "@/lib/secret-policy";

export type ReleaseAuditorStatus = {
  configured: boolean;
  independent: boolean;
  releaseReady: boolean;
  reason:
    | "ready"
    | "auditor_key_below_policy"
    | "ops_key_below_policy"
    | "auditor_key_reuses_ops_key"
    | "auditor_key_not_distinct"
    | "ops_key_not_distinct";
};

export function releaseAuditorStatus(): ReleaseAuditorStatus {
  const topology = releaseSecretTopologyStatus();
  const auditor = topology.secrets.RELEASE_AUDITOR_API_KEY;
  const ops = topology.secrets.OPS_API_KEY;
  if (!auditor.qualityPolicyMet) {
    return {
      configured: auditor.configured,
      independent: false,
      releaseReady: false,
      reason: "auditor_key_below_policy",
    };
  }
  if (!ops.qualityPolicyMet) {
    return {
      configured: true,
      independent: false,
      releaseReady: false,
      reason: "ops_key_below_policy",
    };
  }
  if (auditor.duplicateWith.includes("OPS_API_KEY")) {
    return {
      configured: true,
      independent: false,
      releaseReady: false,
      reason: "auditor_key_reuses_ops_key",
    };
  }
  if (!auditor.distinct) {
    return {
      configured: true,
      independent: false,
      releaseReady: false,
      reason: "auditor_key_not_distinct",
    };
  }
  if (!ops.distinct) {
    return {
      configured: true,
      independent: false,
      releaseReady: false,
      reason: "ops_key_not_distinct",
    };
  }
  return {
    configured: true,
    independent: true,
    releaseReady: true,
    reason: "ready",
  };
}
