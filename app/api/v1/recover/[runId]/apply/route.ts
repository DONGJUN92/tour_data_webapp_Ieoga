import { NextRequest } from "next/server";
import { activateRecoveryExecution } from "@/lib/db/repository";
import {
  jsonResponse,
  readSessionId,
  requireSameOriginJsonMutation,
  requireSessionSigning,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { recoveryApplySchema } from "@/lib/recovery/schema";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const unsafeMutation = requireSameOriginJsonMutation(request);
  if (unsafeMutation) return unsafeMutation;
  const pathSegments = request.nextUrl.pathname.split("/").filter(Boolean);
  const runId = pathSegments.at(-2) ?? "";
  const sessionId = readSessionId(request);
  if (
    !/^[a-zA-Z0-9_-]{8,80}$/.test(runId) ||
    !sessionId
  ) {
    return jsonResponse(
      {
        error: {
          code: "SESSION_REQUIRED",
          message: "복구를 실행한 브라우저에서만 일정에 적용할 수 있습니다.",
        },
      },
      { status: 401 },
    );
  }

  const rate = allowRequest(requestRateKey(request, "recovery-apply"), 30);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "일정 적용 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
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
        error: {
          code: "INVALID_JSON",
          message: "적용할 복구안 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const parsed = recoveryApplySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_RECOVERY_APPLICATION",
          message: "적용할 복구안을 다시 선택해 주세요.",
        },
      },
      { status: 400 },
    );
  }

  const activated = await activateRecoveryExecution({
    sessionId,
    runId,
    optionId: parsed.data.optionId,
    acknowledgeUnverifiedHours: parsed.data.acknowledgeUnverifiedHours,
  });
  if (!activated.activated) {
    return jsonResponse(
      {
        error: {
          code: activated.reason,
          message:
            activated.reason === "NOT_FOUND"
              ? "이 세션의 복구안이나 원래 일정을 찾지 못했습니다."
              : activated.reason === "ACKNOWLEDGEMENT_REQUIRED"
                /* 운영시간이라고 못박지 않는다. v5에서 이 문이 네 가지 공백
                   으로 넓어졌으므로, 집중률 예측을 확인하지 못한 곳에 "운영시간을
                   확인하지 못했다"고 적으면 그 문장이 거짓이 된다. 무엇을 확인하지
                   못했는지는 화면이 공백마다 따로 적는다. */
                ? "공식 정보로 확인하지 못한 조건이 있는 곳입니다. 안내를 읽고 직접 확인한 뒤에 적용할 수 있습니다."
              : activated.reason === "INVALID_STATE"
                ? "검증된 전체 경로를 실행 일정으로 만들 수 없습니다. 일정을 다시 확인해 주세요."
                : activated.reason === "UPSTREAM_UNAVAILABLE"
                  ? "적용 직전 공식 장소 정보를 다시 확인하지 못했습니다. 잠시 후 재시도해 주세요."
                : "현재 복구 일정을 적용하지 못했습니다.",
        },
      },
      {
        status:
          activated.reason === "NOT_FOUND"
            ? 404
            : activated.reason === "ACKNOWLEDGEMENT_REQUIRED" ||
                activated.reason === "INVALID_STATE"
              ? 409
              : 503,
      },
    );
  }

  return jsonResponse(
    {
      status: "activated",
      execution: activated.execution,
    },
    { status: 201 },
  );
}
