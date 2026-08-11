import { NextRequest, NextResponse } from "next/server";
import {
  createSessionCookieValue,
  sessionSigningStatus,
  verifySessionCookieValue,
} from "@/lib/session-cookie";

const SESSION_COOKIE = "ieoga_session";

export function readSessionId(request: NextRequest): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    return verifySessionCookieValue(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export function publicJsonResponse(
  body: unknown,
  options: { maxAge?: number; status?: number } = {},
): NextResponse {
  const status = options.status ?? 200;
  const response = NextResponse.json(body, {
    status,
  });
  if (status >= 400 || options.maxAge === 0) {
    /* Never let an edge cache retain a transient outage, validation failure,
       authorization response, or explicitly dynamic health result merely
       because the successful form of the same endpoint is public. */
    response.headers.set("Cache-Control", "private, no-store");
  } else {
    response.headers.set(
      "Cache-Control",
      `public, max-age=${options.maxAge ?? 300}, s-maxage=${options.maxAge ?? 300}, stale-while-revalidate=60`,
    );
  }
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export function requireSessionSigning(): NextResponse | null {
  if (sessionSigningStatus().available) return null;
  return jsonResponse(
    {
      error: {
        code: "SESSION_SIGNING_UNAVAILABLE",
        message:
          "안전한 익명 세션을 확인할 수 없어 요청을 중단했습니다. 잠시 후 다시 시도해 주세요.",
      },
    },
    { status: 503 },
  );
}

export function requireSameOriginJsonMutation(
  request: NextRequest,
  options: { requireJson?: boolean } = {},
): NextResponse | null {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (
    origin !== request.nextUrl.origin ||
    (fetchSite !== undefined && fetchSite !== "same-origin")
  ) {
    return jsonResponse(
      {
        error: {
          code: "CROSS_ORIGIN_MUTATION_FORBIDDEN",
          message:
            "이 브라우저와 같은 출처에서 시작한 요청만 처리할 수 있습니다.",
        },
      },
      { status: 403 },
    );
  }
  if (options.requireJson !== false) {
    const mediaType = request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      return jsonResponse(
        {
          error: {
            code: "JSON_CONTENT_TYPE_REQUIRED",
            message: "Content-Type application/json 요청만 처리할 수 있습니다.",
          },
        },
        { status: 415 },
      );
    }
  }
  return null;
}

export function getRequestId(request: NextRequest): string {
  const candidate = request.headers.get("x-request-id");
  if (candidate && /^[a-zA-Z0-9_-]{8,80}$/.test(candidate)) return candidate;
  return crypto.randomUUID();
}

export function getOrCreateSession(request: NextRequest): {
  id: string;
  isNew: boolean;
} {
  if (!sessionSigningStatus().available) {
    throw new Error("SESSION_SIGNING_KEY_UNAVAILABLE");
  }
  const current = readSessionId(request);
  if (current) {
    return { id: current, isNew: false };
  }
  return { id: crypto.randomUUID(), isNew: true };
}

export function setSessionCookie(
  response: NextResponse,
  sessionId: string,
): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: createSessionCookieValue(sessionId),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function attachRequestId(
  response: NextResponse,
  requestId: string,
): NextResponse {
  response.headers.set("X-Request-ID", requestId);
  return response;
}

export function logServerError(
  scope: string,
  requestId: string,
  error: unknown,
): void {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  // Driver messages may contain SQL, schema names, bound values, provider
  // URLs, or credentials. Keep logs correlatable without copying raw error
  // text into either logs or downstream responses.
  console.error(`[server] ${scope}`, {
    requestId,
    errorName:
      typeof candidate?.name === "string" ? candidate.name : "UnknownError",
    errorCode:
      typeof candidate?.code === "string" ||
      typeof candidate?.code === "number"
        ? String(candidate.code).slice(0, 80)
        : "unavailable",
  });
}

export function safeErrorMessage(status: number): string {
  if (status === 400) return "요청값을 확인해주세요.";
  if (status === 401) return "인증이 필요합니다.";
  if (status === 403) return "이 작업을 수행할 권한이 없습니다.";
  if (status === 429) return "요청이 많습니다. 잠시 후 다시 시도해주세요.";
  return "현재 데이터를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";
}
