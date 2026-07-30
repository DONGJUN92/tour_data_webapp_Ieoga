import { NextRequest } from "next/server";
import { authenticateOps } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { runPolicySync } from "@/lib/sync/policy-sync";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await authenticateOps(
    request.headers.get("authorization"),
  );
  if (auth === "missing_configuration") {
    return jsonResponse(
      {
        error: {
          code: "OPS_DISABLED",
          message: "운영 동기화 인증키가 설정되지 않았습니다.",
        },
      },
      { status: 503 },
    );
  }
  if (auth !== "authorized") {
    return jsonResponse(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "운영 동기화 권한이 없습니다.",
        },
      },
      { status: 401 },
    );
  }

  let batchSize = 2;
  try {
    const body = (await request.json()) as { batchSize?: unknown };
    const requested = Number(body.batchSize);
    if (Number.isInteger(requested)) {
      batchSize = Math.min(Math.max(requested, 1), 4);
    }
  } catch {
    batchSize = 2;
  }

  const result = await runPolicySync({
    batchSize,
    bootstrapIfEmpty: true,
  });
  return jsonResponse({
    status: result.failed ? "degraded" : "completed",
    ...result,
    checkedAt: new Date().toISOString(),
  });
}
