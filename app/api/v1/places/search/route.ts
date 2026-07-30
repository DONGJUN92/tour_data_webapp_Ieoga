import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonResponse } from "@/lib/http";
import { isOfficialRegionCode } from "@/lib/kto/registry";
import { searchPlaces } from "@/lib/location/place-search";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  keyword: z.string().trim().min(2).max(80),
  purpose: z
    .enum(["saved_stop", "current_origin"])
    .default("saved_stop"),
  fallback: z.enum(["auto", "force"]).default("auto"),
  areaCode: z
    .string()
    .refine(isOfficialRegionCode, "공식 시도 코드를 확인해 주세요.")
    .optional(),
  sigunguCode: z.string().regex(/^\d{3,5}$/).optional(),
  latitude: z.coerce.number().min(32).max(39.8).optional(),
  longitude: z.coerce.number().min(124).max(132).optional(),
});

export async function GET(request: NextRequest) {
  const rate = allowRequest(requestRateKey(request, "place-search"), 30);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }

  const parsed = querySchema.safeParse({
    keyword: request.nextUrl.searchParams.get("keyword") ?? "",
    purpose:
      request.nextUrl.searchParams.get("purpose") || "saved_stop",
    fallback:
      request.nextUrl.searchParams.get("fallback") || "auto",
    areaCode:
      request.nextUrl.searchParams.get("areaCode") || undefined,
    sigunguCode:
      request.nextUrl.searchParams.get("sigunguCode") || undefined,
    latitude:
      request.nextUrl.searchParams.get("latitude") || undefined,
    longitude:
      request.nextUrl.searchParams.get("longitude") || undefined,
  });
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_SEARCH",
          message: "장소명이나 주소를 두 글자 이상 입력해 주세요.",
        },
      },
      { status: 400 },
    );
  }

  const result = await searchPlaces({
    keyword: parsed.data.keyword,
    purpose: parsed.data.purpose,
    fallback: parsed.data.fallback,
    regionCode: parsed.data.areaCode,
    districtCode: parsed.data.sigunguCode,
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
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-RateLimit-Remaining", String(rate.remaining));
  return response;
}
