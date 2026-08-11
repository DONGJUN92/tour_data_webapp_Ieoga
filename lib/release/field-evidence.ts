import { and, desc, eq } from "drizzle-orm";
import { env as workerEnv } from "cloudflare:workers";
import { getDb } from "@/db";
import { fieldEvidenceRegistry } from "@/db/schema";
import {
  FIELD_EVIDENCE_TYPES,
  type FieldEvidenceSummary,
  type FieldEvidenceType,
} from "@/lib/release/evidence";
import { KTO_OFFICIAL_REGION_CODES } from "@/lib/kto/registry";
import { getRuntimeSecret } from "@/lib/runtime-env";

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

export type ArtifactVerificationResult =
  | {
      verified: true;
      sha256: string;
      byteLength: number;
      checkedAt: string;
    }
  | {
      verified: false;
      reason:
        | "DIGEST_ONLY"
        | "MISSING_DIGEST"
        | "UNSUPPORTED_REFERENCE"
        | "UNTRUSTED_ORIGIN"
        | "OBJECT_NOT_FOUND"
        | "ARTIFACT_TOO_LARGE"
        | "HASH_MISMATCH"
        | "FETCH_FAILED";
    };

type ArtifactObject = {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type ArtifactBucket = {
  get(key: string): Promise<ArtifactObject | null>;
};

type ArtifactVerificationDependencies = {
  bucket?: ArtifactBucket;
  fetchImpl?: typeof fetch;
  allowedHttpsOrigins?: string[];
  checkedAt?: Date;
};

const FIELD_EVIDENCE_MAX_AGE_MS = 180 * 24 * 3_600_000;
// Registry artifacts are compact CSV/JSON manifests. Large photos or videos
// stay in access-controlled storage and are referenced by hashes from that
// manifest, preventing release checks from exhausting Worker memory.
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
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
  if (
    /^r2:\/\/REGION_PACKS\/field-evidence\/[A-Za-z0-9._~!$&'()*+,;=@/-]+#sha256=[a-f0-9]{64}$/i.test(
      normalized,
    ) &&
    !normalized.includes("..")
  ) {
    return true;
  }
  try {
    const url = new URL(normalized);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !/\s/.test(normalized) &&
      /^#sha256=[a-f0-9]{64}$/i.test(url.hash)
    );
  } catch {
    return false;
  }
}

function runtimeArtifactBucket(): ArtifactBucket | undefined {
  try {
    return (workerEnv as unknown as { REGION_PACKS?: R2Bucket })
      .REGION_PACKS as unknown as ArtifactBucket | undefined;
  } catch {
    return undefined;
  }
}

function configuredArtifactOrigins(): string[] {
  return (getRuntimeSecret("EVIDENCE_ARTIFACT_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
          ? [url.origin]
          : [];
      } catch {
        return [];
      }
    });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function boundedResponseBytes(
  response: Response,
): Promise<ArrayBuffer | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ARTIFACT_BYTES
  ) {
    return null;
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

/**
 * Approval is based on bytes, not a plausible-looking reference. R2 objects
 * are constrained to the field-evidence prefix. HTTPS retrieval is disabled
 * unless an operator supplies an exact-origin allowlist, preventing the
 * evidence endpoint from becoming an SSRF proxy.
 */
export async function verifyArtifactReference(
  reference: string,
  dependencies: ArtifactVerificationDependencies = {},
): Promise<ArtifactVerificationResult> {
  const normalized = reference.trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(normalized)) {
    return { verified: false, reason: "DIGEST_ONLY" };
  }

  let expectedHash: string;
  let bytes: ArrayBuffer;
  const r2Match = normalized.match(
    /^r2:\/\/REGION_PACKS\/(field-evidence\/[A-Za-z0-9._~!$&'()*+,;=@/-]+)#sha256=([a-f0-9]{64})$/i,
  );
  if (r2Match && !r2Match[1].includes("..")) {
    expectedHash = r2Match[2].toLowerCase();
    const bucket = dependencies.bucket ?? runtimeArtifactBucket();
    if (!bucket) return { verified: false, reason: "FETCH_FAILED" };
    let object: ArtifactObject | null;
    try {
      object = await bucket.get(r2Match[1]);
    } catch {
      return { verified: false, reason: "FETCH_FAILED" };
    }
    if (!object) return { verified: false, reason: "OBJECT_NOT_FOUND" };
    if (object.size > MAX_ARTIFACT_BYTES) {
      return { verified: false, reason: "ARTIFACT_TOO_LARGE" };
    }
    try {
      bytes = await object.arrayBuffer();
    } catch {
      return { verified: false, reason: "FETCH_FAILED" };
    }
  } else {
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      return { verified: false, reason: "UNSUPPORTED_REFERENCE" };
    }
    if (url.protocol !== "https:") {
      return { verified: false, reason: "UNSUPPORTED_REFERENCE" };
    }
    const hashMatch = url.hash.match(/^#sha256=([a-f0-9]{64})$/i);
    if (!hashMatch || !SHA256_PATTERN.test(hashMatch[1])) {
      return { verified: false, reason: "MISSING_DIGEST" };
    }
    expectedHash = hashMatch[1].toLowerCase();
    url.hash = "";
    const allowedOrigins = new Set(
      dependencies.allowedHttpsOrigins ?? configuredArtifactOrigins(),
    );
    if (!allowedOrigins.has(url.origin)) {
      return { verified: false, reason: "UNTRUSTED_ORIGIN" };
    }
    let response: Response;
    try {
      response = await (dependencies.fetchImpl ?? fetch)(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/octet-stream,application/json,text/csv;q=0.9,*/*;q=0.5" },
      });
    } catch {
      return { verified: false, reason: "FETCH_FAILED" };
    }
    if (response.status === 404 || response.status === 410) {
      return { verified: false, reason: "OBJECT_NOT_FOUND" };
    }
    if (!response.ok) return { verified: false, reason: "FETCH_FAILED" };
    let bounded: ArrayBuffer | null;
    try {
      bounded = await boundedResponseBytes(response);
    } catch {
      return { verified: false, reason: "FETCH_FAILED" };
    }
    if (!bounded) {
      return { verified: false, reason: "ARTIFACT_TOO_LARGE" };
    }
    bytes = bounded;
  }

  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    return { verified: false, reason: "ARTIFACT_TOO_LARGE" };
  }
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash) {
    return { verified: false, reason: "HASH_MISMATCH" };
  }
  return {
    verified: true,
    sha256: actualHash,
    byteLength: bytes.byteLength,
    checkedAt: (dependencies.checkedAt ?? new Date()).toISOString(),
  };
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
      "artifact reference는 허용된 https:// 또는 r2:// 원본 주소와 #sha256=<64 hex>를 함께 포함해야 합니다.",
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
      requireRate("lockedAppointmentPreservationRate", 100);
      requireRate("availabilityFailClosedRate", 100);
      requireRate("returnRouteVerificationRate", 100);
      requireZero("criticalFalsePositiveCount");
      requireZero("actualClosedRecommendedCount");
      requireZero("appointmentMissedCount");
      if (uniqueRegionPrefixes.size < 6) {
        errors.push("최소 6개 권역의 실전 시나리오가 필요합니다.");
      }
      break;
    case "recovery_speed_and_false_positive": {
      requireSample(100);
      const medianMs = metric(input, "medianMs");
      const p95Ms = metric(input, "p95Ms");
      if (medianMs === undefined || medianMs < 0 || medianMs > 4_000) {
        errors.push("medianMs는 실기기 기준 0~4000 범위여야 합니다.");
      }
      if (p95Ms === undefined || p95Ms < 0 || p95Ms > 8_000) {
        errors.push("p95Ms는 실기기 기준 0~8000 범위여야 합니다.");
      }
      if ((metric(input, "mobileDeviceRunCount") ?? 0) < 20) {
        errors.push("모바일 실기기 측정이 최소 20회 필요합니다.");
      }
      if ((metric(input, "constrainedNetworkRunCount") ?? 0) < 16) {
        errors.push("LTE 또는 Slow 4G 측정이 최소 16회 필요합니다.");
      }
      if ((metric(input, "p75LcpMs") ?? Number.POSITIVE_INFINITY) > 2_500) {
        errors.push("p75LcpMs는 2500 이하여야 합니다.");
      }
      if ((metric(input, "p75InpMs") ?? Number.POSITIVE_INFINITY) > 200) {
        errors.push("p75InpMs는 200 이하여야 합니다.");
      }
      if ((metric(input, "p75Cls") ?? Number.POSITIVE_INFINITY) > 0.1) {
        errors.push("p75Cls는 0.1 이하여야 합니다.");
      }
      requireRate("lockedAppointmentPreservationRate", 100);
      requireRate("availabilityFailClosedRate", 100);
      requireRate("returnRouteVerificationRate", 100);
      requireZero("criticalFalsePositiveCount");
      break;
    }
    case "real_user_usability":
      requireSample(20);
      requireRate("taskCompletionRate", 90);
      requireZero("criticalSafetyIncidentCount");
      if ((metric(input, "localeCount") ?? 0) < 3) {
        errors.push("localeCount는 한국어·영어를 포함해 최소 3이어야 합니다.");
      }
      if ((metric(input, "clarityMean") ?? 0) < 4.2 || (metric(input, "clarityMean") ?? 0) > 5) {
        errors.push("clarityMean은 4.2~5 범위여야 합니다.");
      }
      if ((metric(input, "trustMean") ?? 0) < 4.2 || (metric(input, "trustMean") ?? 0) > 5) {
        errors.push("trustMean은 4.2~5 범위여야 합니다.");
      }
      if ((metric(input, "firstTimeParticipantCount") ?? 0) < 1) {
        errors.push("초행 실사용자 표본이 최소 1명 필요합니다.");
      }
      if ((metric(input, "mobilityNeedsParticipantCount") ?? 0) < 1) {
        errors.push("이동약자 또는 동행자 표본이 최소 1명 필요합니다.");
      }
      break;
    case "field_journeys_six_regions":
      requireSample(12);
      requireRate("completionRate", 90);
      requireRate("constraintPreservationRate", 100);
      requireZero("criticalFalsePositiveCount");
      requireZero("actualClosedRecommendedCount");
      requireZero("appointmentMissedCount");
      if (uniqueRegionPrefixes.size < 6) {
        errors.push("실제 이동은 최소 6개 권역이어야 합니다.");
      }
      if ((metric(input, "busanJourneyCount") ?? 0) < 5) {
        errors.push("부산 실제 이동이 최소 5회 필요합니다.");
      }
      break;
    case "comparative_benchmark_20":
      requireSample(80);
      if ((metric(input, "scenarioCount") ?? 0) < 20) {
        errors.push("동일 조건 비교 시나리오가 최소 20개 필요합니다.");
      }
      if ((metric(input, "methodCount") ?? 0) < 4) {
        errors.push("이어가·수작업·범용 AI·일반 재생성기 4개 방법이 모두 필요합니다.");
      }
      requireZero("ieogaCriticalFalsePositiveCount");
      break;
    case "practitioner_review":
      requireSample(3);
      if (uniqueReviewers.size < 3) {
        errors.push("서로 다른 독립 실무자 검토자가 최소 3명 필요합니다.");
      }
      if ((metric(input, "roleCount") ?? 0) < 3) {
        errors.push("관광·지자체·접근성의 서로 다른 3개 역할이 필요합니다.");
      }
      requireRate("approvalRate", 100);
      requireZero("criticalFindingsOpenCount");
      break;
    case "legal_and_operational_approvals":
      requireSample(8);
      if (uniqueReviewers.size < 2) {
        errors.push("운영 승인 검토와 독립 감사를 분리한 검토자 2명 이상이 필요합니다.");
      }
      if ((metric(input, "controlCount") ?? 0) < 8) {
        errors.push("필수 법률·운영 통제 8종이 모두 필요합니다.");
      }
      if ((metric(input, "approvedControlCount") ?? 0) < 8) {
        errors.push("필수 통제 8종이 모두 승인 상태여야 합니다.");
      }
      requireZero("expiredControlCount");
      break;
    case "partner_embed_pilot":
      requireSample(4);
      requireRate("iframeLoadSuccessRate", 100);
      requireRate("sessionBootstrapSuccessRate", 100);
      requireRate("recoveryRequestSuccessRate", 100);
      requireZero("criticalFailureCount");
      if ((metric(input, "partnerOriginCount") ?? 0) < 1) {
        errors.push("계약된 외부 파트너 origin이 최소 1개 필요합니다.");
      }
      if ((metric(input, "mobileRunCount") ?? 0) < 4) {
        errors.push("모바일 iframe 실증이 최소 4회 필요합니다.");
      }
      if ((metric(input, "mobileBrowserCount") ?? 0) < 3) {
        errors.push("Chrome·Safari·Firefox 모바일 브라우저 3종이 필요합니다.");
      }
      for (const name of ["chromeRunCount", "safariRunCount", "firefoxRunCount"]) {
        if ((metric(input, name) ?? 0) < 1) {
          errors.push(`${name}는 최소 1이어야 합니다.`);
        }
      }
      break;
    case "participant_consent_ledger":
      requireSample(20);
      if (uniqueReviewers.size < 2) {
        errors.push("동의 원장은 제출자와 분리된 검토자 2명 이상이 확인해야 합니다.");
      }
      if ((metric(input, "consentedParticipantCount") ?? 0) < 20) {
        errors.push("consentedParticipantCount는 최소 20이어야 합니다.");
      }
      requireZero("missingConsentCount");
      requireZero("unhonoredWithdrawalCount");
      requireRate("consentRecordMatchRate", 100);
      break;
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
        | "ARTIFACT_UNVERIFIED"
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
  if (
    params.decision === "approved" &&
    !(await verifyArtifactReference(input.artifactReference)).verified
  ) {
    return { updated: false, reason: "ARTIFACT_UNVERIFIED" };
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
  const now = Date.now();
  const entries = await Promise.all(FIELD_EVIDENCE_TYPES.map(async (evidenceType) => {
    const latest = rows.find((row) => row.evidenceType === evidenceType);
    if (!latest) return null;
    const artifactVerification =
      latest.independentAuditStatus === "approved"
        ? await verifyArtifactReference(latest.artifactReference)
        : ({ verified: false, reason: "FETCH_FAILED" } as const);
    const artifactVerified = artifactVerification.verified;
    const summary: FieldEvidenceSummary = {
      evidenceType,
      validated:
        latest.validated &&
        latest.independentAuditStatus === "approved" &&
        artifactVerified &&
        Number.isFinite(Date.parse(latest.measuredAt)) &&
        now - Date.parse(latest.measuredAt) <=
          FIELD_EVIDENCE_MAX_AGE_MS &&
        Date.parse(latest.measuredAt) <= now + 5 * 60_000,
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
      artifactVerified,
      artifactSha256: artifactVerification.verified
        ? artifactVerification.sha256
        : undefined,
    };
    return [evidenceType, summary] as const;
  }));
  return Object.fromEntries(
    entries.filter(
      (entry): entry is NonNullable<(typeof entries)[number]> =>
        entry !== null,
    ),
  );
}
