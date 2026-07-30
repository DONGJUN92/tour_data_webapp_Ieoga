import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "ieoga_session";

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
  const response = NextResponse.json(body, {
    status: options.status ?? 200,
  });
  response.headers.set(
    "Cache-Control",
    `public, max-age=${options.maxAge ?? 300}, s-maxage=${options.maxAge ?? 300}, stale-while-revalidate=60`,
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
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
  const current = request.cookies.get(SESSION_COOKIE)?.value;
  if (current && /^[a-f0-9-]{32,40}$/i.test(current)) {
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
    value: sessionId,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function safeErrorMessage(status: number): string {
  if (status === 400) return "요청값을 확인해주세요.";
  if (status === 401) return "인증이 필요합니다.";
  if (status === 403) return "이 작업을 수행할 권한이 없습니다.";
  if (status === 429) return "요청이 많습니다. 잠시 후 다시 시도해주세요.";
  return "현재 데이터를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";
}
