import { NextRequest } from "next/server";
import {
  getProofShare,
  revokeProofShare,
} from "@/lib/db/repository";
import {
  jsonResponse,
  readSessionId,
  requireSessionSigning,
} from "@/lib/http";

export const dynamic = "force-dynamic";

function validToken(token: string): boolean {
  return /^[a-f0-9]{48}$/i.test(token);
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!validToken(token)) {
    return jsonResponse(
      { error: { code: "INVALID_TOKEN", message: "공유 링크를 확인해주세요." } },
      { status: 400 },
    );
  }
  const proof = await getProofShare(token);
  if (!proof) {
    return jsonResponse(
      {
        error: {
          code: "PROOF_NOT_FOUND",
          message: "만료됐거나 취소된 복구 증명서입니다.",
        },
      },
      { status: 404 },
    );
  }
  return jsonResponse({ status: "available", proof });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const { token } = await context.params;
  const sessionId = readSessionId(request);
  if (
    !validToken(token) ||
    !sessionId
  ) {
    return jsonResponse(
      { error: { code: "UNAUTHORIZED", message: "공유를 취소할 권한이 없습니다." } },
      { status: 401 },
    );
  }
  const revoked = await revokeProofShare({ token, sessionId });
  return jsonResponse(
    revoked
      ? { status: "revoked", revokedAt: new Date().toISOString() }
      : {
          error: {
            code: "PROOF_NOT_FOUND",
            message: "취소할 공유 증명서를 찾지 못했습니다.",
          },
        },
    { status: revoked ? 200 : 404 },
  );
}
