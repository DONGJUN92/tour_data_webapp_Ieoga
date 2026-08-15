import type { JourneyExecution } from "@/lib/recovery/execution";

export type TravelerLanguage = "ko" | "en";

type OptionWithEvidence = {
  availability?: unknown;
  confirmationRequired?: boolean;
  evidenceGaps?: Array<{ code?: string; note?: string; noteEn?: string }>;
};

export type OptionApplicationSafety = {
  canApply: boolean;
  availabilityStatus: string;
  reasons: string[];
  /* 막는 이유가 **운영시간을 대조하지 못했다는 것 하나뿐**인가.
     "닫혀 있다고 확인된 곳"과 "열려 있는지 모르는 곳"은 여행자에게 전혀 다른
     상황인데, 예전에는 둘 다 똑같이 선택 불가였다. 앞의 것은 헛걸음이 확실하고,
     뒤의 것은 원문 운영시간을 읽거나 전화 한 통으로 풀리는 일이다.
     화면이 그 둘을 갈라 다루려면 먼저 구별할 수 있어야 한다. */
  hoursUnconfirmedOnly: boolean;
};

export type VerifiedTravelerOrigin = {
  latitude: number;
  longitude: number;
  label: string;
  areaCode: string;
  sigunguCode?: string;
};

/**
 * Reverse-geocoding responses have historically appeared both at the root
 * and below `location`/`data`. Accept those documented envelopes, but never
 * turn an error body or a payload without an official Korean region into a
 * confirmed origin. Raw browser coordinates alone are not a resolved place.
 */
export function verifiedTravelerOrigin(
  payload: unknown,
  coordinates: { latitude: number; longitude: number },
): VerifiedTravelerOrigin | null {
  const root = record(payload);
  const resolved = record(root?.location) ?? record(root?.data) ?? root;
  const label =
    typeof resolved?.label === "string" ? resolved.label.trim() : "";
  const areaCode =
    typeof resolved?.areaCode === "string"
      ? resolved.areaCode.trim()
      : typeof resolved?.regionCode === "string"
        ? resolved.regionCode.trim()
        : "";
  const sigunguCode =
    typeof resolved?.sigunguCode === "string"
      ? resolved.sigunguCode.trim()
      : typeof resolved?.districtCode === "string"
        ? resolved.districtCode.trim()
        : "";
  const latitude = Number(coordinates.latitude);
  const longitude = Number(coordinates.longitude);
  const regionValid = /^\d{2}(?:\d{3})?$/.test(areaCode);
  const districtValid =
    !sigunguCode ||
    (/^\d{5}$/.test(sigunguCode) &&
      (areaCode.length !== 2 || sigunguCode.startsWith(areaCode)));

  if (
    !label ||
    !regionValid ||
    !districtValid ||
    !Number.isFinite(latitude) ||
    latitude < 32 ||
    latitude > 39.8 ||
    !Number.isFinite(longitude) ||
    longitude < 124 ||
    longitude > 132
  ) {
    return null;
  }
  return {
    latitude,
    longitude,
    label,
    areaCode,
    ...(sigunguCode ? { sigunguCode } : {}),
  };
}

/**
 * Preserve the duration the traveller selected. Rounding `now + N` down to a
 * clock grid silently turned a 60-minute choice into a 30-59 minute window.
 * Duration choices may use a 30-minute grid; their deadline must not shrink.
 */
export function windowEndIsoFromMinutes(
  minutes: number,
  nowMs = Date.now(),
): string {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isInteger(minutes) ||
    minutes <= 0
  ) {
    throw new RangeError("A positive whole-minute window is required.");
  }
  return new Date(nowMs + minutes * 60_000).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A recommendation is actionable only when the whole proposed stay is
 * explicitly confirmed open and every other required condition is verified.
 *
 * This deliberately fails closed. A missing status is not the same as open,
 * and a traveller should never discover that distinction at the venue door.
 */
export function optionApplicationSafety(
  option: OptionWithEvidence,
  language: TravelerLanguage,
): OptionApplicationSafety {
  const availabilityStatus = String(record(option.availability)?.status ?? "unknown");
  const reasons: string[] = [];
  /* 운영시간 말고 다른 이유가 하나라도 있으면 그 카드는 여전히 막힌다. */
  let nonHoursReason = false;

  if (availabilityStatus === "confirmed_closed") {
    reasons.push(
      language === "en"
        ? "Official information says this place is closed for the proposed visit."
        : "공식 운영정보상 제안된 방문 시간에는 문을 열지 않습니다.",
    );
  } else if (availabilityStatus !== "confirmed_open") {
    reasons.push(
      language === "en"
        ? "Opening for the entire proposed stay has not been confirmed."
        : "제안된 체류 시간 전체의 운영 여부를 확인하지 못했습니다.",
    );
  }

  for (const gap of option.evidenceGaps ?? []) {
    const message =
      (language === "en" ? gap.noteEn : gap.note) ||
      gap.note ||
      (language === "en"
        ? "A required travel condition has not been verified."
        : "필수 여행 조건의 공식 근거를 확인하지 못했습니다.");
    if (gap.code !== "OPERATING_HOURS_UNVERIFIED") nonHoursReason = true;
    if (!reasons.includes(message)) reasons.push(message);
  }

  if (option.confirmationRequired && reasons.length === 0) {
    nonHoursReason = true;
    reasons.push(
      language === "en"
        ? "A required travel condition still needs official confirmation."
        : "필수 여행 조건에 공식 확인이 더 필요합니다.",
    );
  }

  return {
    canApply: reasons.length === 0,
    availabilityStatus,
    reasons,
    /* 닫혀 있다고 확인된 곳은 여기에 들지 않는다. 그것은 확인하지 못한 것이
       아니라 확인된 사실이고, 확인을 한 번 더 받는다고 문이 열리지는 않는다. */
    hoursUnconfirmedOnly:
      reasons.length > 0 &&
      !nonHoursReason &&
      availabilityStatus !== "confirmed_closed",
  };
}

/**
 * 확인을 받으면 고를 수 있는 안인가.
 *
 * 세 화면이 같은 판단을 각자 적어 두면 갈라진다. 실제로 갈라져서, 한 화면은
 * 카드를 흐리게 칠하고 다른 화면은 목록에서 아예 세지 않았다. 판단은 한 곳에
 * 둔다.
 *
 * 공유는 이 문을 열지 않는다. 적용은 내가 감수하는 선택이고, 공유는 "이 경로는
 * 공식 근거로 검증됐다"는 증명서를 다른 사람에게 건네는 일이다. 확인하지 못한
 * 것이 있는 결과에 그 증명서를 붙이면 받는 사람이 속는다.
 */
export function optionSelectableWithAcknowledgement(
  safety: OptionApplicationSafety,
): boolean {
  return safety.canApply || safety.hoursUnconfirmedOnly;
}

export type LockedAppointmentSnapshot = {
  id: string;
  startAt: string;
  title?: string;
  locked: boolean;
  reservation: boolean;
};

export type AppliedRecoveryExpectation = {
  runId: string;
  optionId: string;
  baseItineraryId?: string;
};

/**
 * A POST response is not authoritative by itself. In particular, an old
 * A execution can be returned after A -> B -> A while B remains the session's
 * active execution. Keep this check small and explicit so the UI cannot turn
 * a stale 200 response into a usable cockpit.
 */
export function executionMatchesAppliedRecovery(
  execution: JourneyExecution | null,
  expected: AppliedRecoveryExpectation,
): execution is JourneyExecution {
  return Boolean(
    execution &&
      execution.id.trim() &&
      execution.status === "active" &&
      execution.sourceRunId === expected.runId &&
      execution.sourceOptionId === expected.optionId &&
      (!expected.baseItineraryId ||
        execution.baseItineraryId === expected.baseItineraryId),
  );
}

function sameExecutionTopology(
  left: JourneyExecution,
  right: JourneyExecution,
): boolean {
  if (
    left.baseItineraryId !== right.baseItineraryId ||
    left.currentStepSequence !== right.currentStepSequence ||
    left.nextFixedStepSequence !== right.nextFixedStepSequence ||
    left.steps.length !== right.steps.length
  ) {
    return false;
  }

  return left.steps.every((step, index) => {
    const authoritativeStep = right.steps[index];
    return Boolean(
      authoritativeStep &&
        authoritativeStep.id === step.id &&
        authoritativeStep.sequence === step.sequence &&
        authoritativeStep.role === step.role &&
        authoritativeStep.originalNodeId === step.originalNodeId &&
        authoritativeStep.contentId === step.contentId &&
        authoritativeStep.title === step.title &&
        authoritativeStep.type === step.type &&
        authoritativeStep.scheduledAt === step.scheduledAt &&
        authoritativeStep.estimatedArrivalAt === step.estimatedArrivalAt &&
        authoritativeStep.durationMinutes === step.durationMinutes &&
        authoritativeStep.locationLabel === step.locationLabel &&
        authoritativeStep.latitude === step.latitude &&
        authoritativeStep.longitude === step.longitude &&
        authoritativeStep.locked === step.locked &&
        authoritativeStep.reservation === step.reservation &&
        authoritativeStep.verificationStatus === step.verificationStatus &&
        authoritativeStep.status === step.status,
    );
  });
}

/**
 * Accept an applied recovery only after the authoritative active endpoint
 * confirms the exact same active execution and immutable itinerary topology.
 * This closes both stale version-key reuse and out-of-order response races.
 */
export function authoritativeExecutionMatchesApply(
  applyExecution: JourneyExecution | null,
  activeExecution: JourneyExecution | null,
  expected: AppliedRecoveryExpectation,
): boolean {
  return Boolean(
    executionMatchesAppliedRecovery(applyExecution, expected) &&
      executionMatchesAppliedRecovery(activeExecution, expected) &&
      activeExecution.id === applyExecution.id &&
      sameExecutionTopology(applyExecution, activeExecution),
  );
}

function sameInstant(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

/**
 * Checks the server response before the UI accepts an applied recovery.
 * The protected node must retain its identity, immutable appointment time and
 * lock flags. An estimated arrival is allowed to change; scheduledAt is not.
 */
export function executionPreservesLockedAppointment(
  execution: Pick<JourneyExecution, "steps" | "nextFixedStepSequence">,
  locked: LockedAppointmentSnapshot,
): boolean {
  const nextFixed = execution.steps.find(
    (step) =>
      step.role === "next_fixed" &&
      step.sequence === execution.nextFixedStepSequence,
  );

  return Boolean(
    nextFixed &&
      nextFixed.originalNodeId === locked.id &&
      sameInstant(nextFixed.scheduledAt, locked.startAt) &&
      nextFixed.locked === locked.locked &&
      nextFixed.reservation === locked.reservation &&
      (!locked.title || nextFixed.title === locked.title),
  );
}
