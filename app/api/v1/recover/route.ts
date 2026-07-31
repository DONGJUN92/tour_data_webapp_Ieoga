import { NextRequest } from "next/server";
import {
  getOwnedSessionItinerary,
  persistRecovery,
} from "@/lib/db/repository";
import {
  getOrCreateSession,
  getRequestId,
  jsonResponse,
  setSessionCookie,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { recoverTrip } from "@/lib/recovery/engine";
import { recoveryRequestSchema } from "@/lib/recovery/schema";

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

class RecoveryDeadlineError extends Error {}

export async function POST(request: NextRequest) {
  const deadlineAt = Date.now() + RECOVERY_RESPONSE_BUDGET_MS;
  const requestId = getRequestId(request);
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

  const owned = await getOwnedSessionItinerary({
    sessionId: session.id,
    itineraryId: submittedItinerary.id,
  });
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
      occurredAt: submittedItinerary.occurredAt,
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

  const deadlineResponse = () => {
    const response = jsonResponse(
      {
        requestId,
        error: {
          code: "RECOVERY_DEADLINE_EXCEEDED",
          message:
            "20초 안에 실제 데이터 검증과 안전한 저장을 끝내지 못했습니다. 확인되지 않은 후보는 표시하지 않았습니다. 잠시 후 다시 실행해 주세요.",
        },
      },
      { status: 504 },
    );
    response.headers.set("X-Request-ID", requestId);
    response.headers.set("Retry-After", "3");
    if (session.isNew) setSessionCookie(response, session.id);
    return response;
  };
  const deadlineController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<typeof recoverTrip>>;
  try {
    result = await Promise.race([
      recoverTrip(authoritative.data, requestId, {
        deadlineAt,
        signal: deadlineController.signal,
      }),
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => {
            deadlineController.abort();
            reject(new RecoveryDeadlineError());
          },
          Math.max(1, deadlineAt - Date.now()),
        );
      }),
    ]);
  } catch (error) {
    if (!(error instanceof RecoveryDeadlineError)) throw error;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    return deadlineResponse();
  }
  if (deadlineController.signal.aborted || Date.now() >= deadlineAt) {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    return deadlineResponse();
  }

  let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  let persistence: Awaited<ReturnType<typeof persistRecovery>>;
  try {
    persistence = await Promise.race([
      persistRecovery({
        sessionId: session.id,
        input: authoritative.data,
        result,
      }),
      new Promise<never>((_, reject) => {
        persistenceTimer = setTimeout(
          () => {
            deadlineController.abort();
            reject(new RecoveryDeadlineError());
          },
          Math.max(1, deadlineAt - Date.now()),
        );
      }),
    ]);
  } catch (error) {
    if (!(error instanceof RecoveryDeadlineError)) throw error;
    return deadlineResponse();
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (persistenceTimer) clearTimeout(persistenceTimer);
  }
  if (!persistence.persisted) {
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
    response.headers.set("X-RateLimit-Remaining", String(rate.remaining));
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
  response.headers.set("X-RateLimit-Remaining", String(rate.remaining));
  response.headers.set("X-Recovery-Persisted", "true");
  if (session.isNew) setSessionCookie(response, session.id);
  return response;
}
