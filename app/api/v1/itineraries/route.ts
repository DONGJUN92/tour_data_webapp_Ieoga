import { NextRequest } from "next/server";
import { z } from "zod";
import {
  areKnownAdministrativeScopes,
  getSessionItineraries,
  saveItinerary,
} from "@/lib/db/repository";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import {
  getOrCreateSession,
  jsonResponse,
  readSessionId,
  requireSessionSigning,
  setSessionCookie,
} from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import {
  analysisDistrictCode,
  analysisRegionCode,
} from "@/lib/kto/registry";
import { itineraryRegistrationSchema } from "@/lib/recovery/schema";

export const dynamic = "force-dynamic";

const wrappedRegistrationSchema = z
  .object({
    itinerary: itineraryRegistrationSchema,
    analyticsConsent: z.boolean().optional(),
    ephemeralLocationNodeIds: z
      .array(
        z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
      )
      .max(30)
      .optional()
      .default([]),
  })
  .superRefine((value, context) => {
    const nodes = new Map(
      value.itinerary.nodes.map((node) => [node.id, node]),
    );
    for (const [index, nodeId] of value.ephemeralLocationNodeIds.entries()) {
      const node = nodes.get(nodeId);
      if (!node || node.locked || node.reservation) {
        context.addIssue({
          code: "custom",
          path: ["ephemeralLocationNodeIds", index],
          message:
            "일회성 위치 노드는 일정에 존재하는 변경 가능 노드여야 합니다.",
        });
      }
    }
  });

export async function GET(request: NextRequest) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const sessionId = readSessionId(request);
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
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
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
  const durableRate = await allowDurableRequest(
    request,
    "itineraries",
    20,
  );
  if (!durableRate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: durableRate.unavailable
            ? "RATE_LIMIT_UNAVAILABLE"
            : "RATE_LIMITED",
          message: durableRate.unavailable
            ? "일정 저장 요청 한도를 확인할 수 없어 안전하게 중단했습니다."
            : "일정 저장 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
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
  const ephemeralNodeIds = new Set(
    wrapped.success ? wrapped.data.ephemeralLocationNodeIds : [],
  );
  const administrativeScopes = itinerary.nodes.flatMap((node) => {
    if (ephemeralNodeIds.has(node.id) || !node.location) return [];
    const regionCode = analysisRegionCode(node.location.areaCode);
    const districtCode = analysisDistrictCode(
      node.location.areaCode,
      node.location.sigunguCode,
    );
    return regionCode && districtCode
      ? [{ regionCode, districtCode }]
      : [];
  });
  try {
    if (!(await areKnownAdministrativeScopes(administrativeScopes))) {
      return jsonResponse(
        {
          error: {
            code: "UNKNOWN_REGION_SCOPE",
            message:
              "일정 장소의 시군구를 최신 공식 행정구역 기준표에서 확인하지 못했습니다.",
          },
        },
        { status: 400 },
      );
    }
  } catch {
    return jsonResponse(
      {
        error: {
          code: "REGION_REFERENCE_UNAVAILABLE",
          message:
            "공식 행정구역 기준표를 확인할 수 없어 일정을 저장하지 않았습니다.",
        },
      },
      { status: 503 },
    );
  }
  const saved = await saveItinerary({
    sessionId: session.id,
    itinerary,
    analyticsConsent,
    ephemeralLocationNodeIds: wrapped.success
      ? wrapped.data.ephemeralLocationNodeIds
      : undefined,
  });
  if (!saved.saved) {
    return jsonResponse(
      {
        error: {
          code: saved.reason,
          message:
            saved.reason === "NOT_FOUND"
              ? "수정할 일정을 찾지 못했습니다."
              : saved.reason === "INVALID_EPHEMERAL_LOCATION_NODE"
                ? "일회성 현재 위치는 변경 가능한 일정 노드에만 지정할 수 있습니다."
              : "현재 일정을 저장하지 못했습니다.",
          /* 원인을 화면까지 올린다. 로그를 볼 수 없는 자리에서 이 오류가 났고,
             "재시도하세요"만 남으면 여행자도 우리도 다음 수가 없다. */
          cause: "cause" in saved ? saved.cause : undefined,
        },
      },
      {
        status:
          saved.reason === "NOT_FOUND"
            ? 404
            : saved.reason === "INVALID_EPHEMERAL_LOCATION_NODE"
              ? 400
              : 503,
      },
    );
  }

  const response = jsonResponse(
    { status: "created", itinerary: saved.itinerary },
    { status: 201 },
  );
  response.headers.set(
    "X-RateLimit-Remaining",
    String(Math.min(rate.remaining, durableRate.remaining)),
  );
  if (session.isNew) setSessionCookie(response, session.id);
  return response;
}
