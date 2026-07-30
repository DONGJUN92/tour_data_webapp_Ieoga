import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateOps } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import { buildPolicyInsight } from "@/lib/insights/service";
import { refreshResilienceMissions } from "@/lib/insights/missions";
import { isOfficialRegionCode } from "@/lib/kto/registry";

export const dynamic = "force-dynamic";

const revalidationSchema = z.object({
  areaCode: z.string().refine(isOfficialRegionCode),
  sigunguCode: z.string().regex(/^\d{5}$/).optional(),
});

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
          message: "회복력 미션을 재검증할 권한이 없습니다.",
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
      {
        error: {
          code: "INVALID_JSON",
          message: "요청 본문을 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }
  const parsed = revalidationSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_REGION_SCOPE",
          message: "시도·시군구 코드를 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const policy = await buildPolicyInsight({
      areaCode: parsed.data.areaCode,
      districtCode: parsed.data.sigunguCode,
    });
    const missionRefresh = await refreshResilienceMissions(policy);
    return jsonResponse({
      status:
        missionRefresh.persistence === "persisted"
          ? "detection_snapshot_refreshed"
          : "computed_without_persistence",
      contractResolution: "mission_specific_endpoint_required",
      missionSpecificEndpoint:
        "/api/v1/ops/missions/{missionId}/revalidate",
      scope: {
        areaCode: parsed.data.areaCode,
        sigunguCode: parsed.data.sigunguCode ?? null,
      },
      policy: {
        status: policy.status,
        baseYm: policy.baseYm,
        evidenceCoverage: policy.coverage,
      },
      missionRefresh,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    return jsonResponse(
      {
        error: {
          code: "MISSION_REVALIDATION_FAILED",
          message:
            "공식 정책 근거와 회복력 미션을 재검증하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}
