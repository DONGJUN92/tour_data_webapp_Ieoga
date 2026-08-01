import { NextRequest } from "next/server";
import { isKnownAdministrativeScope } from "@/lib/db/repository";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import { jsonResponse } from "@/lib/http";
import { placeSearchQuerySchema } from "@/lib/location/place-query";
import { searchPlaces } from "@/lib/location/place-search";
import {
  analysisDistrictCode,
  analysisRegionCode,
} from "@/lib/kto/registry";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function validationError(
  issues: Array<{ path: PropertyKey[]; message: string }>,
) {
  return jsonResponse(
    {
      error: {
        code: "INVALID_SEARCH",
        message: "장소명과 위치 조건을 확인해 주세요.",
        fields: issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    },
    { status: 400 },
  );
}

async function executeSearch(request: NextRequest, input: unknown) {
  const burstRate = allowRequest(
    requestRateKey(request, "place-search"),
    30,
  );
  if (!burstRate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set(
      "Retry-After",
      String(burstRate.retryAfterSeconds),
    );
    return response;
  }

  const durableRate = await allowDurableRequest(
    request,
    "place-search",
    30,
  );
  if (!durableRate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: durableRate.unavailable
            ? "RATE_LIMIT_UNAVAILABLE"
            : "RATE_LIMITED",
          message: durableRate.unavailable
            ? "검색 요청 한도를 확인할 수 없어 안전하게 중단했습니다."
            : "검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
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

  const parsed = placeSearchQuerySchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues);
  }

  const normalizedRegionCode = analysisRegionCode(
    parsed.data.areaCode,
  );
  const normalizedDistrictCode = analysisDistrictCode(
    parsed.data.areaCode,
    parsed.data.sigunguCode,
  );
  if (normalizedRegionCode && normalizedDistrictCode) {
    try {
      const known = await isKnownAdministrativeScope({
        regionCode: normalizedRegionCode,
        districtCode: normalizedDistrictCode,
      });
      if (!known) {
        return jsonResponse(
          {
            error: {
              code: "UNKNOWN_REGION_SCOPE",
              message:
                "선택한 시군구를 최신 공식 행정구역 기준표에서 확인하지 못했습니다.",
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
              "공식 행정구역 기준표를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          },
        },
        { status: 503 },
      );
    }
  }

  const result = await searchPlaces({
    keyword: parsed.data.keyword,
    purpose: parsed.data.purpose,
    fallback: parsed.data.fallback,
    regionCode: normalizedRegionCode,
    districtCode: normalizedDistrictCode,
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
  });
  if (!result.places.length && result.ktoStatus === "unavailable") {
    return jsonResponse(
      {
        error: {
          code: "PLACE_SEARCH_UNAVAILABLE",
          message:
            "공식 관광정보와 대체 장소검색을 모두 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 503 },
    );
  }

  const response = jsonResponse({
    query: parsed.data.keyword,
    purpose: parsed.data.purpose,
    places: result.places,
    totalCount: result.places.length,
    searchPath: {
      primary: "KorService2.searchKeyword2",
      ktoStatus: result.ktoStatus,
      fallbackUsed: result.usedFallback,
      fallbackProvider: result.fallbackProvider ?? null,
    },
  });
  response.headers.set(
    "X-RateLimit-Remaining",
    String(Math.min(burstRate.remaining, durableRate.remaining)),
  );
  return response;
}

export async function GET(request: NextRequest) {
  if (
    request.nextUrl.searchParams.has("latitude") ||
    request.nextUrl.searchParams.has("longitude")
  ) {
    return jsonResponse(
      {
        error: {
          code: "SENSITIVE_QUERY_PARAMETERS_FORBIDDEN",
          message:
            "현재 위치 좌표는 URL로 전송할 수 없습니다. JSON POST 요청을 사용해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  return executeSearch(request, {
    keyword: request.nextUrl.searchParams.get("keyword") ?? "",
    purpose:
      request.nextUrl.searchParams.get("purpose") || "saved_stop",
    fallback:
      request.nextUrl.searchParams.get("fallback") || "auto",
    areaCode:
      request.nextUrl.searchParams.get("areaCode") || undefined,
    sigunguCode:
      request.nextUrl.searchParams.get("sigunguCode") || undefined,
  });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error: {
          code: "INVALID_JSON",
          message: "요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  return executeSearch(request, body);
}
