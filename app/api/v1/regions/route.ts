import { getRegions } from "@/lib/kto/adapters";
import { KtoError } from "@/lib/kto/types";
import { publicJsonResponse, safeErrorMessage } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getRegions();
    const regions = result.items
      .map((item) => ({
        code: String(item.code ?? ""),
        name: String(item.name ?? ""),
      }))
      .filter((item) => item.code && item.name);

    return publicJsonResponse(
      {
        scope: "nationwide",
        count: regions.length,
        regions,
        source: {
          api: result.audit.apiName,
          operation: result.audit.operation,
          status: result.audit.status,
          checkedAt: new Date().toISOString(),
        },
      },
      { maxAge: 3_600 },
    );
  } catch (error) {
    const status = error instanceof KtoError ? error.status : 503;
    return publicJsonResponse(
      { error: { code: "REGIONS_UNAVAILABLE", message: safeErrorMessage(status) } },
      { status, maxAge: 0 },
    );
  }
}
