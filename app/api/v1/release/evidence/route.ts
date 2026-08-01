import { getStoredHealthSnapshot } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { ktoServiceKeyConfigured } from "@/lib/kto/client";
import { HEALTH_STALE_AFTER_MS } from "@/lib/kto/health-refresh";
import { evaluateStoredKtoHealth } from "@/lib/kto/health-snapshot";
import { buildLaunchEvidenceReport } from "@/lib/release/evidence";
import { getFieldEvidenceSummaries } from "@/lib/release/field-evidence";
import {
  externalProviderStatus,
  runtimeBindingStatus,
} from "@/lib/runtime-readiness";
import { sessionSigningStatus } from "@/lib/session-cookie";
import { releaseAuditorStatus } from "@/lib/release/auditor";
import { releaseSecretTopologyStatus } from "@/lib/secret-policy";
import {
  currentProviderConfigurations,
  evaluateProviderReadiness,
  getStoredProviderProbeSnapshots,
} from "@/lib/provider-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const bindings = runtimeBindingStatus();
  const providers = externalProviderStatus();
  const sessionSigning = sessionSigningStatus();
  const independentAuditor = releaseAuditorStatus();
  const releaseSecrets = releaseSecretTopologyStatus();
  let sources: Awaited<ReturnType<typeof getStoredHealthSnapshot>> = [];
  let fieldEvidence: Awaited<
    ReturnType<typeof getFieldEvidenceSummaries>
  > = {};
  let providerProbes = await evaluateProviderReadiness(
    currentProviderConfigurations(),
    [],
  );

  if (bindings.d1) {
    try {
      sources = await getStoredHealthSnapshot();
    } catch {
      sources = [];
    }
    try {
      fieldEvidence = await getFieldEvidenceSummaries();
    } catch {
      fieldEvidence = {};
    }
    try {
      providerProbes = await evaluateProviderReadiness(
        currentProviderConfigurations(),
        await getStoredProviderProbeSnapshots(),
      );
    } catch {
      // Missing or unreadable probe evidence must remain a release blocker.
    }
  }

  const sourceHealth = evaluateStoredKtoHealth(
    sources,
    HEALTH_STALE_AFTER_MS,
  );
  const checkedAt = sourceHealth.oldestCheckedAt;
  const report = buildLaunchEvidenceReport({
    ktoConfigured: ktoServiceKeyConfigured(),
    d1Ready: bindings.d1,
    r2Ready: bindings.r2,
    sourceHealthCount: sourceHealth.requiredPresentCount,
    sourceHealthErrorCount: sourceHealth.errorSources.length,
    sourceHealthStale: !sourceHealth.allFresh,
    providers,
    providerProbesReady: providerProbes.allReady,
    sessionSigningReady: sessionSigning.releaseReady,
    independentAuditorReady: independentAuditor.releaseReady,
    releaseSecretsReady: releaseSecrets.releaseReady,
    fieldEvidence,
  });

  return jsonResponse(
    {
      report,
      runtime: {
        sourceHealthCheckedAt: checkedAt ?? null,
        sourceHealth,
        providerModes: providers,
        providerProbes,
        sessionSigning,
        independentAuditor,
        releaseSecrets,
      },
    },
    { status: 200 },
  );
}
