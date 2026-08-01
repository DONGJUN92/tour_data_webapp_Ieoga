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

  try {
    const result = await runPolicySync({
      batchSize,
      bootstrapIfEmpty: true,
    });
    const bootstrapDegraded = Boolean(
      result.bootstrapError ||
        result.bootstrapped?.failedRegionCodes.length,
    );
    return jsonResponse({
      status:
        result.failed || bootstrapDegraded ? "degraded" : "completed",
      ...result,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    return jsonResponse(
      {
        error: {
          code: "POLICY_SYNC_UNAVAILABLE",
          message:
            "정책 지역팩 저장소를 사용할 수 없어 동기화를 시작하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}
