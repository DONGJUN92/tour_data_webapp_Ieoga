import { NextRequest } from "next/server";
import { isKnownAdministrativeScope } from "@/lib/db/repository";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import { jsonResponse } from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { getRegionPack } from "@/lib/storage/region-packs";
import {
  analysisDistrictCode,
  analysisRegionCode,
  districtBelongsToRegion,
  isOfficialRegionCode,
} from "@/lib/kto/registry";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ areaCode: string }> },
) {
  const { areaCode } = await context.params;
  const districtCode =
    request.nextUrl.searchParams.get("sigunguCode") || undefined;
  if (
    !isOfficialRegionCode(areaCode) ||
    (districtCode &&
      !districtBelongsToRegion(areaCode, districtCode))
  ) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_REGION_SCOPE",
          message: "시도·시군구 코드를 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }
  const normalizedAreaCode = analysisRegionCode(areaCode)!;
  const normalizedDistrictCode = analysisDistrictCode(
    areaCode,
    districtCode,
  );

  const rate = allowRequest(requestRateKey(request, "insights"), 10);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "정책 데이터 조회가 많습니다. 잠시 후 다시 시도해주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }
  const durableRate = await allowDurableRequest(
    request,
    "insights-region",
    20,
  );
  if (!durableRate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: durableRate.unavailable
            ? "RATE_LIMIT_UNAVAILABLE"
            : "RATE_LIMITED",
          message: durableRate.unavailable
            ? "정책 조회 한도를 확인할 수 없어 안전하게 중단했습니다. 잠시 후 다시 시도해 주세요."
            : "정책 데이터 조회가 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: durableRate.unavailable ? 503 : 429 },
    );
    response.headers.set(
      "Retry-After",
      String(durableRate.retryAfterSeconds),
    );
    return response;
  }

  if (normalizedDistrictCode) {
    try {
      const known = await isKnownAdministrativeScope({
        regionCode: normalizedAreaCode,
        districtCode: normalizedDistrictCode,
      });
      if (!known) {
        return jsonResponse(
          {
            error: {
              code: "UNKNOWN_REGION_SCOPE",
              message:
                "해당 시군구는 선택한 시도에 속하는 공식 활성 지역으로 확인되지 않습니다.",
            },
          },
          { status: 400 },
        );
      }
    } catch {
      return jsonResponse(
        {
          error: {
            code: "REGION_REFERENCE_UNAVAILABLE",
            message:
              "공식 행정구역 기준정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          },
        },
        { status: 503 },
      );
    }
  }

  const pack = await getRegionPack({
    areaCode: normalizedAreaCode,
    districtCode: normalizedDistrictCode,
  });
  if (pack) {
    const response = jsonResponse({
      ...pack,
      delivery: "versioned_region_pack",
    });
    response.headers.set(
      "X-RateLimit-Remaining",
      String(durableRate.remaining),
    );
    return response;
  }

  const response = jsonResponse(
    {
      error: {
        code: "REGION_PACK_NOT_READY",
        message:
          "검증된 지역 인사이트 팩이 아직 준비되지 않았습니다. 운영 동기화 후 다시 확인해 주세요.",
      },
    },
    { status: 503 },
  );
  response.headers.set("Retry-After", "300");
  return response;
}
