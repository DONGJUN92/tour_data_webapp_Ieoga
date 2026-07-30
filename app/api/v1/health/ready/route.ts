import { getStoredHealthSnapshot } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { ktoServiceKeyConfigured } from "@/lib/kto/client";
import {
  HEALTH_REFRESH_INTERVAL_MS,
  HEALTH_STALE_AFTER_MS,
  isOlderThan,
  refreshKtoHealth,
} from "@/lib/kto/health-refresh";
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

  /* The scheduled probe is the primary refresh path. If it has not run — a
     fresh deployment, or a paused cron — probe inline rather than reporting a
     months-old snapshot as if it described the current service. The helper
     rate-limits itself, so this cannot become a per-request call storm. */
  let refreshMode: "scheduled" | "on_read" = "scheduled";
  if (
    configured &&
    databaseReadable &&
    isOlderThan(
      sources.map((source) => source.checkedAt).sort().at(-1),
      HEALTH_REFRESH_INTERVAL_MS,
    )
  ) {
    try {
      if (await refreshKtoHealth()) {
        refreshMode = "on_read";
        sources = await getStoredHealthSnapshot();
      }
    } catch {
      /* Keep serving the stored snapshot; `stale` below still flags it. */
    }
  }

  const checkedAt = sources
    .map((source) => source.checkedAt)
    .sort()
    .at(-1);
  const stale = isOlderThan(checkedAt, HEALTH_STALE_AFTER_MS);
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
        mode:
          refreshMode === "on_read"
            ? "live_probe_on_read"
            : "scheduled_live_probe",
        expectedSourceCount: 8,
        sourceCount: sources.length,
        refreshIntervalMs: HEALTH_REFRESH_INTERVAL_MS,
        staleAfterMs: HEALTH_STALE_AFTER_MS,
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
