import { NextRequest, NextResponse } from "next/server";
import { deleteSessionData } from "@/lib/db/repository";
import {
  jsonResponse,
  readSessionId,
  requireSameOriginJsonMutation,
  requireSessionSigning,
} from "@/lib/http";

export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const unsafeMutation = requireSameOriginJsonMutation(request, {
    requireJson: false,
  });
  if (unsafeMutation) return unsafeMutation;
  const sessionId = readSessionId(request);
  if (sessionId) {
    const result = await deleteSessionData(sessionId);
    if (!result.persisted) {
      return jsonResponse(
        {
          error: {
            code: "DELETION_UNAVAILABLE",
            message: "현재 삭제 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
          },
        },
        { status: 503 },
      );
    }
  }

  const response = NextResponse.json({
    status: "deleted",
    deletedAt: new Date().toISOString(),
    message:
      "이 브라우저의 익명 세션과 연결된 복구 운영기록 삭제 요청을 처리했습니다.",
  });
  response.cookies.set({
    name: "ieoga_session",
    value: "",
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
