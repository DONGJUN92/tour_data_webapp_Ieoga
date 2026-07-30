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
        status: "available_on_demand",
        coverage: null,
        metrics: null,
        sourceDate: null,
      }))
      .filter((item) => item.code && item.name);

    return publicJsonResponse(
      {
        scope: "nationwide",
        officialRegionCount: regions.length,
        regions,
        notice:
          "각 지역을 선택하면 한국관광공사 정책 OpenAPI 4종의 최신 가용 기준월을 실시간 조회합니다. 미조회 지역에 임의 점수를 채우지 않습니다.",
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
