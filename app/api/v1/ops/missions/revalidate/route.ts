import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateOps } from "@/lib/auth";
import { isKnownAdministrativeScope } from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { buildPolicyInsight } from "@/lib/insights/service";
import { refreshResilienceMissions } from "@/lib/insights/missions";
import {
  analysisDistrictCode,
  analysisRegionCode,
  districtBelongsToRegion,
  isOfficialRegionCode,
  isPlausibleOfficialDistrictCode,
} from "@/lib/kto/registry";

export const dynamic = "force-dynamic";

const revalidationSchema = z
  .object({
    areaCode: z.string().refine(isOfficialRegionCode),
    sigunguCode: z
      .string()
      .refine(isPlausibleOfficialDistrictCode)
      .optional(),
  })
  .superRefine((scope, context) => {
    if (
      scope.sigunguCode &&
      !districtBelongsToRegion(scope.areaCode, scope.sigunguCode)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sigunguCode"],
        message: "시군구 코드가 선택한 시도에 속하지 않습니다.",
      });
    }
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
  const normalizedAreaCode = analysisRegionCode(parsed.data.areaCode)!;
  const normalizedDistrictCode = analysisDistrictCode(
    parsed.data.areaCode,
    parsed.data.sigunguCode,
  );
  if (normalizedDistrictCode) {
    try {
      const known = await isKnownAdministrativeScope({
        regionCode: normalizedAreaCode,
        districtCode: normalizedDistrictCode,
      });
      if (!known) {
        return jsonResponse(
          {
            error: {
              code: "UNKNOWN_REGION_SCOPE",
              message:
                "선택한 시군구를 최신 공식 행정구역 기준표에서 확인하지 못했습니다.",
            },
          },
          { status: 400 },
        );
      }
    } catch {
      return jsonResponse(
        {
          error: {
            code: "REGION_REFERENCE_UNAVAILABLE",
            message:
              "공식 행정구역 기준표를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          },
        },
        { status: 503 },
      );
    }
  }

  try {
    const policy = await buildPolicyInsight({
      areaCode: normalizedAreaCode,
      districtCode: normalizedDistrictCode,
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
        areaCode: normalizedAreaCode,
        sigunguCode: normalizedDistrictCode ?? null,
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
