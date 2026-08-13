import {
  recoveryRequestSchema,
  type RecoveryRequest,
} from "./schema";

/* One reference-time contract is shared by the first-party, embed and partner
   recovery routes. Six hours is deliberately the same horizon that the
   open-window flow already enforced: routing and hourly weather forecasts are
   useful inside that window, while a longer horizon would present volatile
   operating and transit information as if it were dependable. */
export const MAX_REFERENCE_TIME_FUTURE_MINUTES = 360;
export const REFERENCE_TIME_PAST_TOLERANCE_MS = 60_000;

export type RecoveryReferenceTime = {
  mode: "current" | "assumed";
  at: string;
};

export type RecoveryReferenceTimeError = {
  code:
    | "REFERENCE_TIME_IN_PAST"
    | "REFERENCE_TIME_TOO_FAR"
    | "REFERENCE_TIME_CONFLICT"
    | "REFERENCE_TIME_CONTRACT_INVALID";
  message: string;
  serverTime: string;
  fields?: Array<{ path: string; message: string }>;
};

export type RecoveryReferenceTimeResolution =
  | {
      success: true;
      input: RecoveryRequest;
      referenceTime: RecoveryReferenceTime;
    }
  | { success: false; error: RecoveryReferenceTimeError };

function legacyReferenceTime(input: RecoveryRequest): string | undefined {
  return input.openWindow?.departureAt ?? input.itinerary?.occurredAt;
}

/**
 * Returns the instant the engine must use. API routes pass a canonical input,
 * but this fallback also keeps direct engine callers and older stored evidence
 * deterministic instead of silently reverting a future request to Date.now().
 */
export function recoveryReferenceTime(
  input: RecoveryRequest,
  fallback = new Date(),
): RecoveryReferenceTime {
  const explicit = input.referenceTime;
  const legacy = legacyReferenceTime(input);
  const legacyMs = legacy ? Date.parse(legacy) : Number.NaN;
  const candidate =
    explicit?.mode === "assumed"
      ? explicit.at
      : explicit?.mode === "current"
        ? Number.isFinite(legacyMs) &&
          Math.abs(legacyMs - fallback.getTime()) <=
            REFERENCE_TIME_PAST_TOLERANCE_MS
          ? legacy!
          : fallback.toISOString()
        : legacy ?? fallback.toISOString();
  const parsed = Date.parse(candidate);
  const at = Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : fallback.toISOString();
  return {
    mode: explicit?.mode ?? (legacy ? "assumed" : "current"),
    at,
  };
}

/**
 * Resolves client intent against the server clock and rewrites the path-local
 * timestamps used by the existing engine. The second schema parse is
 * intentional: it proves that the chosen instant is still before every
 * preserved locked appointment and before an open-window deadline.
 */
export function resolveRecoveryReferenceTime(
  input: RecoveryRequest,
  serverNow = new Date(),
): RecoveryReferenceTimeResolution {
  const serverTime = serverNow.toISOString();
  const serverMs = serverNow.getTime();
  const explicit = input.referenceTime;
  const legacy = legacyReferenceTime(input);

  let mode: RecoveryReferenceTime["mode"];
  let referenceMs: number;
  if (explicit?.mode === "assumed") {
    mode = "assumed";
    referenceMs = Date.parse(explicit.at);
  } else if (explicit?.mode === "current") {
    mode = "current";
    referenceMs = serverMs;
  } else if (legacy) {
    /* Backward compatibility for clients that predate the top-level contract.
       An explicitly supplied departure/incident time remains authoritative. */
    mode = "assumed";
    referenceMs = Date.parse(legacy);
  } else {
    mode = "current";
    referenceMs = serverMs;
  }

  if (referenceMs < serverMs - REFERENCE_TIME_PAST_TOLERANCE_MS) {
    return {
      success: false,
      error: {
        code: "REFERENCE_TIME_IN_PAST",
        message:
          "조회 기준 시간은 현재 시각 또는 현재부터 6시간 이내로 선택해 주세요.",
        serverTime,
      },
    };
  }
  if (
    referenceMs >
    serverMs + MAX_REFERENCE_TIME_FUTURE_MINUTES * 60_000
  ) {
    return {
      success: false,
      error: {
        code: "REFERENCE_TIME_TOO_FAR",
        message:
          "조회 기준 시간은 현재부터 최대 6시간 뒤까지 선택할 수 있습니다.",
        serverTime,
      },
    };
  }

  if (explicit && legacy) {
    const legacyMs = Date.parse(legacy);
    const conflicts =
      explicit.mode === "assumed"
        ? legacyMs !== referenceMs
        : Math.abs(legacyMs - serverMs) >
          REFERENCE_TIME_PAST_TOLERANCE_MS;
    if (conflicts) {
      return {
        success: false,
        error: {
          code: "REFERENCE_TIME_CONFLICT",
          message:
            "조회 기준 시간과 일정의 기준 시각이 서로 다릅니다. 하나의 시각으로 다시 선택해 주세요.",
          serverTime,
        },
      };
    }
  }

  const at = new Date(referenceMs).toISOString();
  const expectedOpenWindowEndMs =
    referenceMs + input.availableMinutes * 60_000;
  const submittedOpenWindowEndMs = input.openWindow
    ? Date.parse(input.openWindow.availableUntil)
    : Number.NaN;
  if (input.openWindow) {
    /* The client constructs this absolute end from its own clock. In current
       mode the server receives the request milliseconds later, so exact
       equality would reject every healthy request. More than one minute is a
       genuine conflict; up to one minute is transport/clock skew and the
       canonical end below preserves the declared duration exactly. */
    if (
      Math.abs(submittedOpenWindowEndMs - expectedOpenWindowEndMs) >
      REFERENCE_TIME_PAST_TOLERANCE_MS
    ) {
      return {
        success: false,
        error: {
          code: "REFERENCE_TIME_CONFLICT",
          message:
            "조회 기준 시간과 선택한 자유 시간의 종료 시각이 서로 다릅니다. 시간을 다시 선택해 주세요.",
          serverTime,
        },
      };
    }
  }
  const canonicalDraft: RecoveryRequest = {
    ...input,
    referenceTime:
      mode === "current"
        ? { mode: "current" }
        : { mode: "assumed", at },
    ...(input.itinerary
      ? {
          itinerary: {
            ...input.itinerary,
            occurredAt: at,
          },
        }
      : {}),
    ...(input.openWindow
      ? {
          openWindow: {
            ...input.openWindow,
            departureAt: at,
            availableUntil: new Date(expectedOpenWindowEndMs).toISOString(),
            ...(input.openWindow.nextPlace
              ? {
                  nextPlace: {
                    ...input.openWindow.nextPlace,
                    /* The current-time client builds both values from the
                       same local instant. Shift that matching value with the
                       canonical end; preserve a genuinely later appointment. */
                    arriveBy:
                      Math.abs(
                        Date.parse(input.openWindow.nextPlace.arriveBy) -
                          submittedOpenWindowEndMs,
                      ) <= REFERENCE_TIME_PAST_TOLERANCE_MS
                        ? new Date(expectedOpenWindowEndMs).toISOString()
                        : input.openWindow.nextPlace.arriveBy,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  const canonical = recoveryRequestSchema.safeParse(canonicalDraft);
  if (!canonical.success) {
    return {
      success: false,
      error: {
        code: "REFERENCE_TIME_CONTRACT_INVALID",
        message:
          "선택한 조회 기준 시간에는 다음 고정 일정과 자유 시간 조건을 지킬 수 없습니다.",
        serverTime,
        fields: canonical.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }

  return {
    success: true,
    input: canonical.data,
    referenceTime: { mode, at },
  };
}
