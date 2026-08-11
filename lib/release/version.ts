import { getRuntimeBinding, getRuntimeSecret } from "@/lib/runtime-env";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const VERSION_ID_PATTERN = /^[a-f0-9][a-f0-9-]{15,63}$/i;

export type WorkerVersionMetadata = {
  id?: unknown;
  tag?: unknown;
  timestamp?: unknown;
};

export type DeploymentVersionStatus = {
  configured: boolean;
  valid: boolean;
  releaseReady: boolean;
  commitSha: string | null;
  versionId: string | null;
  versionTag: string | null;
  versionTimestamp: string | null;
  expectedCommitSha: string | null;
  source: "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION";
};

export function deploymentVersionStatus(overrides?: {
  metadata?: WorkerVersionMetadata;
  expectedCommitSha?: string;
}): DeploymentVersionStatus {
  const metadata =
    overrides?.metadata ??
    getRuntimeBinding<WorkerVersionMetadata>("CF_VERSION_METADATA");
  const expectedCandidate =
    overrides?.expectedCommitSha ?? getRuntimeSecret("DEPLOYMENT_COMMIT_SHA");
  const expectedCommitSha =
    expectedCandidate && COMMIT_SHA_PATTERN.test(expectedCandidate)
      ? expectedCandidate.toLowerCase()
      : null;
  const versionId =
    typeof metadata?.id === "string" && VERSION_ID_PATTERN.test(metadata.id)
      ? metadata.id.toLowerCase()
      : null;
  const versionTag =
    typeof metadata?.tag === "string" && COMMIT_SHA_PATTERN.test(metadata.tag)
      ? metadata.tag.toLowerCase()
      : null;
  const versionTimestamp =
    typeof metadata?.timestamp === "string" &&
    Number.isFinite(Date.parse(metadata.timestamp))
      ? new Date(metadata.timestamp).toISOString()
      : null;
  const configured = Boolean(metadata || expectedCandidate);
  const valid = Boolean(
    versionId &&
      versionTag &&
      versionTimestamp &&
      expectedCommitSha &&
      versionTag === expectedCommitSha,
  );
  return {
    configured,
    valid,
    releaseReady: valid,
    commitSha: valid ? versionTag : null,
    versionId,
    versionTag,
    versionTimestamp,
    expectedCommitSha,
    source: "CF_VERSION_METADATA+DEPLOYMENT_COMMIT_SHA_ASSERTION",
  };
}
