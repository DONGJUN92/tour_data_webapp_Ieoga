import { NextRequest } from "next/server";
import {
  getProofShare,
  revokeProofShare,
} from "@/lib/db/repository";
import {
  jsonResponse,
  readSessionId,
  requireSameOriginJsonMutation,
  requireSessionSigning,
} from "@/lib/http";

export const dynamic = "force-dynamic";

function validToken(token: string): boolean {
  return /^[a-f0-9]{48}$/i.test(token);
}

export async function GET(
  request: NextRequest,
) {
  const token = request.nextUrl.pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!validToken(token)) {
    return jsonResponse(
      { error: { code: "INVALID_TOKEN", message: "공유 링크를 확인해주세요." } },
      { status: 400 },
    );
  }
  const result = await getProofShare(token);
  if (!result.found) {
    return jsonResponse(
      {
        error: {
          code:
            result.reason === "DB_UNAVAILABLE"
              ? "DB_UNAVAILABLE"
              : "PROOF_NOT_FOUND",
          message:
            result.reason === "DB_UNAVAILABLE"
              ? "현재 복구 증명서를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."
              : "만료됐거나 취소된 복구 증명서입니다.",
        },
      },
      { status: result.reason === "DB_UNAVAILABLE" ? 503 : 404 },
    );
  }
  return jsonResponse({ status: "available", proof: result.proof });
}

export async function DELETE(
  request: NextRequest,
) {
  const signingUnavailable = requireSessionSigning();
  if (signingUnavailable) return signingUnavailable;
  const unsafeMutation = requireSameOriginJsonMutation(request, {
    requireJson: false,
  });
  if (unsafeMutation) return unsafeMutation;
  const token = request.nextUrl.pathname.split("/").filter(Boolean).at(-1) ?? "";
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
  const result = await revokeProofShare({ token, sessionId });
  return jsonResponse(
    result.revoked
      ? { status: "revoked", revokedAt: new Date().toISOString() }
      : {
          error: {
            code:
              result.reason === "DB_UNAVAILABLE"
                ? "DB_UNAVAILABLE"
                : "PROOF_NOT_FOUND",
            message:
              result.reason === "DB_UNAVAILABLE"
                ? "현재 공유 취소 상태를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."
                : "취소할 공유 증명서를 찾지 못했습니다.",
          },
        },
    {
      status: result.revoked
        ? 200
        : result.reason === "DB_UNAVAILABLE"
          ? 503
          : 404,
    },
  );
}
