import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateOps } from "@/lib/auth";
import { jsonResponse } from "@/lib/http";
import {
  fieldEvidenceRegionPrefix,
  listStoredFieldEvidence,
  recordFieldEvidence,
  validArtifactReference,
} from "@/lib/release/field-evidence";
import { FIELD_EVIDENCE_TYPES } from "@/lib/release/evidence";

export const dynamic = "force-dynamic";

const evidenceSchema = z
  .object({
    evidenceType: z.enum(FIELD_EVIDENCE_TYPES),
    sampleSize: z.number().int().min(0).max(1_000_000),
    regions: z
      .array(
        z.string().refine(
          (value) => fieldEvidenceRegionPrefix(value) !== undefined,
          "한국관광공사 공식 시도 코드 또는 그 시도의 5자리 코드를 입력해 주세요.",
        ),
      )
      .max(50),
    metrics: z.record(
      z.string().trim().min(1).max(80),
      z.number().finite(),
    ),
    artifactReference: z
      .string()
      .trim()
      .max(500)
      .refine(
        validArtifactReference,
        "https://, r2:// 또는 sha256:<64 hex> 증빙 참조가 필요합니다.",
      ),
    reviewers: z
      .array(z.string().trim().min(2).max(120))
      .min(1)
      .max(20),
    measuredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

async function authorize(request: NextRequest) {
  const auth = await authenticateOps(
    request.headers.get("authorization"),
  );
  if (auth === "missing_configuration") {
    return jsonResponse(
      {
        error: {
          code: "OPS_DISABLED",
          message: "운영 증거 원장 인증이 설정되지 않았습니다.",
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
          message: "운영 증거 원장 권한이 없습니다.",
        },
      },
      { status: 401 },
    );
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;
  try {
    return jsonResponse({
      evidence: await listStoredFieldEvidence(),
      privacy:
        "artifactReference와 reviewer는 운영자 인증 응답에서만 제공됩니다.",
    });
  } catch {
    return jsonResponse(
      {
        error: {
          code: "EVIDENCE_STORE_UNAVAILABLE",
          message: "현장 증거 원장을 조회하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error: {
          code: "INVALID_JSON",
          message: "증거 원장 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const parsed = evidenceSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_FIELD_EVIDENCE",
          message: "증거 유형·표본·지역·메트릭·검토 정보를 확인해 주세요.",
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
    const evidence = await recordFieldEvidence(parsed.data);
    return jsonResponse(
      {
        status: evidence.validated
          ? "validated_pending_independent_audit"
          : "recorded_not_validated",
        evidence,
      },
      { status: evidence.validated ? 201 : 202 },
    );
  } catch {
    return jsonResponse(
      {
        error: {
          code: "EVIDENCE_STORE_UNAVAILABLE",
          message: "현장 증거 원장을 저장하지 못했습니다.",
        },
      },
      { status: 503 },
    );
  }
}
