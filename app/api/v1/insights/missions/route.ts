import { NextRequest } from "next/server";
import { isKnownAdministrativeScope } from "@/lib/db/repository";
import { publicJsonResponse } from "@/lib/http";
import {
  listResilienceMissions,
  MINIMUM_BEHAVIOR_SAMPLE,
} from "@/lib/insights/missions";
import {
  analysisDistrictCode,
  analysisRegionCode,
  districtBelongsToRegion,
  isOfficialRegionCode,
} from "@/lib/kto/registry";

export const dynamic = "force-dynamic";

const MISSION_STATUSES = new Set([
  "open",
  "in_progress",
  "ready_for_recheck",
  "resolved",
  "dismissed",
]);

export async function GET(request: NextRequest) {
  const areaCode =
    request.nextUrl.searchParams.get("areaCode") || undefined;
  const districtCode =
    request.nextUrl.searchParams.get("sigunguCode") || undefined;
  const status =
    request.nextUrl.searchParams.get("status") || undefined;
  const includeResolved =
    request.nextUrl.searchParams.get("includeResolved") === "1";
  const requestedLimit = Number(
    request.nextUrl.searchParams.get("limit") ?? 100,
  );

  if (
    (areaCode && !isOfficialRegionCode(areaCode)) ||
    (districtCode && !/^\d{5}$/.test(districtCode)) ||
    (districtCode && !areaCode) ||
    (districtCode &&
      areaCode &&
      !districtBelongsToRegion(areaCode, districtCode)) ||
    (status && !MISSION_STATUSES.has(status))
  ) {
    return publicJsonResponse(
      {
        error: {
          code: "INVALID_MISSION_QUERY",
          message: "지역 코드 또는 미션 상태를 확인해주세요.",
        },
      },
      { status: 400, maxAge: 0 },
    );
  }
  const normalizedAreaCode = analysisRegionCode(areaCode);
  const normalizedDistrictCode = analysisDistrictCode(
    areaCode,
    districtCode,
  );
  if (normalizedAreaCode && normalizedDistrictCode) {
    try {
      const known = await isKnownAdministrativeScope({
        regionCode: normalizedAreaCode,
        districtCode: normalizedDistrictCode,
      });
      if (!known) {
        return publicJsonResponse(
          {
            error: {
              code: "UNKNOWN_REGION_SCOPE",
              message:
                "선택한 시군구를 최신 공식 행정구역 기준표에서 확인하지 못했습니다.",
            },
          },
          { status: 400, maxAge: 0 },
        );
      }
    } catch {
      return publicJsonResponse(
        {
          error: {
            code: "REGION_REFERENCE_UNAVAILABLE",
            message:
              "공식 행정구역 기준표를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          },
        },
        { status: 503, maxAge: 0 },
      );
    }
  }

  try {
    const missions = await listResilienceMissions({
      areaCode: normalizedAreaCode,
      districtCode: normalizedDistrictCode,
      status,
      includeResolved,
      limit: Number.isInteger(requestedLimit)
        ? requestedLimit
        : 100,
    });
    const byStatus = Object.fromEntries(
      [...MISSION_STATUSES].map((candidate) => [
        candidate,
        missions.filter((mission) => mission.status === candidate)
          .length,
      ]),
    );
    return publicJsonResponse(
      {
        scope: {
          coverage: "nationwide",
          areaCode: normalizedAreaCode ?? null,
          sigunguCode: normalizedDistrictCode ?? null,
        },
        missionCount: missions.length,
        byStatus,
        privacyRule: {
          behaviorMinimumSample: MINIMUM_BEHAVIOR_SAMPLE,
          exactLocationUsed: false,
          belowThresholdPublished: false,
          explanation:
            "공식 OpenAPI 데이터 공백 미션은 즉시 공개하며, 이용자 요청 기반 미션은 분석 동의된 시군구 단위 비식별 집계가 30건 이상일 때만 공개합니다.",
        },
        missions,
        generatedAt: new Date().toISOString(),
      },
      { maxAge: 60 },
    );
  } catch {
    return publicJsonResponse(
      {
        error: {
          code: "MISSION_STORE_UNAVAILABLE",
          message:
            "현재 회복력 미션 저장소를 확인하지 못했습니다.",
        },
      },
      { status: 503, maxAge: 0 },
    );
  }
}
