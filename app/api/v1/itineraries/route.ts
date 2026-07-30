import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getSessionItineraries,
  saveItinerary,
} from "@/lib/db/repository";
import {
  getOrCreateSession,
  jsonResponse,
  setSessionCookie,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import { itineraryRegistrationSchema } from "@/lib/recovery/schema";

export const dynamic = "force-dynamic";

const wrappedRegistrationSchema = z.object({
  itinerary: itineraryRegistrationSchema,
  analyticsConsent: z.boolean().optional(),
});

function sessionIdFrom(request: NextRequest): string | undefined {
  const sessionId = request.cookies.get("ieoga_session")?.value;
  return sessionId && /^[a-f0-9-]{32,40}$/i.test(sessionId)
    ? sessionId
    : undefined;
}

export async function GET(request: NextRequest) {
  const sessionId = sessionIdFrom(request);
  if (!sessionId) {
    return jsonResponse({
      status: "empty",
      itinerary: null,
      itineraries: [],
    });
  }
  try {
    const itineraries = await getSessionItineraries(sessionId);
    return jsonResponse({
      status: itineraries.length ? "available" : "empty",
      itinerary: itineraries[0] ?? null,
      itineraries,
    });
  } catch {
    return jsonResponse(
      {
        error: {
          code: "DB_UNAVAILABLE",
          message:
            "저장된 일정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  const rate = allowRequest(requestRateKey(request, "itineraries"), 20);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "일정 저장 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
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
          message: "일정 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }

  const wrapped = wrappedRegistrationSchema.safeParse(body);
  const direct = wrapped.success
    ? null
    : itineraryRegistrationSchema.safeParse(body);
  if (!wrapped.success && !direct?.success) {
    const issues = wrapped.error.issues.length
      ? wrapped.error.issues
      : direct?.error.issues ?? [];
    return jsonResponse(
      {
        error: {
          code: "INVALID_ITINERARY",
          message:
            "최소 두 개의 일정과 고정 일정의 시각·위치를 확인해 주세요.",
          fields: issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  const session = getOrCreateSession(request);
  const itinerary = wrapped.success
    ? wrapped.data.itinerary
    : direct?.success
      ? direct.data
      : null;
  if (!itinerary) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_ITINERARY",
          message: "일정 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const analyticsConsent = wrapped.success
    ? wrapped.data.analyticsConsent
    : undefined;
  const saved = await saveItinerary({
    sessionId: session.id,
    itinerary,
    analyticsConsent,
  });
  if (!saved.saved) {
    return jsonResponse(
      {
        error: {
          code: saved.reason,
          message:
            saved.reason === "NOT_FOUND"
              ? "수정할 일정을 찾지 못했습니다."
              : "현재 일정을 저장하지 못했습니다.",
        },
      },
      { status: saved.reason === "NOT_FOUND" ? 404 : 503 },
    );
  }

  const response = jsonResponse(
    { status: "created", itinerary: saved.itinerary },
    { status: 201 },
  );
  response.headers.set("X-RateLimit-Remaining", String(rate.remaining));
  if (session.isNew) setSessionCookie(response, session.id);
  return response;
}
