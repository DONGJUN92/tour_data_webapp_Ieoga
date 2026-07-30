import { NextRequest } from "next/server";
import { activateRecoveryExecution } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { recoveryApplySchema } from "@/lib/recovery/schema";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  const sessionId = request.cookies.get("ieoga_session")?.value;
  if (
    !/^[a-zA-Z0-9_-]{8,80}$/.test(runId) ||
    !sessionId ||
    !/^[a-f0-9-]{32,40}$/i.test(sessionId)
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
  });
  if (!activated.activated) {
    return jsonResponse(
      {
        error: {
          code: activated.reason,
          message:
            activated.reason === "NOT_FOUND"
              ? "이 세션의 복구안이나 원래 일정을 찾지 못했습니다."
              : activated.reason === "INVALID_STATE"
                ? "검증된 전체 경로를 실행 일정으로 만들 수 없습니다. 일정을 다시 확인해 주세요."
                : "현재 복구 일정을 적용하지 못했습니다.",
        },
      },
      {
        status:
          activated.reason === "NOT_FOUND"
            ? 404
            : activated.reason === "INVALID_STATE"
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
