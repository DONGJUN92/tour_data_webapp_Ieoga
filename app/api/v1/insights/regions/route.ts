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
        status: "scheduled_region_pack",
        coverage: null,
        metrics: null,
        sourceDate: result.audit.sourceReferenceDate ?? null,
      }))
      .filter((item) => item.code && item.name);

    return publicJsonResponse(
      {
        scope: "nationwide",
        officialRegionCount: regions.length,
        regions,
        notice:
          "지역 상세는 운영 동기화가 생성한 최신 검증 지역팩을 읽기 전용으로 제공합니다. 준비되지 않은 지역은 실시간 계산하거나 임의 점수로 채우지 않습니다.",
        detailDelivery: "scheduled_versioned_region_pack",
        source: result.audit,
      },
      { maxAge: 3_600 },
    );
  } catch (error) {
    const status = error instanceof KtoError ? error.status : 503;
    return publicJsonResponse(
      {
        error: {
          code: "INSIGHT_REGIONS_UNAVAILABLE",
          message: safeErrorMessage(status),
        },
      },
      { status, maxAge: 0 },
    );
  }
}
