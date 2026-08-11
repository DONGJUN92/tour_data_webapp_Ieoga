import { NextRequest } from "next/server";
import { z } from "zod";
import { createProofShare } from "@/lib/db/repository";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import {
  jsonResponse,
  readSessionId,
  requireSameOriginJsonMutation,
  requireSessionSigning,
} from "@/lib/http";

export const dynamic = "force-dynamic";

const shareSchema = z.object({
  runId: z.string().uuid(),
  optionId: z.string().min(10).max(220),
});

export async function POST(request: NextRequest) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const unsafeMutation = requireSameOriginJsonMutation(request);
  if (unsafeMutation) return unsafeMutation;
  const sessionId = readSessionId(request);
  if (!sessionId) {
    return jsonResponse(
      {
        error: {
          code: "SESSION_REQUIRED",
          message: "복구를 실행한 브라우저에서만 증명서를 공유할 수 있습니다.",
        },
      },
      { status: 401 },
    );
  }
  const rate = await allowDurableRequest(
    request,
    "proof-share-create",
    10,
  );
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: rate.unavailable
            ? "RATE_LIMIT_UNAVAILABLE"
            : "RATE_LIMITED",
          message: rate.unavailable
            ? "공유 생성 한도를 확인할 수 없어 안전하게 중단했습니다."
            : "공유 생성 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: rate.unavailable ? 503 : 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: { code: "INVALID_JSON", message: "요청 형식을 확인해주세요." } },
      { status: 400 },
    );
  }
  const parsed = shareSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_SHARE_REQUEST",
          message: "복구 실행과 선택안 식별자를 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  const result = await createProofShare({
    sessionId,
    runId: parsed.data.runId,
    optionId: parsed.data.optionId,
  });
  if (!result.created) {
    return jsonResponse(
      {
        error: {
          code: result.reason,
          message:
            result.reason === "INVALID_STATE"
              ? "안전 근거가 만료되었거나 일정이 변경되었습니다. 복구안을 다시 생성해 주세요."
              : result.reason === "NOT_FOUND"
              ? "공유할 수 있는 복구 결과를 찾지 못했습니다."
              : "현재 공유 링크를 만들지 못했습니다.",
        },
      },
      {
        status:
          result.reason === "NOT_FOUND"
            ? 404
            : result.reason === "INVALID_STATE"
              ? 409
              : 503,
      },
    );
  }

  const response = jsonResponse({
    status: "created",
    url: `/share/${result.token}`,
    expiresAt: result.expiresAt,
    proof: result.proof,
  });
  response.headers.set(
    "X-RateLimit-Remaining",
    String(rate.remaining),
  );
  return response;
}
