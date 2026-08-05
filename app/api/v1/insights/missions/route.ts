import { NextRequest } from "next/server";
import { isKnownAdministrativeScope } from "@/lib/db/repository";
import { publicJsonResponse } from "@/lib/http";
import {
  decodeMissionCursor,
  listResilienceMissions,
  MINIMUM_BEHAVIOR_SAMPLE,
  MISSION_PAGE_MAX,
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
  const cursor = request.nextUrl.searchParams.get("cursor") || undefined;

  if (cursor && !decodeMissionCursor(cursor)) {
    return publicJsonResponse(
      {
        error: {
          code: "INVALID_MISSION_CURSOR",
          message:
            "이어 받을 위치를 확인할 수 없습니다. 첫 페이지부터 다시 조회해 주세요.",
        },
      },
      { status: 400, maxAge: 0 },
    );
  }

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
    const page = await listResilienceMissions({
      areaCode: normalizedAreaCode,
      districtCode: normalizedDistrictCode,
      status,
      includeResolved,
      limit: Number.isInteger(requestedLimit)
        ? requestedLimit
        : 100,
      cursor,
    });
    /* 상태별 분포는 전체 집합에서 센 값을 쓴다. 응답에 없는 상태는 0으로
       채워 키 목록을 고정한다. */
    const byStatus = Object.fromEntries(
      [...MISSION_STATUSES].map((candidate) => [
        candidate,
        page.byStatus[candidate] ?? 0,
      ]),
    );
    return publicJsonResponse(
      {
        scope: {
          coverage: "nationwide",
          areaCode: normalizedAreaCode ?? null,
          sigunguCode: normalizedDistrictCode ?? null,
        },
        /* `missionCount`는 이 페이지의 길이다. 전국 총계로 쓰면 안 된다 —
           예전에는 이 값 하나만 있어서 잘린 페이지 길이가 총계로 발표됐다.
           총계는 `total`이고, 잘렸는지는 `truncated`로 확인한다. */
        missionCount: page.missions.length,
        total: page.total,
        pageSize: page.pageSize,
        truncated: page.truncated,
        nextCursor: page.nextCursor,
        countingRule: {
          missionCountMeaning: "이번 응답에 담긴 미션 수",
          totalMeaning: "같은 필터 조건을 만족하는 전체 미션 수",
          byStatusMeaning: "전체 집합 기준 상태별 분포(페이지 기준이 아님)",
          maxPageSize: MISSION_PAGE_MAX,
        },
        byStatus,
        privacyRule: {
          behaviorMinimumSample: MINIMUM_BEHAVIOR_SAMPLE,
          exactLocationUsed: false,
          belowThresholdPublished: false,
          explanation:
            "공식 OpenAPI 데이터 공백 미션은 즉시 공개하며, 이용자 요청 기반 미션은 분석 동의된 시군구 단위 비식별 집계가 30건 이상일 때만 공개합니다.",
        },
        missions: page.missions,
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
