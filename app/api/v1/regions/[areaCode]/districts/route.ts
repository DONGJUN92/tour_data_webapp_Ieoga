import { getDistricts, getRegions } from "@/lib/kto/adapters";
import { isOfficialRegionCode } from "@/lib/kto/registry";
import { KtoError } from "@/lib/kto/types";
import { publicJsonResponse, safeErrorMessage } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ areaCode: string }> },
) {
  const { areaCode } = await context.params;
  if (!isOfficialRegionCode(areaCode)) {
    return publicJsonResponse(
      { error: { code: "INVALID_AREA_CODE", message: "시도 코드를 확인해주세요." } },
      { status: 400, maxAge: 0 },
    );
  }

  try {
    if (areaCode.length === 5) {
      const regionsResult = await getRegions();
      const region = regionsResult.items.find(
        (item) => String(item.code ?? "") === areaCode,
      );
      if (!region) {
        return publicJsonResponse(
          {
            error: {
              code: "UNKNOWN_AREA_CODE",
              message:
                "해당 5자리 지역 코드를 최신 공식 지역 목록에서 확인하지 못했습니다.",
            },
          },
          { status: 400, maxAge: 0 },
        );
      }
      const districts = region
        ? [
            {
              code: areaCode,
              rawCode: "",
              name: String(region.name ?? ""),
            },
          ]
        : [];
      return publicJsonResponse(
        {
          scope: "nationwide",
          areaCode,
          count: districts.length,
          districts,
          source: {
            api: regionsResult.audit.apiName,
            operation: regionsResult.audit.operation,
            status: regionsResult.audit.status,
            checkedAt: new Date().toISOString(),
          },
        },
        { maxAge: 3_600 },
      );
    }
    const result = await getDistricts(areaCode);
    const districts = result.items
      .map((item) => {
        const rawCode = String(item.code ?? "");
        return {
          code: `${areaCode}${rawCode}`,
          rawCode,
          name: String(item.name ?? ""),
        };
      })
      .filter((item) => item.rawCode && item.name);

    return publicJsonResponse(
      {
        scope: "nationwide",
        areaCode,
        count: districts.length,
        districts,
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
      {
        error: {
          code: "DISTRICTS_UNAVAILABLE",
          message: safeErrorMessage(status),
        },
      },
      { status, maxAge: 0 },
    );
  }
}
