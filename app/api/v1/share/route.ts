import { NextRequest } from "next/server";
import { z } from "zod";
import { createProofShare } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const shareSchema = z.object({
  runId: z.string().uuid(),
  optionId: z.string().min(10).max(220),
});

export async function POST(request: NextRequest) {
  const sessionId = request.cookies.get("ieoga_session")?.value;
  if (!sessionId || !/^[a-f0-9-]{32,40}$/i.test(sessionId)) {
    return jsonResponse(
      {
        error: {
          code: "SESSION_REQUIRED",
          message: "복구를 실행한 브라우저에서만 증명서를 공유할 수 있습니다.",
        },
      },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: { code: "INVALID_JSON", message: "요청 형식을 확인해주세요." } },
      { status: 400 },
    );
  }
  const parsed = shareSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_SHARE_REQUEST",
          message: "복구 실행과 선택안 식별자를 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  const result = await createProofShare({
    sessionId,
    runId: parsed.data.runId,
    optionId: parsed.data.optionId,
  });
  if (!result.created) {
    return jsonResponse(
      {
        error: {
          code: result.reason,
          message:
            result.reason === "NOT_FOUND"
              ? "공유할 수 있는 복구 결과를 찾지 못했습니다."
              : "현재 공유 링크를 만들지 못했습니다.",
        },
      },
      { status: result.reason === "NOT_FOUND" ? 404 : 503 },
    );
  }

  return jsonResponse({
    status: "created",
    url: `/share/${result.token}`,
    expiresAt: result.expiresAt,
    proof: result.proof,
  });
}
