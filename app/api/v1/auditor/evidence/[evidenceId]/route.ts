import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateReleaseAuditor } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import {
  decideFieldEvidenceAudit,
  listStoredFieldEvidence,
  verifyArtifactReference,
} from "@/lib/release/field-evidence";

export const dynamic = "force-dynamic";

const auditDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    approvedBy: z.string().trim().min(2).max(120),
    notes: z.string().trim().min(2).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "rejected" && !value.notes) {
      context.addIssue({
        code: "custom",
        path: ["notes"],
        message: "거절 사유를 입력해 주세요.",
      });
    }
  });

async function authorizeAuditor(request: NextRequest) {
  const auth = await authenticateReleaseAuditor(
    request.headers.get("authorization"),
  );
  if (auth === "missing_configuration") {
    return jsonResponse(
      {
        error: {
          code: "AUDITOR_DISABLED",
          message:
            "OPS 토큰과 분리되고 공개된 최소 품질 정책을 통과한 독립 감사 키가 설정되지 않았습니다.",
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
          message: "독립 증거 감사 권한이 없습니다.",
        },
      },
      { status: 401 },
    );
  }
  return null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ evidenceId: string }> },
) {
  const denied = await authorizeAuditor(request);
  if (denied) return denied;
  const { evidenceId } = await context.params;
  if (!/^[a-f0-9-]{36}$/i.test(evidenceId)) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_EVIDENCE_ID",
          message: "증거 식별자를 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  try {
    const evidence = (await listStoredFieldEvidence()).find(
      (item) => item.id === evidenceId,
    );
    return evidence
      ? jsonResponse({
          evidence,
          artifactVerification: await verifyArtifactReference(
            evidence.artifactReference,
          ),
        })
      : jsonResponse(
          {
            error: {
              code: "NOT_FOUND",
              message: "감사할 증거를 찾지 못했습니다.",
            },
          },
          { status: 404 },
        );
  } catch {
    return jsonResponse(
      {
        error: {
          code: "EVIDENCE_AUDIT_STORE_UNAVAILABLE",
          message: "독립 감사 증거를 불러오지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ evidenceId: string }> },
) {
  const denied = await authorizeAuditor(request);
  if (denied) return denied;

  const { evidenceId } = await context.params;
  if (!/^[a-f0-9-]{36}$/i.test(evidenceId)) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_EVIDENCE_ID",
          message: "증거 식별자를 확인해 주세요.",
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
          message: "감사 결정 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const parsed = auditDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_AUDIT_DECISION",
          message: "승인·거절 결정과 감사자 정보를 확인해 주세요.",
          fields: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await decideFieldEvidenceAudit({
      evidenceId,
      ...parsed.data,
    });
    if (!result.updated) {
      return jsonResponse(
        {
          error: {
            code: result.reason,
            message:
              result.reason === "NOT_FOUND"
                ? "감사할 증거를 찾지 못했습니다."
                : result.reason === "AUDIT_ALREADY_DECIDED"
                  ? "이미 독립 감사 결정이 완료된 증거입니다. 새 증거를 제출해 주세요."
                  : result.reason === "ARTIFACT_UNVERIFIED"
                    ? "허용된 원본 파일의 실제 존재 여부와 SHA-256 해시가 일치해야 승인할 수 있습니다."
                    : "형식 검증에 실패했거나 180일을 지난 증거는 승인할 수 없습니다.",
          },
        },
        { status: result.reason === "NOT_FOUND" ? 404 : 409 },
      );
    }
    return jsonResponse({
      status:
        result.independentAuditStatus === "approved"
          ? "independently_approved"
          : "independently_rejected",
      audit: result,
    });
  } catch {
    return jsonResponse(
      {
        error: {
          code: "EVIDENCE_AUDIT_STORE_UNAVAILABLE",
          message: "독립 감사 결정을 저장하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}
