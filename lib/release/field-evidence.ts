import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { fieldEvidenceRegistry } from "@/db/schema";
import {
  FIELD_EVIDENCE_TYPES,
  type FieldEvidenceSummary,
  type FieldEvidenceType,
} from "@/lib/release/evidence";
import { KTO_OFFICIAL_REGION_CODES } from "@/lib/kto/registry";

export type FieldEvidenceInput = {
  evidenceType: FieldEvidenceType;
  sampleSize: number;
  regions: string[];
  metrics: Record<string, number>;
  artifactReference: string;
  reviewers: string[];
  measuredAt: string;
};

export type StoredFieldEvidence = FieldEvidenceInput & {
  id: string;
  reviewedAt: string;
  validated: boolean;
  validationErrors: string[];
  independentAuditStatus: IndependentAuditStatus;
  approvedAt?: string;
  approvedBy?: string;
  auditNotes?: string;
};

export type IndependentAuditStatus =
  | "pending"
  | "approved"
  | "rejected";

const FIELD_EVIDENCE_MAX_AGE_MS = 180 * 24 * 3_600_000;
const OFFICIAL_REGION_PREFIXES = new Set<string>(
  KTO_OFFICIAL_REGION_CODES,
);

export function fieldEvidenceRegionPrefix(
  value: string,
): string | undefined {
  const normalized = value.trim();
  if (!/^(?:\d{2}|\d{5})$/.test(normalized)) return undefined;
  const prefix = normalized.slice(0, 2);
  return OFFICIAL_REGION_PREFIXES.has(prefix) ? prefix : undefined;
}

export function validArtifactReference(value: string): boolean {
  const normalized = value.trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(normalized)) return true;
  if (/^r2:\/\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(normalized)) {
    return true;
  }
  try {
    const url = new URL(normalized);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !/\s/.test(normalized)
    );
  } catch {
    return false;
  }
}

function reviewerKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ko-KR");
}

function metric(
  input: FieldEvidenceInput,
  name: string,
): number | undefined {
  const value = input.metrics[name];
  return Number.isFinite(value) ? value : undefined;
}

export function validateFieldEvidence(
  input: FieldEvidenceInput,
  now = new Date(),
): string[] {
  const errors: string[] = [];
  const regionPrefixes = input.regions.map(fieldEvidenceRegionPrefix);
  const uniqueRegionPrefixes = new Set(
    regionPrefixes.filter((value): value is string => Boolean(value)),
  );
  const uniqueReviewers = new Set(
    input.reviewers.map(reviewerKey).filter(Boolean),
  );
  if (!Number.isInteger(input.sampleSize) || input.sampleSize < 0) {
    errors.push("표본 수는 0 이상의 정수여야 합니다.");
  }
  if (regionPrefixes.some((prefix) => prefix === undefined)) {
    errors.push("지역은 한국관광공사 공식 시도 코드 또는 그 시도에 속한 5자리 코드여야 합니다.");
  }
  if (uniqueReviewers.size < 1) {
    errors.push("증거를 확인한 검토자가 최소 1명 필요합니다.");
  }
  const measuredAt = Date.parse(input.measuredAt);
  if (
    !Number.isFinite(measuredAt) ||
    measuredAt > now.getTime() + 5 * 60_000
  ) {
    errors.push("측정일은 유효하며 서버 시각보다 5분 이상 미래일 수 없습니다.");
  } else if (now.getTime() - measuredAt > FIELD_EVIDENCE_MAX_AGE_MS) {
    errors.push("측정일은 검토 시점 기준 180일 이내여야 합니다.");
  }
  if (!input.artifactReference.trim()) {
    errors.push("감사 가능한 artifact reference가 필요합니다.");
  } else if (!validArtifactReference(input.artifactReference)) {
    errors.push(
      "artifact reference는 https://, r2:// 또는 sha256:<64 hex> 형식이어야 합니다.",
    );
  }

  const requireSample = (minimum: number) => {
    if (input.sampleSize < minimum) {
      errors.push(`최소 표본 ${minimum}건이 필요합니다.`);
    }
  };
  const requireRate = (name: string, minimum: number) => {
    const value = metric(input, name);
    if (value === undefined || value < minimum || value > 100) {
      errors.push(`${name}은 ${minimum}~100 범위여야 합니다.`);
    }
  };
  const requireZero = (name: string) => {
    if (metric(input, name) !== 0) {
      errors.push(`${name}은 0이어야 합니다.`);
    }
  };

  switch (input.evidenceType) {
    case "journey_completion_contract":
      requireSample(10);
      requireRate("completionRate", 95);
      requireZero("criticalContractViolationCount");
      break;
    case "travel_purpose_preservation":
      requireSample(30);
      requireRate("purposePreservationRate", 95);
      requireZero("criticalFalsePositiveCount");
      break;
    case "tripbreak_100":
      requireSample(100);
      requireRate("scenarioSuccessRate", 90);
      requireZero("criticalFalsePositiveCount");
      if (uniqueRegionPrefixes.size < 6) {
        errors.push("최소 6개 권역의 실전 시나리오가 필요합니다.");
      }
      break;
    case "recovery_speed_and_false_positive": {
      requireSample(100);
      const medianMs = metric(input, "medianMs");
      const p95Ms = metric(input, "p95Ms");
      if (medianMs === undefined || medianMs < 0 || medianMs > 5_000) {
        errors.push("medianMs는 0~5000 범위여야 합니다.");
      }
      if (p95Ms === undefined || p95Ms < 0) {
        errors.push("유효한 p95Ms가 필요합니다.");
      }
      requireZero("criticalFalsePositiveCount");
      break;
    }
  }
  return errors;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMetrics(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export async function recordFieldEvidence(
  input: FieldEvidenceInput,
): Promise<StoredFieldEvidence> {
  const db = getDb();
  const reviewedAt = new Date().toISOString();
  const normalizedInput: FieldEvidenceInput = {
    ...input,
    regions: input.regions.map((region) => region.trim()),
    artifactReference: input.artifactReference.trim(),
    reviewers: input.reviewers.map((reviewer) =>
      reviewer.normalize("NFKC").trim().replace(/\s+/g, " "),
    ),
  };
  const validationErrors = validateFieldEvidence(normalizedInput);
  const id = crypto.randomUUID();
  await db.insert(fieldEvidenceRegistry).values({
    id,
    evidenceType: normalizedInput.evidenceType,
    sampleSize: normalizedInput.sampleSize,
    regionsJson: JSON.stringify([...new Set(normalizedInput.regions)]),
    metricsJson: JSON.stringify(normalizedInput.metrics),
    artifactReference: normalizedInput.artifactReference,
    reviewersJson: JSON.stringify([...new Set(normalizedInput.reviewers)]),
    measuredAt: normalizedInput.measuredAt,
    reviewedAt,
    validated: validationErrors.length === 0,
    validationErrorsJson: JSON.stringify(validationErrors),
  });
  return {
    id,
    ...normalizedInput,
    reviewedAt,
    validated: validationErrors.length === 0,
    validationErrors,
    independentAuditStatus: "pending",
  };
}

export async function listStoredFieldEvidence(): Promise<
  StoredFieldEvidence[]
> {
  const rows = await getDb()
    .select()
    .from(fieldEvidenceRegistry)
    .orderBy(desc(fieldEvidenceRegistry.reviewedAt));
  return rows.map((row) => ({
    id: row.id,
    evidenceType: row.evidenceType as FieldEvidenceType,
    sampleSize: row.sampleSize,
    regions: parseStringArray(row.regionsJson),
    metrics: parseMetrics(row.metricsJson),
    artifactReference: row.artifactReference,
    reviewers: parseStringArray(row.reviewersJson),
    measuredAt: row.measuredAt,
    reviewedAt: row.reviewedAt,
    validated: row.validated,
    validationErrors: parseStringArray(row.validationErrorsJson),
    independentAuditStatus:
      row.independentAuditStatus === "approved" ||
      row.independentAuditStatus === "rejected"
        ? row.independentAuditStatus
        : "pending",
    approvedAt: row.approvedAt ?? undefined,
    approvedBy: row.approvedBy ?? undefined,
    auditNotes: row.auditNotes ?? undefined,
  }));
}

export async function decideFieldEvidenceAudit(params: {
  evidenceId: string;
  decision: "approved" | "rejected";
  approvedBy: string;
  notes?: string;
}): Promise<
  | {
      updated: true;
      independentAuditStatus: "approved" | "rejected";
      approvedAt?: string;
      approvedBy?: string;
      auditNotes?: string;
    }
  | {
      updated: false;
      reason:
        | "NOT_FOUND"
        | "EVIDENCE_INVALID_OR_STALE"
        | "AUDIT_ALREADY_DECIDED";
    }
> {
  const db = getDb();
  const rows = await db
    .select()
    .from(fieldEvidenceRegistry)
    .where(eq(fieldEvidenceRegistry.id, params.evidenceId))
    .limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: "NOT_FOUND" };
  if (row.independentAuditStatus !== "pending") {
    return { updated: false, reason: "AUDIT_ALREADY_DECIDED" };
  }

  const input: FieldEvidenceInput = {
    evidenceType: row.evidenceType as FieldEvidenceType,
    sampleSize: row.sampleSize,
    regions: parseStringArray(row.regionsJson),
    metrics: parseMetrics(row.metricsJson),
    artifactReference: row.artifactReference,
    reviewers: parseStringArray(row.reviewersJson),
    measuredAt: row.measuredAt,
  };
  if (
    params.decision === "approved" &&
    (!row.validated || validateFieldEvidence(input).length > 0)
  ) {
    return {
      updated: false,
      reason: "EVIDENCE_INVALID_OR_STALE",
    };
  }

  const auditedAt = new Date().toISOString();
  const approvedBy = params.approvedBy
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  const auditNotes = params.notes?.trim() || undefined;
  const updatedRows = await db
    .update(fieldEvidenceRegistry)
    .set({
      independentAuditStatus: params.decision,
      approvedAt: params.decision === "approved" ? auditedAt : null,
      approvedBy: params.decision === "approved" ? approvedBy : null,
      auditNotes: auditNotes ?? null,
    })
    .where(
      and(
        eq(fieldEvidenceRegistry.id, params.evidenceId),
        eq(fieldEvidenceRegistry.independentAuditStatus, "pending"),
      ),
    )
    .returning({ id: fieldEvidenceRegistry.id });
  if (updatedRows.length === 0) {
    return { updated: false, reason: "AUDIT_ALREADY_DECIDED" };
  }
  return {
    updated: true,
    independentAuditStatus: params.decision,
    approvedAt: params.decision === "approved" ? auditedAt : undefined,
    approvedBy:
      params.decision === "approved" ? approvedBy : undefined,
    auditNotes,
  };
}

export async function getFieldEvidenceSummaries(): Promise<
  Partial<Record<FieldEvidenceType, FieldEvidenceSummary>>
> {
  const rows = await listStoredFieldEvidence();
  const summaries: Partial<
    Record<FieldEvidenceType, FieldEvidenceSummary>
  > = {};
  for (const evidenceType of FIELD_EVIDENCE_TYPES) {
    const latest = rows.find((row) => row.evidenceType === evidenceType);
    if (!latest) continue;
    summaries[evidenceType] = {
      evidenceType,
      validated:
        latest.validated &&
        latest.independentAuditStatus === "approved" &&
        Number.isFinite(Date.parse(latest.measuredAt)) &&
        Date.now() - Date.parse(latest.measuredAt) <=
          FIELD_EVIDENCE_MAX_AGE_MS &&
        Date.parse(latest.measuredAt) <= Date.now() + 5 * 60_000,
      sampleSize: latest.sampleSize,
      regionCount: new Set(
        latest.regions
          .map(fieldEvidenceRegionPrefix)
          .filter((value): value is string => Boolean(value)),
      ).size,
      reviewerCount: new Set(latest.reviewers.map(reviewerKey)).size,
      measuredAt: latest.measuredAt,
      independentAuditStatus: latest.independentAuditStatus,
      approvedAt: latest.approvedAt,
    };
  }
  return summaries;
}
