import { NextRequest } from "next/server";
import { isKnownAdministrativeScope } from "@/lib/db/repository";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import { jsonResponse } from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { readRegionalGaps } from "@/lib/insights/regional-gaps";
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

  /* 이 지역에서 실제로 여행이 끊긴 이유. 기획안 6.5의 `감지된 공백`이다.
     D1 한 번의 질의이고 외부 호출을 쓰지 않는다. */
  const gapReport = await readRegionalGaps({
    regionCode: normalizedAreaCode,
    districtCode: normalizedDistrictCode,
  });

  const pack = await getRegionPack({
    areaCode: normalizedAreaCode,
    districtCode: normalizedDistrictCode,
  });
  if (pack) {
    const response = jsonResponse({
      ...pack,
      continuityGaps: gapReport,
      delivery: "versioned_region_pack",
      requestedScope: normalizedDistrictCode ? "district" : "region",
      deliveredScope: normalizedDistrictCode ? "district" : "region",
    });
    response.headers.set(
      "X-RateLimit-Remaining",
      String(durableRate.remaining),
    );
    return response;
  }

  /* 시군구 자료가 아직 동기화되지 않았을 때 시도 자료로 내려간다.
     예전에는 503으로 끝나서, 시군구를 고른 사용자는 아무것도 보지 못하고
     "운영 동기화 후 다시 확인해 주세요"라는 자기가 할 수 없는 안내만 받았다.
     숫자를 시군구 것처럼 보여 주지는 않고, 어느 범위의 값인지 함께 내려서
     화면이 그대로 밝히게 한다. */
  if (normalizedDistrictCode) {
    const regionPack = await getRegionPack({
      areaCode: normalizedAreaCode,
    });
    if (regionPack) {
      const response = jsonResponse({
        ...regionPack,
        continuityGaps: gapReport,
        delivery: "versioned_region_pack",
        requestedScope: "district",
        deliveredScope: "region",
        scopeNotice:
          "선택한 시군구의 검증 자료가 아직 준비되지 않아 시도 단위 공식 지표를 보여 드립니다. 아래 값은 시군구 값이 아닙니다.",
        scopeNoticeEn:
          "Verified data for the selected district is not ready yet, so these are province-level official indicators — not district figures.",
      });
      response.headers.set(
        "X-RateLimit-Remaining",
        String(durableRate.remaining),
      );
      return response;
    }
  }

  /* 공식 정책 지표는 아직 동기화되지 않았지만, **여행이 끊긴 이유**는 이어가가
     스스로 쌓은 자료라 지역팩과 무관하게 존재할 수 있다. 그것까지 숨기면 담당자는
     "이 지역은 볼 것이 없다"로 읽는다. 있는 것은 내려보내고, 없는 것은 없다고
     말한다. */
  if (gapReport.gaps.length > 0) {
    const partial = jsonResponse({
      scope: "nationwide",
      areaCode: normalizedAreaCode,
      districtCode: normalizedDistrictCode ?? null,
      status: "continuity_only",
      continuityGaps: gapReport,
      metrics: [],
      scopeNotice:
        "이 지역의 공식 정책 지표는 아직 동기화되지 않았습니다. 아래는 이어가가 실제 추천 요청에서 집계한 여행 연속성 공백입니다.",
    });
    partial.headers.set(
      "X-RateLimit-Remaining",
      String(durableRate.remaining),
    );
    return partial;
  }

  const response = jsonResponse(
    {
      error: {
        code: "REGION_PACK_NOT_READY",
        message:
          "이 지역의 검증 자료가 아직 준비되지 않았습니다. 다른 지역을 먼저 살펴봐 주세요.",
      },
    },
    { status: 503 },
  );
  response.headers.set("Retry-After", "300");
  return response;
}
