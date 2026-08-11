import { publicJsonResponse } from "@/lib/http";
import { deploymentVersionStatus } from "@/lib/release/version";

export const dynamic = "force-dynamic";

export function GET() {
  const deployment = deploymentVersionStatus();
  return publicJsonResponse(
    {
      releaseReady: deployment.releaseReady,
      releaseBuild: deployment.releaseReady,
      commitSha: deployment.commitSha,
      versionId: deployment.versionId,
      versionTag: deployment.versionTag,
      versionTimestamp: deployment.versionTimestamp,
      source: deployment.source,
    },
    { maxAge: 0, status: deployment.releaseReady ? 200 : 503 },
  );
}
