import { NextRequest } from "next/server";
import { authenticateOps } from "@/lib/auth";
import { persistHealth } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { checkAllKtoServices } from "@/lib/kto/health";
import { refreshProviderProbes } from "@/lib/provider-readiness";

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
          message: "운영 인증키가 설정되지 않았습니다.",
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
          message: "OpenAPI 정밀 점검 권한이 없습니다.",
        },
      },
      { status: 401 },
    );
  }

  const [result, providerResult] = await Promise.all([
    checkAllKtoServices(),
    refreshProviderProbes({ force: true }),
  ]);
  const persistence = await persistHealth(result.sources);
  if (!persistence.persisted || !providerResult.persisted) {
    return jsonResponse(
      {
        ...result,
        providerProbes: providerResult,
        error: {
          code: "HEALTH_PERSISTENCE_FAILED",
          message:
            "OpenAPI 또는 외부 제공자 점검 결과를 운영 상태 저장소에 기록하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
  return jsonResponse({ ...result, providerProbes: providerResult }, {
    status: result.overall === "unavailable" ? 503 : 200,
  });
}
