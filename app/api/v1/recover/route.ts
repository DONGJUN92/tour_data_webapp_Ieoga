import { NextRequest } from "next/server";
import {
  areKnownAdministrativeScopes,
  getOwnedSessionItinerary,
  persistRecovery,
} from "@/lib/db/repository";
import {
  beforeDeadline,
  DeadlineExceededError,
  RECOVERY_RESPONSE_BUDGET_MS,
} from "@/lib/deadline";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import {
  getOrCreateSession,
  getRequestId,
  jsonResponse,
  requireSameOriginJsonMutation,
  requireSessionSigning,
  setSessionCookie,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { verifyEmbedSessionToken } from "@/lib/session-cookie";
import { recoverTrip } from "@/lib/recovery/engine";
import { recordRegionalGaps } from "@/lib/insights/regional-gaps";
import {
  recoveryAdministrativeScopes,
  recoveryRequestSchema,
  type RecoveryRequest,
} from "@/lib/recovery/schema";
import { resolveRecoveryReferenceTime } from "@/lib/recovery/reference-time";

export const dynamic = "force-dynamic";
/* Ceiling for the whole recovery, not a target. Measured directly against the
   portal, a single candidate-discovery call ranges from 0.6s to 12.4s with a
   median near 3.3s, and the slow responses are genuine successes rather than
   errors. A twelve-second ceiling was calibrated on a fast upstream: during a
   degraded window it cut off work that was about to succeed and returned an
   error instead of an answer. Healthy requests still finish in about three to
   five seconds — the wider ceiling only changes what happens on the tail,
   where returning a verified answer late beats returning nothing. */
/* 25초로 넓혔다. 검증 풀을 18곳에서 36곳으로 키운 만큼, 예전 예산이면 늘어난
   후보가 검증되기 전에 마감이 먼저 온다 — 후보만 늘리고 예산을 그대로 두면
   "응답 시간 예산 안에서 N곳만 검증했습니다" 경고가 대신 늘어난다. 정상 요청은
   여전히 3~5초에 끝나고, 이 수치는 꼬리에서만 의미가 있다.
   값 자체는 lib/deadline.ts에 있다 — /api/v1/capabilities가 같은 값을 공개
   계약으로 알리므로 두 곳이 갈라지면 계약이 거짓이 된다. */
const PERSISTENCE_COMMIT_RESERVE_MS = 2_000;
const MAX_OPEN_WINDOW_MINUTES = 1_440;

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
              ? "25초 응답 기한을 넘겨 저장 결과를 확정할 수 없습니다. 이 결과를 적용하지 말고 요청 ID로 상태를 확인하거나 잠시 후 다시 시도해 주세요."
              : "25초 응답 기한 안에 검증을 마치지 못해 저장을 시작하지 않았습니다. 확인하지 않은 후보는 표시하지 않습니다. 잠시 후 다시 시도해 주세요.",
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
  const unsafeMutation = requireSameOriginJsonMutation(request);
  if (unsafeMutation) {
    unsafeMutation.headers.set("X-Request-ID", requestId);
    return unsafeMutation;
  }
  const presentedEmbedToken = request.headers.get(
    "x-ieoga-embed-session",
  );
  const embedSessionId = presentedEmbedToken
    ? verifyEmbedSessionToken(presentedEmbedToken)
    : undefined;
  if (presentedEmbedToken && !embedSessionId) {
    const response = jsonResponse(
      {
        requestId,
        error: {
          code: "INVALID_EMBED_SESSION",
          message:
            "위젯 세션이 만료되었거나 유효하지 않습니다. 위젯에서 다시 시도해 주세요.",
        },
      },
      { status: 401 },
    );
    response.headers.set("X-Request-ID", requestId);
    return response;
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

  if (
    embedSessionId &&
    (parsed.data.itinerary ||
      !parsed.data.openWindow ||
      parsed.data.analyticsConsent)
  ) {
    const response = jsonResponse(
      {
        requestId,
        error: {
          code: "EMBED_SESSION_SCOPE_VIOLATION",
          message:
            "위젯 세션은 동의 없는 빈 시간 추천에만 사용할 수 있습니다.",
        },
      },
      { status: 403 },
    );
    response.headers.set("X-Request-ID", requestId);
    return response;
  }
  const session = embedSessionId
    ? { id: embedSessionId, isNew: false }
    : getOrCreateSession(request);
  const serverNow = new Date();
  const serverTime = serverNow.toISOString();
  const referenceResolution = resolveRecoveryReferenceTime(
    parsed.data,
    serverNow,
  );
  if (!referenceResolution.success) {
    const response = jsonResponse(
      {
        requestId,
        error: referenceResolution.error,
      },
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
    if (session.isNew) setSessionCookie(response, session.id);
    return response;
  }
  const authoritativeRequest = referenceResolution.input;
  const referenceAt = referenceResolution.referenceTime.at;
  const submittedItinerary = authoritativeRequest.itinerary;
  const openWindow = authoritativeRequest.openWindow;

  /* 빈 시간 추천은 저장된 일정을 쓰지 않는다. 사용자가 지금 알려 준 창 조건만이
     입력이므로 소유권 조회와 일정 계약 재검증을 건너뛴다. 창의 끝 시각은 서버
     시각을 기준으로 다시 확인해, 기기 시각이 틀어진 채로 "아직 3시간 남았다"는
     계산이 통과하는 일을 막는다. */
  if (openWindow && !submittedItinerary) {
    const departureAt = Date.parse(referenceAt);
    const windowEndAt = Date.parse(openWindow.availableUntil);
    const remainingMinutes = Math.floor(
      (windowEndAt - departureAt) / 60_000,
    );
    if (!Number.isFinite(windowEndAt) || remainingMinutes < 30) {
      const response = jsonResponse(
        {
          requestId,
          error: {
            code: "OPEN_WINDOW_TOO_SHORT",
            message:
              "조회 기준 시각부터 남은 자유 시간이 30분 미만입니다. 종료 시각을 다시 확인해 주세요.",
            serverTime,
          },
        },
        { status: 400 },
      );
      if (session.isNew) setSessionCookie(response, session.id);
      return response;
    }
    /* `availableMinutes`는 아래에서 두 ISO 시각의 차이로 덮어쓰므로, 최초
       스키마를 통과한 클라이언트 숫자의 상한에 기대면 48시간 창을 30분으로
       위장할 수 있다. 권위 시각으로 다시 계산한 값 자체를 재검증한다. */
    if (remainingMinutes > MAX_OPEN_WINDOW_MINUTES) {
      const response = jsonResponse(
        {
          requestId,
          error: {
            code: "OPEN_WINDOW_TOO_LONG",
            message:
              "출발 뒤 자유 시간은 최대 24시간까지 확인할 수 있습니다. 종료 시각을 다시 확인해 주세요.",
            serverTime,
          },
        },
        { status: 400 },
      );
      if (session.isNew) setSessionCookie(response, session.id);
      return response;
    }

    const openWindowScopes = recoveryAdministrativeScopes(
      authoritativeRequest,
    );
    if (openWindowScopes.length > 0) {
      let knownScope: boolean;
      try {
        knownScope = await beforeDeadline(
          areKnownAdministrativeScopes(openWindowScopes),
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
                "공식 행정구역 기준표를 확인할 수 없어 추천을 시작하지 않았습니다.",
            },
          },
          { status: 503 },
        );
        if (session.isNew) setSessionCookie(response, session.id);
        return response;
      }
      if (!knownScope) {
        const response = jsonResponse(
          {
            requestId,
            error: {
              code: "UNKNOWN_REGION_SCOPE",
              message:
                "현재 위치 또는 다음 장소의 시군구를 최신 공식 행정구역 기준표에서 확인하지 못했습니다.",
            },
          },
          { status: 400 },
        );
        if (session.isNew) setSessionCookie(response, session.id);
        return response;
      }
    }

    const authoritativeOpenWindowInput: RecoveryRequest = {
      ...authoritativeRequest,
      availableMinutes: remainingMinutes,
      openWindow: {
        ...openWindow,
        departureAt: new Date(departureAt).toISOString(),
      },
    };
    return await runRecovery({
      input: authoritativeOpenWindowInput,
      session,
      requestId,
      deadlineAt,
      commitDeadlineAt,
      deadlineResponse,
      deadlineController,
      markPersistenceStarted: () => {
        persistenceStarted = true;
      },
      rateRemaining,
    });
  }

  if (!submittedItinerary) {
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
    ...authoritativeRequest,
    itinerary: {
      id: owned.itinerary.id,
      title: owned.itinerary.title,
      timezone: owned.itinerary.timezone,
      audience: owned.itinerary.audience,
      nodes: owned.itinerary.nodes,
      occurredAt: referenceAt,
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

  return await runRecovery({
    input: authoritative.data,
    session,
    requestId,
    deadlineAt,
    commitDeadlineAt,
    deadlineResponse,
    deadlineController,
    markPersistenceStarted: () => {
      persistenceStarted = true;
    },
    rateRemaining,
  });
}

/* 검증을 통과한 입력을 실행하고 저장하는 공통 구간. 일정 복구와 빈 시간 추천이
   서로 다른 입구를 갖지만, 25초 기한·원자 저장·미저장 시 결과 미제공이라는
   동일한 보장을 받아야 하므로 이 부분을 복제하지 않고 공유한다. */
async function runRecovery(params: {
  input: RecoveryRequest;
  session: ReturnType<typeof getOrCreateSession>;
  requestId: string;
  deadlineAt: number;
  commitDeadlineAt: number;
  deadlineResponse: (
    currentSession?: ReturnType<typeof getOrCreateSession>,
  ) => Response;
  deadlineController: AbortController;
  markPersistenceStarted: () => void;
  rateRemaining: number;
}): Promise<Response> {
  const {
    input,
    session,
    requestId,
    deadlineAt,
    commitDeadlineAt,
    deadlineResponse,
    deadlineController,
    markPersistenceStarted,
    rateRemaining,
  } = params;

  let result: Awaited<ReturnType<typeof recoverTrip>>;
  try {
    result = await beforeDeadline(
      recoverTrip(input, requestId, {
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
  markPersistenceStarted();
  try {
    persistence = await beforeDeadline(
      persistRecovery({
        sessionId: session.id,
        input,
        result,
        commitDeadlineAt,
      }),
      deadlineAt,
    );
  } catch (error) {
    if (!(error instanceof DeadlineExceededError)) throw error;
    return deadlineResponse(session);
  }
  /* 지역별 공백 집계. 기획안 6.5의 `감지된 공백` 재료를 이 자리에서 쌓는다.

     사유별 건수만 담고 장소명·좌표·세션은 담지 않으므로 지자체와 공유할 수 있다.
     외부 호출을 쓰지 않고(D1은 내부 예산), 실패해도 여행자의 응답에는 영향을 주지
     않는다 — 정책 화면의 재료 때문에 추천이 막히면 우선순위가 거꾸로다. */
  try {
    await recordRegionalGaps({ input, result });
  } catch {
    /* 집계 실패는 여행자에게 알릴 일이 아니다. */
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
            "실행 전체를 안전하게 저장하지 못해 결과를 제공하지 않습니다. 잠시 후 다시 실행해 주세요.",
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
