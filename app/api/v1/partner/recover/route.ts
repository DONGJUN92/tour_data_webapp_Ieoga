import { NextRequest } from "next/server";
import { authenticatePartner } from "@/lib/auth";
import { getRequestId, jsonResponse } from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { recoverTrip } from "@/lib/recovery/engine";
import { recoveryRequestSchema } from "@/lib/recovery/schema";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const auth = await authenticatePartner(
    request.headers.get("authorization"),
  );
  if (auth === "missing_configuration") {
    return jsonResponse(
      {
        requestId,
        error: {
          code: "PARTNER_API_DISABLED",
          message: "파트너 API가 아직 운영 환경에 설정되지 않았습니다.",
        },
      },
      { status: 503 },
    );
  }
  if (auth !== "authorized") {
    return jsonResponse(
      {
        requestId,
        error: {
          code: "UNAUTHORIZED",
          message: "유효한 Bearer 인증이 필요합니다.",
        },
      },
      { status: 401 },
    );
  }

  const rate = allowRequest(requestRateKey(request, "partner-recover"), 60);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        requestId,
        error: {
          code: "RATE_LIMITED",
          message: "파트너 호출 한도를 초과했습니다.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        requestId,
        error: { code: "INVALID_JSON", message: "요청 형식을 확인해주세요." },
      },
      { status: 400 },
    );
  }
  const parsed = recoveryRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        requestId,
        error: {
          code: "INVALID_RECOVERY_REQUEST",
          message: "복구 요청값을 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  const result = await recoverTrip(parsed.data, requestId);
  const response = jsonResponse(result, {
    status: result.status === "upstream_unavailable" ? 503 : 200,
  });
  response.headers.set("X-Request-ID", requestId);
  response.headers.set("X-RateLimit-Remaining", String(rate.remaining));
  return response;
}
