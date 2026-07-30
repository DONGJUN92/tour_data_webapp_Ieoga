import { getStoredHealthSnapshot } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { ktoServiceKeyConfigured } from "@/lib/kto/client";
import {
  externalProviderStatus,
  runtimeBindingStatus,
} from "@/lib/runtime-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const bindings = runtimeBindingStatus();
  const externalProviders = externalProviderStatus();
  const configured = ktoServiceKeyConfigured();
  let sources: Awaited<ReturnType<typeof getStoredHealthSnapshot>> = [];
  let databaseReadable = bindings.d1;
  if (bindings.d1) {
    try {
      sources = await getStoredHealthSnapshot();
    } catch {
      databaseReadable = false;
    }
  }
  const checkedAt = sources
    .map((source) => source.checkedAt)
    .sort()
    .at(-1);
  const stale =
    checkedAt !== undefined &&
    Date.now() - Date.parse(checkedAt) > 24 * 3_600_000;
  const errorCount = sources.filter(
    (source) => source.status === "error",
  ).length;
  const runtimeReady =
    configured && databaseReadable && bindings.r2;
  const usesSharedPublicProvider =
    externalProviders.reverseGeocoding === "public_shared" ||
    externalProviders.forwardGeocoding === "public_shared" ||
    externalProviders.walkingRouting === "public_shared" ||
    externalProviders.weather === "public_shared";
  const overall = !runtimeReady
    ? "unavailable"
    : sources.length === 0
      ? "not_checked"
      : stale ||
          errorCount > 0 ||
          sources.length < 8 ||
          usesSharedPublicProvider
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
      externalProviders: {
        ...externalProviders,
        releaseRequirement: usesSharedPublicProvider
          ? "configure_managed_forward_reverse_geocoding_routing_and_weather_endpoints"
          : "satisfied",
      },
      sourceHealth: {
        mode: "stored_ops_snapshot",
        expectedSourceCount: 8,
        sourceCount: sources.length,
        stale,
        checkedAt: checkedAt ?? null,
      },
      sources,
      checkedAt: checkedAt ?? null,
      responseGeneratedAt: new Date().toISOString(),
    },
    { status: runtimeReady ? 200 : 503 },
  );
}
