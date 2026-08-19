import type { JourneyExecution } from "@/lib/recovery/execution";
/* 계약 모듈이 아니라 상수 파일에서 가져온다. 계약 모듈은 세션 비밀을 읽어
   `cloudflare:workers`를 끌고 오므로, 화면 모듈이 그것을 거치면 브라우저 묶음이
   통째로 로드에 실패한다. */
import { SELF_CONFIRMABLE_GAP_CODES } from "@/lib/recovery/self-confirmable-gaps";

export type TravelerLanguage = "ko" | "en";

type OptionWithEvidence = {
  availability?: unknown;
  confirmationRequired?: boolean;
  evidenceGaps?: Array<{ code?: string; note?: string; noteEn?: string }>;
  /* 원래 하려던 활동과 종류가 같은가. 이것이 없으면 화면은 "종류가 달라졌다"와
     "무언가를 확인하지 못했다"를 구별할 수 없다 — 예전에는 둘 다 똑같이
     `confirmationRequired`로만 왔고, 그래서 식당 후보에 "공식 확인이 더
     필요합니다"라는 사실과 다른 문장이 붙었다. */
  purposePreservation?: { status?: string };
};

/* 근거 공백은 아니지만 여행자가 직접 정하면 되는 일. 공백 코드와 같은 자리에서
   다루되 코드 공간을 침범하지 않도록 접두어를 붙인다. */
const PURPOSE_CHANGED_CODE = "PURPOSE_CHANGED";

export type OptionApplicationSafety = {
  canApply: boolean;
  availabilityStatus: string;
  reasons: string[];
  /* 막는 이유가 **전부 "확인하지 못했다"뿐**인가 — 즉 여행자가 직접 확인하면
     열릴 수 있는 안인가.

     "닫혀 있다고 확인된 곳"과 "열려 있는지 모르는 곳"은 여행자에게 전혀 다른
     상황인데, 예전에는 둘 다 똑같이 선택 불가였다. 앞의 것은 헛걸음이 확실하고,
     뒤의 것은 원문 운영시간을 읽거나 전화 한 통으로 풀리는 일이다.
     화면이 그 둘을 갈라 다루려면 먼저 구별할 수 있어야 한다.

     예전 이름은 `hoursUnconfirmedOnly`였고 운영시간에만 열려 있었다. 그래서
     집중률 예측이나 무장애 정보를 확인하지 못한 안은 영구히 적용 불가로 남았다.
     그 셋은 모두 같은 성격의 공백이므로 함께 다룬다. */
  selfConfirmable: boolean;
  /* 직접 확인으로 열리는 공백들의 코드. 화면이 "무엇을 확인해 달라"를 공백마다
     다르게 적을 수 있어야 한다 — 운영시간 안내문을 집중률 예측이 없는 곳에
     붙이면 그 안내가 거짓말을 한다. */
  selfConfirmableCodes: string[];
};

/* 공백마다 "무엇을, 어떻게 확인하면 되는가". 예전에는 세 화면 모두 운영시간
   안내문 하나만 띄웠는데, 집중률 예측이 없는 곳에 "원문 운영시간을 읽어
   주세요"라고 적으면 그 안내가 거짓말을 한다. 여행자가 실제로 할 수 있는 일을
   공백별로 적는다 — 우리가 못 한 확인을 떠넘기는 것이 아니라, 우리가 어디까지
   확인했는지 밝히고 남은 한 걸음을 알려 주는 것이다. */
const SELF_CONFIRMATION_GUIDE: Record<
  string,
  { ko: { what: string; how: string }; en: { what: string; how: string } }
> = {
  OPERATING_HOURS_UNVERIFIED: {
    ko: {
      what: "운영시간",
      how: "아래 공식 운영시간 원문을 읽거나, 문의 전화로 오늘 여는지 확인해 주세요.",
    },
    en: {
      what: "Opening hours",
      how: "Read the official hours below, or call the venue to check today's opening.",
    },
  },
  CONCENTRATION_UNVERIFIED: {
    ko: {
      what: "붐빔 예측",
      how: "이 곳은 공사 집중률 예측에 없어요. 붐비는 것이 걱정되면 지도 앱의 실시간 혼잡도를 함께 보고 정해 주세요.",
    },
    en: {
      what: "Crowding forecast",
      how: "This place is absent from the official forecast. If crowding matters, check a live map app before you go.",
    },
  },
  ACCESSIBILITY_UNVERIFIED: {
    ko: {
      what: "이동 편의 정보",
      how: "계단·경사로·화장실이 공식 무장애 정보에 없어요. 문의 전화로 확인하는 편이 확실합니다.",
    },
    en: {
      what: "Accessibility",
      how: "Steps, ramps and toilets are not in the official barrier-free data. Calling ahead is the reliable check.",
    },
  },
  INDOOR_UNVERIFIED: {
    ko: {
      what: "실내 여부",
      how: "실내인지 공식 정보로 확인하지 못했어요. 대표 사진과 안내를 보고 정해 주세요.",
    },
    en: {
      what: "Indoor or not",
      how: "Official data does not say whether this is indoors. Use the photo and venue notes to decide.",
    },
  },
  /* 이것만은 "확인하지 못했다"가 아니다. 운영시간·경로·필수 조건은 모두 확인됐고,
     원래 하려던 활동과 종류가 다를 뿐이다. 그 판단은 애초에 우리가 할 일이
     아니었다 — 관광을 하려다 식사를 하기로 마음을 바꾸는 것은 여행자의 자유다. */
  PURPOSE_CHANGED: {
    ko: {
      what: "여행 종류",
      how: "원래 하려던 것과 종류가 다른 곳이에요. 운영시간과 경로는 확인했으니, 이 종류로 바꿔도 괜찮은지만 정해 주세요.",
    },
    en: {
      what: "Kind of activity",
      how: "This is a different kind of place than you planned. Opening and route are verified — only you can decide whether the change suits you.",
    },
  },
};

/**
 * 직접 확인으로 열리는 공백들에 대해, 무엇을 어떻게 확인하면 되는지.
 *
 * 목록에 없는 코드는 조용히 버리지 않고 일반 문구로 남긴다 — 새 공백 코드가
 * 생겼을 때 화면에서 그 항목이 사라지면, 여행자는 확인할 것이 하나 줄었다고
 * 잘못 읽는다.
 */
export function selfConfirmationChecklist(
  codes: readonly string[],
  language: TravelerLanguage,
): Array<{ code: string; what: string; how: string }> {
  return codes.map((code) => {
    const guide = SELF_CONFIRMATION_GUIDE[code]?.[language];
    if (guide) return { code, ...guide };
    return {
      code,
      what: language === "en" ? "A required condition" : "필수 조건",
      how:
        language === "en"
          ? "Official data did not confirm this. Please check with the venue before you go."
          : "공식 정보로 확인하지 못했어요. 출발 전 운영기관에 확인해 주세요.",
    };
  });
}

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
  /* 직접 확인으로 풀리지 않는 이유가 하나라도 있으면 그 카드는 여전히 막힌다. */
  let unresolvableReason = false;
  const selfConfirmableCodes: string[] = [];

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
    /* 서버 계약과 **같은 목록**을 본다. 화면이 따로 목록을 들고 있으면 둘이
       어긋나, 버튼은 열리는데 서버가 거절하는 상태가 만들어진다. */
    if (gap.code && SELF_CONFIRMABLE_GAP_CODES.has(gap.code)) {
      if (!selfConfirmableCodes.includes(gap.code)) {
        selfConfirmableCodes.push(gap.code);
      }
    } else {
      unresolvableReason = true;
    }
    if (!reasons.includes(message)) reasons.push(message);
  }

  if (option.confirmationRequired && reasons.length === 0) {
    /* 공백이 하나도 없는데 확인이 필요하다고 표시된 안. 엔진에서 이 조합은
       **활동 종류가 바뀐 경우 하나뿐**이다(`changed_visit_category`).

       예전에는 여기서 `unresolvableReason`을 세워 영구 적용 불가로 만들고
       "필수 여행 조건에 공식 확인이 더 필요합니다"라고 적었다. 두 가지가
       잘못됐다. 첫째, 확인하지 못한 것이 없으므로 그 문장은 거짓이다 —
       운영시간도 경로도 확인됐다. 둘째, 관광 대신 식사를 하기로 정하는 것은
       근거의 문제가 아니라 여행자의 선택인데 우리가 그 선택을 막았다.
       실측: 대전 식당 후보 두 곳이 이 사유로 영구 적용 불가였다. */
    if (
      option.purposePreservation?.status === "changed_visit_category" ||
      option.purposePreservation?.status === undefined
    ) {
      selfConfirmableCodes.push(PURPOSE_CHANGED_CODE);
      reasons.push(
        language === "en"
          ? "This is a different kind of place than you originally planned."
          : "원래 하려던 것과 종류가 다른 곳입니다.",
      );
    } else {
      unresolvableReason = true;
      reasons.push(
        language === "en"
          ? "A required travel condition still needs official confirmation."
          : "필수 여행 조건에 공식 확인이 더 필요합니다.",
      );
    }
  }

  return {
    canApply: reasons.length === 0,
    availabilityStatus,
    reasons,
    /* 닫혀 있다고 확인된 곳은 여기에 들지 않는다. 그것은 확인하지 못한 것이
       아니라 확인된 사실이고, 확인을 한 번 더 받는다고 문이 열리지는 않는다. */
    selfConfirmable:
      reasons.length > 0 &&
      !unresolvableReason &&
      availabilityStatus !== "confirmed_closed",
    selfConfirmableCodes,
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
  return safety.canApply || safety.selfConfirmable;
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
