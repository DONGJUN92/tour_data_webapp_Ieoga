import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateOps } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import {
  MissionWorkflowError,
  updateMissionWorkflow,
} from "@/lib/insights/missions";

export const dynamic = "force-dynamic";

const workflowSchema = z.object({
  status: z.enum([
    "open",
    "in_progress",
    "ready_for_recheck",
    "dismissed",
  ]),
  note: z.string().trim().min(3).max(500),
  actionContract: z
    .object({
      ownerOrganization: z.string().trim().min(2).max(160),
      ownerRole: z.string().trim().min(2).max(120),
      deadlineAt: z.iso.datetime({ offset: true }),
      successCondition: z.string().trim().min(10).max(1_000),
      evidenceRequirement: z.string().trim().min(10).max(1_000),
    })
    .optional(),
  actionEvidence: z
    .object({
      actionSummary: z.string().trim().min(10).max(1_000),
      artifactReferences: z
        .array(z.string().trim().min(3).max(500))
        .min(1)
        .max(10),
      occurredAt: z.iso.datetime({ offset: true }),
      recordedBy: z.string().trim().min(2).max(120),
    })
    .optional(),
});

export async function PATCH(
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
          message: "회복력 미션을 변경할 권한이 없습니다.",
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
  const parsed = workflowSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_MISSION_WORKFLOW",
          message:
            "미션 상태·변경 사유와 실행 계약 또는 조치 증빙 형식을 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const mission = await updateMissionWorkflow({
      missionId,
      status: parsed.data.status,
      note: parsed.data.note,
      actionContract: parsed.data.actionContract,
      actionEvidence: parsed.data.actionEvidence,
    });
    if (!mission) {
      return jsonResponse(
        {
          error: {
            code: "MISSION_NOT_FOUND",
            message: "변경할 회복력 미션을 찾지 못했습니다.",
          },
        },
        { status: 404 },
      );
    }
    return jsonResponse({
      status: "updated",
      mission,
      updatedAt: new Date().toISOString(),
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
          code: "MISSION_UPDATE_FAILED",
          message: "회복력 미션 상태를 변경하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}
