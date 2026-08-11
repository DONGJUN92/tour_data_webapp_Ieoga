import { getStoredHealthSnapshot } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { ktoServiceKeyConfigured } from "@/lib/kto/client";
import {
  HEALTH_REFRESH_INTERVAL_MS,
  HEALTH_STALE_AFTER_MS,
} from "@/lib/kto/health-refresh";
import { evaluateStoredKtoHealth } from "@/lib/kto/health-snapshot";
import {
  externalProviderStatus,
  runtimeBindingStatus,
} from "@/lib/runtime-readiness";
import { sessionSigningStatus } from "@/lib/session-cookie";
import { releaseAuditorStatus } from "@/lib/release/auditor";
import { releaseSecretTopologyStatus } from "@/lib/secret-policy";
import { deploymentVersionStatus } from "@/lib/release/version";
import { embedPolicyStatus } from "@/lib/embed-policy";
import {
  currentProviderConfigurations,
  evaluateProviderReadiness,
  getStoredProviderProbeSnapshots,
  PROVIDER_PROBE_REFRESH_INTERVAL_MS,
} from "@/lib/provider-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const bindings = runtimeBindingStatus();
  const externalProviders = externalProviderStatus();
  const sessionSigning = sessionSigningStatus();
  const independentAuditor = releaseAuditorStatus();
  const releaseSecrets = releaseSecretTopologyStatus();
  const deploymentVersion = deploymentVersionStatus();
  const embedPolicy = embedPolicyStatus();
  const configured = ktoServiceKeyConfigured();
  let sources: Awaited<ReturnType<typeof getStoredHealthSnapshot>> = [];
  let providerProbeStorageReadable = bindings.d1;
  let providerProbes = await evaluateProviderReadiness(
    currentProviderConfigurations(),
    [],
  );
  let databaseReadable = bindings.d1;
  if (bindings.d1) {
    try {
      sources = await getStoredHealthSnapshot();
    } catch {
      databaseReadable = false;
    }
    try {
      providerProbes = await evaluateProviderReadiness(
        currentProviderConfigurations(),
        await getStoredProviderProbeSnapshots(),
      );
    } catch {
      providerProbeStorageReadable = false;
    }
  }

  const sourceEvaluation = evaluateStoredKtoHealth(
    sources,
    HEALTH_STALE_AFTER_MS,
  );
  const checkedAt = sourceEvaluation.oldestCheckedAt;
  const stale = !sourceEvaluation.allFresh;
  const runtimeReady =
    configured &&
    databaseReadable &&
    bindings.r2 &&
    sessionSigning.available;
  const sharedPublicProviders = Object.entries(externalProviders)
    .filter(([, mode]) => mode === "public_shared")
    .map(([provider]) => provider);
  const usesSharedPublicProvider = sharedPublicProviders.length > 0;
  const overall = !runtimeReady
    ? "unavailable"
    : sources.length === 0
      ? "not_checked"
      : !sourceEvaluation.ready ||
          usesSharedPublicProvider ||
          !providerProbeStorageReadable ||
          !providerProbes.allReady ||
          !sessionSigning.releaseReady ||
          !independentAuditor.releaseReady ||
          !releaseSecrets.releaseReady ||
          !deploymentVersion.releaseReady ||
          !embedPolicy.releaseReady
        ? "degraded"
        : "ready";

  return jsonResponse(
    {
      overall,
      configured,
      scope: "nationwide",
      bindings: {
        d1: databaseReadable ? "ready" : "unavailable",
        r2: bindings.r2 ? "ready" : "unavailable",
      },
      sessionSigning,
      independentAuditor,
      releaseSecrets,
      deploymentVersion,
      embedPolicy,
      externalProviders: {
        ...externalProviders,
        sharedPublicProviders,
        probes: {
          ...providerProbes,
          storageReadable: providerProbeStorageReadable,
          refreshIntervalMs: PROVIDER_PROBE_REFRESH_INTERVAL_MS,
        },
        releaseRequirement: usesSharedPublicProvider
          ? "configure_managed_endpoints_for_each_listed_shared_public_provider"
          : providerProbes.allReady && providerProbeStorageReadable
            ? "satisfied"
            : "run_authenticated_provider_probe_refresh_and_resolve_failures",
      },
      sourceHealth: {
        mode: "stored_scheduled_snapshot",
        ...sourceEvaluation,
        refreshIntervalMs: HEALTH_REFRESH_INTERVAL_MS,
        staleAfterMs: HEALTH_STALE_AFTER_MS,
        stale,
        checkedAt: checkedAt ?? null,
      },
      sources,
      checkedAt: checkedAt ?? null,
      stale,
      responseGeneratedAt: new Date().toISOString(),
    },
    { status: overall === "ready" ? 200 : 503 },
  );
}
