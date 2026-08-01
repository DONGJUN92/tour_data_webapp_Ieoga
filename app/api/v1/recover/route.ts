import { NextRequest } from "next/server";
import {
  areKnownAdministrativeScopes,
  getOwnedSessionItinerary,
  persistRecovery,
} from "@/lib/db/repository";
import {
  beforeDeadline,
  DeadlineExceededError,
} from "@/lib/deadline";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import {
  getOrCreateSession,
  getRequestId,
  jsonResponse,
  requireSessionSigning,
  setSessionCookie,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { recoverTrip } from "@/lib/recovery/engine";
import {
  recoveryAdministrativeScopes,
  recoveryRequestSchema,
} from "@/lib/recovery/schema";

export const dynamic = "force-dynamic";
/* Ceiling for the whole recovery, not a target. Measured directly against the
   portal, a single candidate-discovery call ranges from 0.6s to 12.4s with a
   median near 3.3s, and the slow responses are genuine successes rather than
   errors. A twelve-second ceiling was calibrated on a fast upstream: during a
   degraded window it cut off work that was about to succeed and returned an
   error instead of an answer. Healthy requests still finish in about three to
   five seconds — the wider ceiling only changes what happens on the tail,
   where returning a verified answer late beats returning nothing. */
const RECOVERY_RESPONSE_BUDGET_MS = 20_000;
const PERSISTENCE_COMMIT_RESERVE_MS = 2_000;
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60_000;

export async function POST(request: NextRequest) {
  const deadlineAt = Date.now() + RECOVERY_RESPONSE_BUDGET_MS;
  const commitDeadlineAt = deadlineAt - PERSISTENCE_COMMIT_RESERVE_MS;
  const requestId = getRequestId(request);
  const deadlineController = new AbortController();
  let persistenceStarted = false;
  const deadlineResponse = (
    currentSession?: ReturnType<typeof getOrCreateSession>,
  ) => {
    deadlineController.abort();
    const persistenceStatus = persistenceStarted
      ? "unknown"
      : "not_started";
    const response = jsonResponse(
      {
        requestId,
        persistence: {
          status: persistenceStatus,
          runId: requestId,
        },
        error: {
          code: "RECOVERY_DEADLINE_EXCEEDED",
          message:
            persistenceStatus === "unknown"
              ? "20초 응답 기한을 넘겨 저장 결과를 확정할 수 없습니다. 이 결과를 적용하지 말고 요청 ID로 상태를 확인하거나 잠시 후 다시 시도해 주세요."
              : "20초 응답 기한 안에 검증을 마치지 못해 저장을 시작하지 않았습니다. 확인하지 않은 후보는 표시하지 않습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 504 },
    );
    response.headers.set("X-Request-ID", requestId);
    response.headers.set(
      "X-Recovery-Persisted",
      persistenceStatus === "unknown" ? "unknown" : "false",
    );
    response.headers.set("Retry-After", "3");
    if (currentSession?.isNew) {
      setSessionCookie(response, currentSession.id);
    }
    return response;
  };
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) {
    signingUnavailable.headers.set("X-Request-ID", requestId);
    return signingUnavailable;
  }
  const rate = allowRequest(requestRateKey(request, "recover"), 15);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        requestId,
        error: {
          code: "RATE_LIMITED",
          message: "복구 요청이 많습니다. 잠시 후 다시 시도해주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }
  let durableRate: Awaited<ReturnType<typeof allowDurableRequest>>;
  try {
    durableRate = await beforeDeadline(
      allowDurableRequest(request, "recover", 15),
      deadlineAt,
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) return deadlineResponse();
    throw error;
  }
  if (!durableRate.allowed) {
    const response = jsonResponse(
      {
        requestId,
        error: {
          code: durableRate.unavailable
            ? "RATE_LIMIT_UNAVAILABLE"
            : "RATE_LIMITED",
          message: durableRate.unavailable
            ? "복구 요청 한도를 확인할 수 없어 안전하게 중단했습니다."
            : "복구 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
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
  const rateRemaining = Math.min(
    rate.remaining,
    durableRate.remaining,
  );

  let body: unknown;
  try {
    body = await beforeDeadline(request.json(), deadlineAt);
  } catch (error) {
    if (error instanceof DeadlineExceededError) return deadlineResponse();
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
          message:
            "원래 일정·다음 고정 일정·현재 위치와 복구 조건을 확인해주세요.",
          fields: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  const session = getOrCreateSession(request);
  const submittedItinerary = parsed.data.itinerary;
  const serverIncidentAt = new Date().toISOString();
  if (submittedItinerary.occurredAt) {
    const clockSkew = Math.abs(
      Date.parse(submittedItinerary.occurredAt) -
        Date.parse(serverIncidentAt),
    );
    if (clockSkew > MAX_CLIENT_CLOCK_SKEW_MS) {
      const response = jsonResponse(
        {
          requestId,
          error: {
            code: "INCIDENT_TIME_SKEWED",
            message:
              "기기 시각이 서버 시각과 5분 이상 차이 납니다. 자동 시각 설정을 확인한 뒤 다시 시도해 주세요.",
            serverTime: serverIncidentAt,
          },
        },
        { status: 409 },
      );
      if (session.isNew) setSessionCookie(response, session.id);
      return response;
    }
  }
  if (!submittedItinerary.id) {
    return jsonResponse(
      {
        requestId,
        error: {
          code: "ITINERARY_REGISTRATION_REQUIRED",
          message:
            "복구 전에 이 브라우저에서 원래 일정과 다음 고정 일정을 저장해 주세요.",
        },
      },
      { status: 400 },
    );
  }

  let owned: Awaited<ReturnType<typeof getOwnedSessionItinerary>>;
  try {
    owned = await beforeDeadline(
      getOwnedSessionItinerary({
        sessionId: session.id,
        itineraryId: submittedItinerary.id,
      }),
      deadlineAt,
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      return deadlineResponse(session);
    }
    throw error;
  }
  if (!owned.found) {
    return jsonResponse(
      {
        requestId,
        error: {
          code: owned.reason,
          message:
            owned.reason === "NOT_FOUND"
              ? "이 브라우저에 저장된 원래 일정을 찾지 못했습니다. 일정을 다시 저장해 주세요."
              : "저장된 일정을 확인하지 못해 복구를 실행하지 않았습니다.",
        },
      },
      { status: owned.reason === "NOT_FOUND" ? 404 : 503 },
    );
  }

  const authoritative = recoveryRequestSchema.safeParse({
    ...parsed.data,
    itinerary: {
      id: owned.itinerary.id,
      title: owned.itinerary.title,
      timezone: owned.itinerary.timezone,
      audience: owned.itinerary.audience,
      nodes: owned.itinerary.nodes,
      occurredAt: serverIncidentAt,
      disruptedNodeId: submittedItinerary.disruptedNodeId,
      nextFixedNodeId: submittedItinerary.nextFixedNodeId,
    },
  });
  if (!authoritative.success) {
    return jsonResponse(
      {
        requestId,
        error: {
          code: "ITINERARY_CONTRACT_CHANGED",
          message:
            "저장된 일정의 잠금·예약 조건이 현재 선택과 일치하지 않습니다. 일정을 다시 확인해 주세요.",
          fields: authoritative.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 409 },
    );
  }

  const administrativeScopes = recoveryAdministrativeScopes(
    authoritative.data,
  );
  if (administrativeScopes.length > 0) {
    let knownOriginScope: boolean;
    try {
      knownOriginScope = await beforeDeadline(
        areKnownAdministrativeScopes(administrativeScopes),
        deadlineAt,
      );
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        return deadlineResponse(session);
      }
      const response = jsonResponse(
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
      if (session.isNew) setSessionCookie(response, session.id);
      return response;
    }
    if (!knownOriginScope) {
      const response = jsonResponse(
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
      if (session.isNew) setSessionCookie(response, session.id);
      return response;
    }
  }

  let result: Awaited<ReturnType<typeof recoverTrip>>;
  try {
    result = await beforeDeadline(
      recoverTrip(authoritative.data, requestId, {
        deadlineAt,
        signal: deadlineController.signal,
      }),
      deadlineAt,
    );
  } catch (error) {
    if (!(error instanceof DeadlineExceededError)) throw error;
    return deadlineResponse(session);
  }
  if (deadlineController.signal.aborted || Date.now() >= deadlineAt) {
    return deadlineResponse(session);
  }

  let persistence: Awaited<ReturnType<typeof persistRecovery>>;
  if (Date.now() >= commitDeadlineAt) {
    return deadlineResponse(session);
  }
  persistenceStarted = true;
  try {
    persistence = await beforeDeadline(
      persistRecovery({
        sessionId: session.id,
        input: authoritative.data,
        result,
        commitDeadlineAt,
      }),
      deadlineAt,
    );
  } catch (error) {
    if (!(error instanceof DeadlineExceededError)) throw error;
    return deadlineResponse(session);
  }
  if (Date.now() >= deadlineAt) return deadlineResponse(session);
  if (!persistence.persisted) {
    if (persistence.reason === "RECOVERY_DEADLINE_EXCEEDED") {
      return deadlineResponse(session);
    }
    const response = jsonResponse(
      {
        requestId,
        persistence: {
          status: "failed",
          reason: persistence.reason,
        },
        error: {
          code: "RECOVERY_PERSISTENCE_FAILED",
          message:
            "복구 실행 전체를 안전하게 저장하지 못해 결과를 제공하지 않습니다. 잠시 후 다시 실행해 주세요.",
          retryable: true,
        },
      },
      { status: 503 },
    );
    response.headers.set("X-Request-ID", requestId);
    response.headers.set("X-RateLimit-Remaining", String(rateRemaining));
    response.headers.set("X-Recovery-Persisted", "false");
    return response;
  }

  const response = jsonResponse(
    {
      ...result,
      persistence: {
        status: "persisted",
        runId: result.requestId,
      },
    },
    {
      status: result.status === "upstream_unavailable" ? 503 : 200,
    },
  );
  response.headers.set("X-Request-ID", requestId);
  response.headers.set("X-RateLimit-Remaining", String(rateRemaining));
  response.headers.set("X-Recovery-Persisted", "true");
  if (session.isNew) setSessionCookie(response, session.id);
  return response;
}
