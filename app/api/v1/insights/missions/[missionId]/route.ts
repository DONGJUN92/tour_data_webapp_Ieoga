import { publicJsonResponse } from "@/lib/http";
import {
  getResilienceMission,
  MINIMUM_BEHAVIOR_SAMPLE,
} from "@/lib/insights/missions";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const { missionId } = await context.params;
  if (
    !missionId ||
    missionId.length > 180 ||
    !/^[a-zA-Z0-9:._-]+$/.test(missionId)
  ) {
    return publicJsonResponse(
      {
        error: {
          code: "INVALID_MISSION_ID",
          message: "미션 식별자를 확인해주세요.",
        },
      },
      { status: 400, maxAge: 0 },
    );
  }

  try {
    const mission = await getResilienceMission(missionId);
    if (!mission) {
      return publicJsonResponse(
        {
          error: {
            code: "MISSION_NOT_FOUND",
            message:
              "공개 가능한 회복력 미션을 찾지 못했습니다.",
          },
        },
        { status: 404, maxAge: 0 },
      );
    }
    return publicJsonResponse(
      {
        mission,
        privacyRule: {
          behaviorMinimumSample: MINIMUM_BEHAVIOR_SAMPLE,
          exactLocationUsed: false,
          belowThresholdPublished: false,
        },
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

