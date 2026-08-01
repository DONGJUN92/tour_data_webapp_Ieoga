import { NextRequest } from "next/server";
import { z } from "zod";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import { jsonResponse } from "@/lib/http";
import { resolveLocation } from "@/lib/location/resolver";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  latitude: z.number().min(32).max(39.8),
  longitude: z.number().min(124).max(132),
});

function minimizeCoordinate(value: number): number {
  return Number(value.toFixed(5));
}

export async function POST(request: NextRequest) {
  const rate = allowRequest(requestRateKey(request, "location-resolve"), 20);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "위치 확인 요청이 많습니다. 잠시 후 다시 시도해주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }

  const durableRate = await allowDurableRequest(
    request,
    "location-resolve",
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
            ? "위치 확인 요청 한도를 검증할 수 없어 안전하게 중단했습니다."
            : "위치 확인 요청이 많습니다. 잠시 후 다시 시도해주세요.",
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

  const payload = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_COORDINATE",
          message: "대한민국 범위의 위치 좌표를 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  const latitude = minimizeCoordinate(parsed.data.latitude);
  const longitude = minimizeCoordinate(parsed.data.longitude);
  const resolved = await resolveLocation(latitude, longitude);
  if (!resolved) {
    return jsonResponse(
      {
        error: {
          code: "LOCATION_UNRESOLVED",
          message:
            "현재 위치의 행정구역을 확인하지 못했습니다. 장소를 직접 입력해주세요.",
        },
      },
      { status: 422 },
    );
  }

  const response = jsonResponse({
    ...resolved,
    privacy:
      "소수점 다섯 자리로 줄인 현재 좌표는 행정구역 확인 제공자에 일시 전송되며 저장하지 않습니다.",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
