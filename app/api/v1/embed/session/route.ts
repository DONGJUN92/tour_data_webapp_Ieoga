import { NextRequest } from "next/server";
import {
  jsonResponse,
  requireSessionSigning,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { createEmbedSessionToken } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;

  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    origin !== expectedOrigin ||
    request.headers.get("x-ieoga-embed-bootstrap") !== "1" ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    return jsonResponse(
      {
        error: {
          code: "EMBED_BOOTSTRAP_FORBIDDEN",
          message: "허용된 이어가 위젯 화면에서만 세션을 시작할 수 있습니다.",
        },
      },
      { status: 403 },
    );
  }

  const rate = allowRequest(requestRateKey(request, "embed-session"), 30);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "위젯 세션 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }

  const session = createEmbedSessionToken();
  return jsonResponse({
    status: "ready",
    embedSessionToken: session.token,
    expiresAt: session.expiresAt,
    scope: "recover:open-window",
  });
}
