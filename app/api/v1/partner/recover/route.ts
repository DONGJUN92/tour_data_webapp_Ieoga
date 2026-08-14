import { NextRequest } from "next/server";
import { authenticatePartner } from "@/lib/auth";
import { areKnownAdministrativeScopes } from "@/lib/db/repository";
import {
  beforeDeadline,
  DeadlineExceededError,
} from "@/lib/deadline";
import { getRequestId, jsonResponse } from "@/lib/http";
import {
  consumePartnerQuota,
  recordPartnerSuccess,
} from "@/lib/partner/quota";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { recoverTrip } from "@/lib/recovery/engine";
import {
  recoveryAdministrativeScopes,
  recoveryRequestSchema,
} from "@/lib/recovery/schema";
import { resolveRecoveryReferenceTime } from "@/lib/recovery/reference-time";

export const dynamic = "force-dynamic";
const PARTNER_RECOVERY_BUDGET_MS = 20_000;

function deadlineResponse(requestId: string) {
  const response = jsonResponse(
    {
      requestId,
      error: {
        code: "RECOVERY_DEADLINE_EXCEEDED",
        message:
          "25초 안에 검증을 마치지 못했습니다. 확인되지 않은 후보는 반환하지 않습니다.",
      },
    },
    { status: 504 },
  );
  response.headers.set("X-Request-ID", requestId);
  response.headers.set("Retry-After", "3");
  return response;
}

export async function POST(request: NextRequest) {
  const deadlineAt = Date.now() + PARTNER_RECOVERY_BUDGET_MS;
  const requestId = getRequestId(request);
  const authorization = request.headers.get("authorization");
  const auth = await authenticatePartner(
    authorization,
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

  let quota: Awaited<ReturnType<typeof consumePartnerQuota>>;
  try {
    quota = await beforeDeadline(
      consumePartnerQuota(authorization),
      deadlineAt,
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      return deadlineResponse(requestId);
    }
    throw error;
  }
  if (!quota.allowed) {
    const status = quota.unavailable
      ? 503
      : quota.reason === "inactive"
        ? 403
        : 429;
    const response = jsonResponse(
      {
        requestId,
        error: {
          code: quota.unavailable
            ? "PARTNER_QUOTA_UNAVAILABLE"
            : quota.reason === "inactive"
              ? "PARTNER_CLIENT_INACTIVE"
              : "RATE_LIMITED",
          message: quota.unavailable
            ? "파트너 사용량을 안전하게 확인할 수 없어 요청을 중단했습니다."
            : quota.reason === "inactive"
              ? "비활성화되거나 해지된 파트너 클라이언트입니다."
              : "파트너의 분당 또는 일일 호출 한도를 초과했습니다.",
        },
      },
      { status },
    );
    response.headers.set("X-Request-ID", requestId);
    response.headers.set("Retry-After", String(quota.retryAfterSeconds));
    return response;
  }

  let body: unknown;
  try {
    body = await beforeDeadline(request.json(), deadlineAt);
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      return deadlineResponse(requestId);
    }
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

  const referenceResolution = resolveRecoveryReferenceTime(
    parsed.data,
    new Date(),
  );
  if (!referenceResolution.success) {
    const response = jsonResponse(
      { requestId, error: referenceResolution.error },
      {
        status:
          referenceResolution.error.code === "REFERENCE_TIME_CONFLICT" ||
          referenceResolution.error.code ===
            "REFERENCE_TIME_CONTRACT_INVALID"
            ? 409
            : 400,
      },
    );
    response.headers.set("X-Request-ID", requestId);
    return response;
  }
  const authoritativeRequest = referenceResolution.input;

  const administrativeScopes = recoveryAdministrativeScopes(
    authoritativeRequest,
  );
  if (administrativeScopes.length > 0) {
    let knownScopes: boolean;
    try {
      knownScopes = await beforeDeadline(
        areKnownAdministrativeScopes(administrativeScopes),
        deadlineAt,
      );
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        return deadlineResponse(requestId);
      }
      return jsonResponse(
        {
          requestId,
          error: {
            code: "REGION_REFERENCE_UNAVAILABLE",
            message:
              "공식 행정구역 기준표를 확인할 수 없어 복구를 시작하지 않았습니다.",
          },
        },
        { status: 503 },
      );
    }
    if (!knownScopes) {
      return jsonResponse(
        {
          requestId,
          error: {
            code: "UNKNOWN_REGION_SCOPE",
            message:
              "현재 위치 또는 일정 장소의 시군구를 최신 공식 행정구역 기준표에서 확인하지 못했습니다.",
          },
        },
        { status: 400 },
      );
    }
  }

  const deadlineController = new AbortController();
  let result: Awaited<ReturnType<typeof recoverTrip>>;
  try {
    result = await beforeDeadline(
      recoverTrip(authoritativeRequest, requestId, {
        deadlineAt,
        signal: deadlineController.signal,
      }),
      deadlineAt,
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      deadlineController.abort();
      return deadlineResponse(requestId);
    }
    throw error;
  }
  if (
    quota.clientId &&
    quota.usageDate &&
    Date.now() < deadlineAt - 250
  ) {
    try {
      await beforeDeadline(
        recordPartnerSuccess(quota.clientId, quota.usageDate),
        deadlineAt,
      );
    } catch {
      // The request was already counted before expensive provider work.
      // Success-count telemetry must never turn a verified result into a 5xx.
    }
  }
  if (deadlineController.signal.aborted || Date.now() >= deadlineAt) {
    deadlineController.abort();
    return deadlineResponse(requestId);
  }
  const response = jsonResponse(result, {
    status: result.status === "upstream_unavailable" ? 503 : 200,
  });
  response.headers.set("X-Request-ID", requestId);
  response.headers.set(
    "X-RateLimit-Remaining",
    String(Math.min(rate.remaining, quota.minuteRemaining)),
  );
  response.headers.set(
    "X-Partner-Daily-Remaining",
    String(quota.dailyRemaining),
  );
  return response;
}
