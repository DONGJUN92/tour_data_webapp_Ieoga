import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateOps } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import {
  getResilienceMission,
  MissionWorkflowError,
  revalidateMissionScenario,
} from "@/lib/insights/missions";
import { buildPolicyInsight } from "@/lib/insights/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  note: z.string().trim().min(3).max(500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ missionId: string }> },
) {
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
          message: "동일 시나리오를 재검증할 권한이 없습니다.",
        },
      },
      { status: 401 },
    );
  }

  const { missionId } = await context.params;
  if (
    !missionId ||
    missionId.length > 180 ||
    !/^[a-zA-Z0-9:._-]+$/.test(missionId)
  ) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_MISSION_ID",
          message: "미션 식별자를 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  const rawBody = await request.text();
  let body: unknown = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as unknown;
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
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_REVALIDATION_REQUEST",
          message: "재검증 메모는 3자 이상 500자 이하로 입력해주세요.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const mission = await getResilienceMission(missionId);
    if (!mission) {
      return jsonResponse(
        {
          error: {
            code: "MISSION_NOT_FOUND",
            message: "재검증할 회복력 미션을 찾지 못했습니다.",
          },
        },
        { status: 404 },
      );
    }
    const policy = await buildPolicyInsight({
      areaCode: mission.scenario.scope.areaCode,
      districtCode:
        mission.scenario.scope.districtCode === "_all"
          ? undefined
          : mission.scenario.scope.districtCode,
    });
    const result = await revalidateMissionScenario(
      missionId,
      policy,
      parsed.data.note,
    );
    if (!result) {
      return jsonResponse(
        {
          error: {
            code: "MISSION_NOT_FOUND",
            message: "재검증할 회복력 미션을 찾지 못했습니다.",
          },
        },
        { status: 404 },
      );
    }
    return jsonResponse({
      status: "same_scenario_revalidated",
      ...result,
    });
  } catch (error) {
    if (error instanceof MissionWorkflowError) {
      return jsonResponse(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: 409 },
      );
    }
    return jsonResponse(
      {
        error: {
          code: "MISSION_REVALIDATION_FAILED",
          message:
            "저장된 동일 조건으로 회복력 미션을 재검증하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}
