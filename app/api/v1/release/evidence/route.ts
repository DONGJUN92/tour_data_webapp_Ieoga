import { getStoredHealthSnapshot } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { ktoServiceKeyConfigured } from "@/lib/kto/client";
import { buildLaunchEvidenceReport } from "@/lib/release/evidence";
import {
  externalProviderStatus,
  runtimeBindingStatus,
} from "@/lib/runtime-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const bindings = runtimeBindingStatus();
  const providers = externalProviderStatus();
  let sources: Awaited<ReturnType<typeof getStoredHealthSnapshot>> = [];

  if (bindings.d1) {
    try {
      sources = await getStoredHealthSnapshot();
    } catch {
      sources = [];
    }
  }

  const checkedAt = sources
    .map((source) => source.checkedAt)
    .sort()
    .at(-1);
  const sourceHealthStale =
    !checkedAt ||
    Date.now() - Date.parse(checkedAt) > 24 * 3_600_000;
  const report = buildLaunchEvidenceReport({
    ktoConfigured: ktoServiceKeyConfigured(),
    d1Ready: bindings.d1,
    r2Ready: bindings.r2,
    sourceHealthCount: sources.length,
    sourceHealthErrorCount: sources.filter(
      (source) => source.status === "error",
    ).length,
    sourceHealthStale,
    providers,
  });

  return jsonResponse(
    {
      report,
      runtime: {
        sourceHealthCheckedAt: checkedAt ?? null,
        providerModes: providers,
      },
    },
    { status: 200 },
  );
}
