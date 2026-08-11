import { NextRequest } from "next/server";
import { recordRecoveryOutcome } from "@/lib/db/repository";
import {
  jsonResponse,
  readSessionId,
  requireSameOriginJsonMutation,
  requireSessionSigning,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { recoveryOutcomeSchema } from "@/lib/recovery/schema";

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
          message: "복구를 실행한 브라우저에서만 결과를 기록할 수 있습니다.",
        },
      },
      { status: 401 },
    );
  }

  const rate = allowRequest(requestRateKey(request, "recovery-outcome"), 60);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "결과 기록 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
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
          message: "복구 결과 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const parsed = recoveryOutcomeSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_RECOVERY_OUTCOME",
          message:
            "선택한 복구안 식별자와 event=selected 값을 확인해 주세요.",
          fields: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  /* Final journey truth belongs to the active execution state machine.
     `/apply` atomically records `applied`; `/journey/active` alone may record
     an arrival at the current next-fixed step or abandon an active journey.
     This legacy endpoint is selection telemetry only, so a direct client can
     never manufacture an early success/failure outcome. */
  if (parsed.data.event !== "selected") {
    return jsonResponse(
      {
        error: {
          code: "JOURNEY_EXECUTION_REQUIRED",
          message:
            "적용·도착·중단 결과는 진행 중인 여행 단계에서만 기록할 수 있습니다.",
        },
      },
      { status: 409 },
    );
  }

  const recorded = await recordRecoveryOutcome({
    sessionId,
    runId,
    outcome: parsed.data,
  });
  if (!recorded.recorded) {
    return jsonResponse(
      {
        error: {
          code: recorded.reason,
          message:
            recorded.reason === "NOT_FOUND"
              ? "이 세션의 복구안 또는 선택 결과를 찾지 못했습니다."
              : recorded.reason === "INVALID_STATE"
                ? "현재 적용 가능한 복구안의 선택 기록만 저장할 수 있습니다."
                : recorded.reason === "ALREADY_FINALIZED"
                  ? "이 복구 실행의 최종 결과는 이미 기록되었습니다."
                  : "현재 복구 선택을 저장하지 못했습니다.",
        },
      },
      {
        status:
          recorded.reason === "NOT_FOUND"
            ? 404
            : recorded.reason === "DB_UNAVAILABLE"
              ? 503
              : 409,
      },
    );
  }

  return jsonResponse({
    status: "recorded",
    outcome: recorded.outcome,
  });
}
