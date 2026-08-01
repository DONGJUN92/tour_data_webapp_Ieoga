import { NextRequest } from "next/server";
import {
  getActiveJourneyExecution,
  updateActiveJourneyExecution,
} from "@/lib/db/repository";
import {
  jsonResponse,
  readSessionId,
  requireSessionSigning,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { journeyExecutionActionSchema } from "@/lib/recovery/schema";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const sessionId = readSessionId(request);
  if (!sessionId) {
    return jsonResponse({ status: "empty", execution: null });
  }
  try {
    const execution = await getActiveJourneyExecution(sessionId);
    return jsonResponse({
      status: execution ? execution.status : "empty",
      execution,
    });
  } catch {
    return jsonResponse(
      {
        error: {
          code: "DB_UNAVAILABLE",
          message: "진행 중인 복구 일정을 불러오지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const sessionId = readSessionId(request);
  if (!sessionId) {
    return jsonResponse(
      {
        error: {
          code: "SESSION_REQUIRED",
          message: "복구를 적용한 브라우저에서만 진행할 수 있습니다.",
        },
      },
      { status: 401 },
    );
  }
  const rate = allowRequest(requestRateKey(request, "journey-active"), 60);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "진행 기록 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
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
          message: "여행 진행 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const parsed = journeyExecutionActionSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_JOURNEY_ACTION",
          message: "현재 단계의 도착 또는 여행 종료를 선택해 주세요.",
        },
      },
      { status: 400 },
    );
  }

  const updated = await updateActiveJourneyExecution({
    sessionId,
    action: parsed.data,
  });
  if (!updated.updated) {
    return jsonResponse(
      {
        error: {
          code: updated.reason,
          message:
            updated.reason === "NOT_FOUND"
              ? "진행 중인 복구 일정을 찾지 못했습니다."
              : updated.reason === "INVALID_STATE"
                ? "현재 장소부터 순서대로 도착을 확인해 주세요."
                : updated.reason === "ALREADY_FINALIZED"
                  ? "이 복구 여행은 이미 종료되었습니다."
                  : "여행 진행 상태를 저장하지 못했습니다.",
        },
      },
      {
        status:
          updated.reason === "NOT_FOUND"
            ? 404
            : updated.reason === "DB_UNAVAILABLE"
              ? 503
              : 409,
      },
    );
  }

  return jsonResponse({
    status: updated.execution.status,
    execution: updated.execution,
  });
}
