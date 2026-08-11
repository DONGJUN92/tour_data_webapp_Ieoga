"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  JourneyExecution,
  JourneyExecutionStep,
} from "@/lib/recovery/execution";
import type { RejectionReasonCode } from "@/lib/recovery/types";
import {
  formatCrowd,
  sortSimpleOptions,
  MAX_APPOINTMENT_MINUTES,
  MIN_APPOINTMENT_MINUTES,
  appointmentAfterMinutesInKorea,
  appointmentMinutesFromNow,
  normalizeJourneyExecution,
  parseKoreaCoordinate,
} from "../product-app-model";
import { withParticle } from "@/lib/text/korean";
import { sourceLabelText, statusLabel } from "@/lib/text/status-labels";
import {
  authoritativeExecutionMatchesApply,
  executionPreservesLockedAppointment,
  optionApplicationSafety,
  type LockedAppointmentSnapshot,
} from "../traveler-safety";
import styles from "./flow.module.css";

/* Bridge recovery: the traveller answers three questions (what happened,
   where are you, when is the next fixed appointment) and nothing else. The
   two-node itinerary the recovery engine requires is synthesised from those
   answers, so no itinerary-registration form is ever shown. This reuses the
   existing engine unchanged — the entry point is what differs. */

type Step =
  | "incident"
  | "origin"
  | "appointment"
  | "searching"
  | "options"
  | "active"
  | "empty"
  | "error";

const STEP_ORDER: Step[] = [
  "incident",
  "origin",
  "appointment",
  "searching",
  "options",
];

type Incident = "rain" | "delay" | "crowd" | "less_walk";
type Audience = "general" | "stroller" | "wheelchair" | "senior";

type Coordinate = {
  latitude: number;
  longitude: number;
  label: string;
  areaCode?: string;
  sigunguCode?: string;
};

type PlaceHit = {
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  areaCode?: string;
  sigunguCode?: string;
  provider?: "kto" | "kakao_local" | "forward_geocoder";
  matchReason?: string;
  sourceLabel: string;
  retention: "persistable" | "ephemeral";
};

/* The engine returns `sources` as plain API names and `dataContributions` as
   the richer ledger (which API touched which fields, and whether that
   actually changed the decision). The ledger is what proves KTO data was
   load-bearing rather than decorative, so it is preferred when present. */
type DataContribution = {
  source?: string;
  fields?: string[];
  decision?: string;
  effect?: string;
  status?: string;
};

type RecoveryOption = {
  id: string;
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  strategyLabel?: string;
  strategyLabelEn?: string;
  distanceMeters?: number;
  estimatedTravelMinutes?: number;
  availability?: unknown;
  indoorSuitability?: unknown;
  accessibility?: unknown;
  crowd?: unknown;
  evidenceGaps?: Array<{ code?: string; note?: string; noteEn?: string }>;
  confirmationRequired?: boolean;
  why?: string[];
  whyEn?: string[];
  sources?: string[];
  dataContributions?: DataContribution[];
  purposePreservation?: {
    status?: string;
    statement?: string;
    statementEn?: string;
  };
};

type ProofShareLink = {
  runId: string;
  optionId: string;
  relativeUrl: string;
  expiresAt?: string;
  proofKind: "actionable_recovery" | "historical_execution";
  actionability: "current_at_share" | "historical_not_actionable";
  executionStatus?: JourneyExecution["status"];
};

type ProofShareLinks = {
  actionable: ProofShareLink | null;
  historical: ProofShareLink | null;
};

type Language = "ko" | "en";

class RequestError extends Error {
  requestId?: string;

  /* 서버가 실어 보낸 실패 원인. 로그를 볼 수 없는 자리에서 오류가 났고,
     "재시도하세요"만 남으면 다음 수가 없다. */
  cause?: string;

  constructor(message: string, requestId?: string, cause?: string) {
    super(message);
    this.name = "RequestError";
    this.requestId = requestId;
    this.cause = cause;
  }
}



/* Engine reason codes rendered as something a traveller can act on.

   유니온으로 좁혀 둔다. `Record<string, ...>`이었을 때 다섯 개 사유가 라벨 없이
   남아 0건 화면 첫 줄에 `INDOOR_UNVERIFIED · 14곳`처럼 내부 코드가 그대로 찍혔다.
   아래 두 줄은 정상 한국어라 대비까지 됐다. 이제 사유를 추가하고 라벨을 빼먹으면
   컴파일이 막힌다. */
const REJECTION_LABELS: Record<
  RejectionReasonCode,
  { ko: string; en: string }
> = {
  TIME_LIMIT: {
    ko: "약속 시각까지 왕복이 어려움",
    en: "Not enough time before the appointment",
  },
  DISTANCE_LIMIT: {
    ko: "설정한 이동 거리 초과",
    en: "Beyond your travel-distance limit",
  },
  TRAVEL_PURPOSE_MISMATCH: {
    ko: "원래 일정의 목적과 맞지 않음",
    en: "Does not preserve the original travel purpose",
  },
  SAME_AS_DISRUPTED_PLACE: {
    ko: "지금 있는 곳과 같은 장소",
    en: "Same as the disrupted place",
  },
  OFFICIALLY_CLOSED: {
    ko: "그 시각에 운영하지 않음",
    en: "Officially closed at that time",
  },
  OPERATING_STATUS_UNCONFIRMED: {
    ko: "체류 시간 전체의 운영 여부가 확인되지 않음",
    en: "Opening for the full proposed stay is unconfirmed",
  },
  OPERATING_STATUS_UPSTREAM_UNAVAILABLE: {
    ko: "공식 운영정보 연결 실패로 운영 여부를 확인하지 못함",
    en: "Official opening data was unavailable",
  },
  CONCENTRATION_HIGH: {
    ko: "혼잡할 것으로 예측됨",
    en: "Forecast to be highly concentrated",
  },
  ROUTE_UNAVAILABLE: {
    ko: "선택한 이동수단의 실제 경로를 확인하지 못함",
    en: "A real route for the selected travel mode could not be verified",
  },
  NEXT_FIXED_APPOINTMENT_AT_RISK: {
    ko: "다음 약속 도착이 위태로움",
    en: "Next appointment would be at risk",
  },
  INVALID_COORDINATE: {
    ko: "공식 좌표를 확인하지 못함",
    en: "Official coordinates could not be verified",
  },
  INDOOR_UNVERIFIED: {
    ko: "실내에서 지낼 수 있는지 확인되지 않음",
    en: "Indoor use could not be confirmed",
  },
  ACCESSIBILITY_UNVERIFIED: {
    ko: "요청한 이동 편의 조건이 확인되지 않음",
    en: "Requested accessibility could not be confirmed",
  },
  CONCENTRATION_UNVERIFIED: {
    ko: "혼잡 예측을 확인하지 못함",
    en: "Crowd forecast could not be confirmed",
  },
  CONTINUITY_WAYPOINT_AT_RISK: {
    ko: "남은 원래 일정 도착이 위태로움",
    en: "A remaining original stop would be at risk",
  },
  OPEN_WINDOW_OVERFLOW: {
    ko: "남은 시간 안에 다녀오기 어려움",
    en: "Cannot get there and back within your window",
  },
};

/* 서버가 새 사유를 추가하고 이 화면이 아직 라벨을 모르는 경우, 내부 코드를 그대로
   보여주는 대신 그 줄을 빼는 쪽을 고른다. 여행자에게 `INDOOR_UNVERIFIED`는 아무
   정보가 아니고, 사유 목록은 전부 보여야 하는 종류의 정보가 아니기 때문이다.
   합계는 rejectedCount로 따로 표시되므로 수치가 어긋나지도 않는다. */
function knownRejectionSummary(
  value: unknown,
): Array<{ reasonCode: RejectionReasonCode; count: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = entry as { reasonCode?: unknown; count?: unknown };
    const code = String(record?.reasonCode ?? "");
    const count = Number(record?.count);
    return code in REJECTION_LABELS && Number.isFinite(count) && count > 0
      ? [{ reasonCode: code as RejectionReasonCode, count }]
      : [];
  });
}

const INCIDENTS: {
  value: Incident;
  mark: string;
  title: string;
  titleEn: string;
  sub: string;
  subEn: string;
}[] = [
  {
    value: "rain",
    mark: "🌧️",
    title: "비가 와요",
    titleEn: "It is raining",
    sub: "실내로 바꿀 수 있는 곳을 먼저 찾아요",
    subEn: "Find a verified indoor alternative first",
  },
  {
    value: "delay",
    mark: "⏱️",
    title: "일정이 밀렸어요",
    titleEn: "My schedule slipped",
    sub: "다음 약속에 늦지 않는 곳만 찾아요",
    subEn: "Only show places that protect the next appointment",
  },
  {
    value: "crowd",
    mark: "👥",
    title: "사람이 너무 많아요",
    titleEn: "It is too crowded",
    sub: "덜 붐빌 것으로 예측된 곳을 찾아요",
    subEn: "Find a place forecast to be less concentrated",
  },
  {
    value: "less_walk",
    mark: "🦶",
    title: "걷기가 힘들어요",
    titleEn: "Walking is difficult",
    sub: "이동 부담이 적은 곳을 찾아요",
    subEn: "Find an option with a lower mobility burden",
  },
];

const AUDIENCES: { value: Audience; label: string; labelEn: string }[] = [
  {
    value: "general",
    label: "특별한 조건 없음",
    labelEn: "No additional mobility need",
  },
  { value: "stroller", label: "유모차와 함께", labelEn: "With a stroller" },
  {
    value: "wheelchair",
    label: "휠체어 이용",
    labelEn: "Wheelchair user",
  },
  { value: "senior", label: "고령자와 함께", labelEn: "With an older adult" },
];

/* The service is Korea-only, so appointment times are always read as KST
   regardless of the device clock. */
const KST_OFFSET = "+09:00";

function kstIso(date: string, time: string): string {
  return `${date}T${time}:00${KST_OFFSET}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(row: Record<string, unknown> | null, keys: string[]): string {
  if (!row) return "";
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function requestIdFrom(
  response: Response,
  payload: Record<string, unknown> | null,
): string {
  return (
    response.headers.get("x-request-id") ||
    readText(payload, ["requestId"]) ||
    readText(asRecord(payload?.error), ["requestId"]) ||
    ""
  );
}

function errorCauseOf(payload: Record<string, unknown> | undefined): string {
  return readText(asRecord(payload?.error), ["cause"]) || "";
}

function requestErrorText(error: unknown, language: Language): string {
  const requestError = error as RequestError;
  const message =
    requestError?.message ||
    (language === "ko"
      ? "요청을 처리하지 못했습니다."
      : "The request could not be completed.");
  const withCause = requestError?.cause
    ? `${message} (${requestError.cause})`
    : message;
  return requestError?.requestId && !withCause.includes(requestError.requestId)
    ? `${withCause} · ${language === "ko" ? "요청 ID" : "Request ID"} ${requestError.requestId}`
    : withCause;
}

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const root = asRecord(payload);
    const message =
      readText(asRecord(root?.error), ["message"]) ||
      "요청을 처리하지 못했습니다.";
    throw new RequestError(
      message,
      requestIdFrom(response, root) || undefined,
      errorCauseOf(root ?? undefined) || undefined,
    );
  }
  return payload;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const root = asRecord(payload);
    const message =
      readText(asRecord(root?.error), ["message"]) ||
      "요청을 처리하지 못했습니다.";
    throw new RequestError(
      message,
      requestIdFrom(response, root) || undefined,
      errorCauseOf(root ?? undefined) || undefined,
    );
  }
  return payload;
}

function proofShareLinkFromPayload(
  payload: unknown,
  expected: {
    runId: string;
    optionId: string;
    proofKind: ProofShareLink["proofKind"];
    executionId?: string;
  },
): ProofShareLink | null {
  const root = asRecord(payload);
  const proof = asRecord(root?.proof);
  const proofKind = readText(proof, ["proofKind"]);
  const actionability = readText(proof, ["actionability"]);
  const relativeUrl = readText(root, ["url"]);
  const expectedActionability =
    expected.proofKind === "historical_execution"
      ? "historical_not_actionable"
      : "current_at_share";
  if (
    !relativeUrl ||
    readText(proof, ["runId"]) !== expected.runId ||
    readText(proof, ["optionId"]) !== expected.optionId ||
    proofKind !== expected.proofKind ||
    actionability !== expectedActionability
  ) {
    return null;
  }

  let executionStatus: JourneyExecution["status"] | undefined;
  if (expected.proofKind === "historical_execution") {
    const proofExecution = asRecord(proof?.execution);
    const status = readText(proofExecution, ["status"]);
    const terminalStatuses = new Set<JourneyExecution["status"]>([
      "contract_met",
      "contract_missed",
      "completed",
      "abandoned",
      "superseded",
    ]);
    if (
      !expected.executionId ||
      readText(proofExecution, ["id"]) !== expected.executionId ||
      !terminalStatuses.has(status as JourneyExecution["status"])
    ) {
      return null;
    }
    executionStatus = status as JourneyExecution["status"];
  }

  return {
    runId: expected.runId,
    optionId: expected.optionId,
    relativeUrl,
    expiresAt: readText(root, ["expiresAt"]) || undefined,
    proofKind: expected.proofKind,
    actionability: expectedActionability,
    ...(executionStatus ? { executionStatus } : {}),
  };
}

function evidenceText(value: unknown, language: Language): string {
  const record = asRecord(value);
  const status = readText(record, ["status"]);
  /* 영어 화면에서는 같은 근거의 영어 표기를 먼저 쓴다. 없을 때만 한국어로
     내려가고, 그때도 상태 코드가 그대로 보이지는 않는다. */
  const note =
    (language === "en" ? readText(record, ["noteEn"]) : "") ||
    readText(record, ["note"]);
  if (note) return note;
  // 상태 코드는 공용 사전만 통과한다. 미매핑 값을 그대로 흘려보내면
  // `official_hours_unstructured`가 화면에 그대로 찍힌다.
  if (!status) return "—";
  return statusLabel(status, language);
}

function formatKstTime(value: string | undefined, language: Language): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/* 검증 결과 정렬. 값이 없는 후보는 뒤로 보내되 **지우지 않는다** — 이 화면의
   원칙은 폭넓게 보여 주고 고르는 것은 여행자가 하는 것이다. */
/* 정렬도 공용 함수 하나만 쓴다. 따로 두었을 때 `basis` 가중치가 빠져 있었다. */
const sortFlowOptions = sortSimpleOptions;

/* 붐빔은 아이콘 한 개와 단어 하나로. 색만으로 뜻을 나르지 않도록 단어를
   항상 붙인다. 값이 없으면 그 사실을 그대로 적는다. */

/* 표시 규칙은 `product-app-model`의 `formatCrowd` 하나만 쓴다. 여기에 따로
   적어 두었더니 두 화면이 서로 다른 문자열을 냈다. */
const crowdBadgeText = formatCrowd;

function navigationUrl(step: {
  title: string;
  latitude: number;
  longitude: number;
}): string {
  return `https://map.kakao.com/link/to/${encodeURIComponent(step.title)},${step.latitude},${step.longitude}`;
}

function executionRole(step: JourneyExecutionStep, language: Language): string {
  const roles = {
    replacement: { ko: "바뀐 일정", en: "Recovery stop" },
    next_fixed: { ko: "다음 고정 일정", en: "Next fixed appointment" },
    preserved: { ko: "보존 일정", en: "Preserved stop" },
    remaining_original: { ko: "원래 일정", en: "Original itinerary" },
  };
  return roles[step.role][language];
}

export default function FlowApp() {
  const [language, setLanguage] = useState<Language>("ko");
  const [step, setStep] = useState<Step>("incident");
  const [goingBack, setGoingBack] = useState(false);

  const [incident, setIncident] = useState<Incident | null>(null);
  const [audience, setAudience] = useState<Audience>("general");
  const [origin, setOrigin] = useState<Coordinate | null>(null);
  const [originBusy, setOriginBusy] = useState(false);
  const [originNote, setOriginNote] = useState("");
  const [originQuery, setOriginQuery] = useState("");
  const [originHits, setOriginHits] = useState<PlaceHit[]>([]);
  const [originSearchBusy, setOriginSearchBusy] = useState(false);

  /* Keep the server and first client render deterministic, then set the
     promised +150 minute KST default after hydration. This still crosses
     midnight correctly without a rare minute-boundary hydration mismatch. */
  const [appointment, setAppointment] = useState({ date: "", time: "" });
  const apptDate = appointment.date;
  const apptTime = appointment.time;
  const [apptQuery, setApptQuery] = useState("");
  const [apptHits, setApptHits] = useState<PlaceHit[]>([]);
  const [apptPlace, setApptPlace] = useState<PlaceHit | null>(null);
  /* 적용 시 안전 계약을 서버의 authoritative execution과 대조하는 데 필요한
     불변 원본 식별자와 잠근 약속만 보존한다. 적용된 경로는 execution의 새
     버전이며, 이 원본 itinerary를 다시 써서는 안 된다. */
  const [registered, setRegistered] = useState<{
    id: string;
    lockedAppointment: LockedAppointmentSnapshot;
  } | null>(null);
  const [apptBusy, setApptBusy] = useState(false);
  const [apptNote, setApptNote] = useState("");

  const [apiLog, setApiLog] = useState<string[]>([]);
  /* 지점을 물었는데 공식 관광정보에 그 지점이 없을 때, 본점만 조용히
     보여 주면 사용자는 자기가 찾던 지점이라고 오해한다. 마지막 검색의
     지점 해석 결과를 들고 있다가 안내 문장에 쓴다. */
  const lastBranchQuery = useRef<{
    branch: string;
    resolved: boolean;
  } | null>(null);
  const [options, setOptions] = useState<RecoveryOption[]>([]);
  const [rejectedCount, setRejectedCount] = useState(0);
  /* 미확인 조건을 사용자가 명시적으로 확인했는가. 기획 5.4는 정보가 없을 때
     "제외하거나 **사용자 확인을 요구**한다"이고, 예전 구현은 후자를 구현하지 않아
     전자만 남았다. 그래서 유아차·휠체어·고령자를 고르면 무장애 목록에 없는
     후보가 전부 영구 차단되고 전환율이 0이 됐다. 확인을 받으면 적용은 열되,
     무엇이 확인되지 않았는지는 그대로 남겨 카드가 "검증됨"으로 바뀌지는 않는다. */
  /* 우천을 골랐지만 실외까지 포함해 다시 찾고 싶은 경우. 예전에는 이 상태가
     없어 우천을 고르면 실외 후보가 사라지고 되돌릴 방법이 화면에 없었다. */
  const [allowOutdoor, setAllowOutdoor] = useState(false);
  /* Kept as UI state for sessions restored from an older deployment. New
     unsafe options cannot be selected and acknowledgement never overrides the
     fail-closed safety decision. */
  const [acknowledgedOptionId, setAcknowledgedOptionId] = useState("");
  const [rejectionSummary, setRejectionSummary] = useState<
    Array<{ reasonCode: RejectionReasonCode; count: number }>
  >([]);
  const [errorText, setErrorText] = useState("");
  const [errorRequestId, setErrorRequestId] = useState("");
  const [recoveryRequestId, setRecoveryRequestId] = useState("");
  const [recoveryPersisted, setRecoveryPersisted] = useState(false);
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [execution, setExecution] = useState<JourneyExecution | null>(null);
  /* 검증 결과에도 정렬 축을 둔다. 후보를 넓게 보여 주기로 한 뒤에도 이
     화면은 한 순서로만 보여 줘서, 여행자가 "가까운 곳부터" 같은 기준으로 다시
     볼 방법이 없었다. */
  const [optionSort, setOptionSort] = useState<
    "recommended" | "nearest_first" | "quiet_first" | "busy_first"
  >("recommended");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionPriority, setActionPriority] = useState<"polite" | "assertive">(
    "polite",
  );
  const [actionMessage, setActionMessage] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [proofShareLinks, setProofShareLinks] = useState<ProofShareLinks>({
    actionable: null,
    historical: null,
  });
  const [recoveryStale, setRecoveryStale] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);
  const applyAbort = useRef<AbortController | null>(null);
  const applyInFlightRef = useRef(false);
  const applyRequestGenerationRef = useRef(0);
  const arrivalInFlightRef = useRef(false);
  const tr = useCallback(
    (ko: string, en: string) => (language === "ko" ? ko : en),
    [language],
  );

  useEffect(() => {
    document.documentElement.lang = language;
    const original = document.title;
    if (language === "en") {
      document.title = "IEOGA | Recover your trip right now";
    }
    return () => {
      document.documentElement.lang = "ko";
      document.title = original;
    };
  }, [language]);

  /* 단계가 바뀌면 포커스를 그 단계의 제목으로 옮긴다. 예전에는 화면이 통째로
     바뀌어도 포커스가 body에 남아, 스크린리더 사용자는 무엇이 바뀌었는지 듣지
     못하고 키보드 사용자는 Tab을 처음부터 다시 눌러야 했다(WCAG 2.4.3·4.1.3).
     `/accessibility`가 "상태·오류 실시간 안내"를 명시 목표로 걸어 두었으므로
     자기 선언 위반이기도 했다.

     제목은 렌더될 때 `tabIndex={-1}`을 갖는다 — 프로그램으로만 포커스를 받고
     Tab 순서에는 끼지 않는다. */
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const go = useCallback((next: Step, back = false) => {
    setGoingBack(back);
    setStep(next);
  }, []);

  function invalidateRecoveryResults() {
    /* 이미 적용한 실행은 입력 화면의 초안 변경으로 폐기하지 않는다. 그 전의
       실패·빈 결과·후보는 계약 입력이 하나라도 바뀌는 순간 더 이상 현재
       조건의 결과가 아니다. 오래된 경고나 선택을 남겨 두면 사용자가 새 입력에
       대한 판정으로 오해하므로 즉시 모두 비운다. */
    if (step === "active" && execution) return;
    const hadRecoveryState =
      step === "searching" ||
      step === "options" ||
      step === "empty" ||
      step === "error" ||
      Boolean(
        errorText ||
          errorRequestId ||
          recoveryRequestId ||
          options.length ||
          rejectionSummary.length ||
          selectedOptionId ||
          actionMessage,
      );
    if (!hadRecoveryState) return;

    searchAbort.current?.abort();
    if (applyInFlightRef.current) {
      applyRequestGenerationRef.current += 1;
      applyAbort.current?.abort();
      applyAbort.current = null;
      applyInFlightRef.current = false;
      setActionBusy(false);
    }
    setErrorText("");
    setErrorRequestId("");
    setOptions([]);
    setRejectedCount(0);
    setRejectionSummary([]);
    setRecoveryRequestId("");
    setRecoveryPersisted(false);
    setSelectedOptionId("");
    setAcknowledgedOptionId("");
    setExecution(null);
    setRegistered(null);
    setApiLog([]);
    setActionMessage("");
    setActionPriority("polite");
    setShareMessage("");
    setProofShareLinks({ actionable: null, historical: null });
    setRecoveryStale(true);
    if (
      step === "searching" ||
      step === "options" ||
      step === "empty" ||
      step === "error"
    ) {
      go("appointment", true);
    }
  }

  useEffect(
    () => () => {
      searchAbort.current?.abort();
      applyRequestGenerationRef.current += 1;
      applyAbort.current?.abort();
      applyInFlightRef.current = false;
      arrivalInFlightRef.current = false;
    },
    [],
  );

  useEffect(() => {
    const heading = stepHeadingRef.current;
    if (!heading) return;
    /* 렌더가 끝난 뒤에 옮긴다. 같은 프레임에서 부르면 아직 이전 단계의 노드다. */
    const frame = window.requestAnimationFrame(() => {
      heading.focus({ preventScroll: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step]);

  const stepIndex =
    step === "active"
      ? STEP_ORDER.length - 1
      : Math.max(0, STEP_ORDER.indexOf(step));
  const selectedOption =
    options.find((option) => option.id === selectedOptionId) ?? null;
  const originSelectionCurrent = Boolean(
    origin &&
      (!originQuery.trim() || originQuery.trim() === origin.label.trim()),
  );
  const appointmentSelectionCurrent = Boolean(
    apptPlace && apptQuery.trim() === apptPlace.title.trim(),
  );
  const verifiedOptionCount = options.filter(
    (option) => optionApplicationSafety(option, language).canApply,
  ).length;
  const currentExecutionStep = execution
    ? execution.steps.find(
        (entry) => entry.sequence === execution.currentStepSequence,
      ) ?? execution.steps.find((entry) => entry.status === "current")
    : undefined;
  const nextFixedExecutionStep = execution?.steps.find(
    (entry) => entry.sequence === execution.nextFixedStepSequence,
  );
  const executionContractMissed = Boolean(
    execution &&
      (execution.status === "contract_missed" || execution.contractMissedAt),
  );
  const executionContractMet = Boolean(
    execution &&
      !executionContractMissed &&
      (execution.status === "contract_met" || execution.contractMetAt),
  );
  const contractArrivalAt =
    nextFixedExecutionStep?.arrivedAt ??
    execution?.contractMissedAt ??
    execution?.contractMetAt;
  const selectedProofShareLink =
    proofShareLinks.actionable &&
    selectedOption &&
    proofShareLinks.actionable.runId === recoveryRequestId &&
    proofShareLinks.actionable.optionId === selectedOption.id
      ? proofShareLinks.actionable
      : null;
  const executionActionableProofShareLink =
    proofShareLinks.actionable &&
    execution &&
    proofShareLinks.actionable.runId === execution.sourceRunId &&
    proofShareLinks.actionable.optionId === execution.sourceOptionId
      ? proofShareLinks.actionable
      : null;
  const executionHistoricalProofShareLink =
    proofShareLinks.historical &&
    execution &&
    proofShareLinks.historical.runId === execution.sourceRunId &&
    proofShareLinks.historical.optionId === execution.sourceOptionId
      ? proofShareLinks.historical
      : null;

  /* The remaining window shrinks in real time, so the clock lives in state
     rather than being read during render. It stays null until mount so the
     server and first client render agree. */
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const initialize = window.setTimeout(() => {
      const now = new Date();
      setNowMs(now.getTime());
      setAppointment((current) =>
        current.date && current.time
          ? current
          : appointmentAfterMinutesInKorea(now, 150),
      );
    }, 0);
    const clock = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      window.clearTimeout(initialize);
      window.clearInterval(clock);
    };
  }, []);

  /* Minutes between now and the appointment — the window the engine may
     spend. Null while the clock is still unknown. */
  const availableMinutes = useMemo(() => {
    if (nowMs == null) return null;
    return appointmentMinutesFromNow(apptDate, apptTime, nowMs);
  }, [apptDate, apptTime, nowMs]);
  const appointmentDateBounds = useMemo(() => {
    if (nowMs == null) return null;
    const now = new Date(nowMs);
    return {
      minimum: appointmentAfterMinutesInKorea(now, 0).date,
      maximum: appointmentAfterMinutesInKorea(
        now,
        MAX_APPOINTMENT_MINUTES,
      ).date,
    };
  }, [nowMs]);
  const appointmentWindowInvalid =
    nowMs != null &&
    (availableMinutes == null ||
      availableMinutes < MIN_APPOINTMENT_MINUTES ||
      availableMinutes > MAX_APPOINTMENT_MINUTES);


  /* The dominant reason decides what to say. A schedule with no room is a
     different problem from a place that happens to be closed, and telling the
     traveller which one it is turns a dead end into a next step. */
  const emptyReason = useMemo(() => {
    const top = rejectionSummary[0]?.reasonCode;
    if (availableMinutes != null && availableMinutes < 60) {
      return {
        headline: tr(
          "약속까지 남은 시간이 짧아 머물 수 있는 곳이 없습니다. 약속 시각을 늦추면 다시 찾아볼 수 있어요.",
          "There is not enough time for a safe stop. Move the appointment later to search again.",
        ),
      };
    }
    if (top === "TIME_LIMIT" || top === "NEXT_FIXED_APPOINTMENT_AT_RISK") {
      return {
        headline: tr(
          "다녀오면 다음 약속에 늦습니다. 약속 시각을 늦추거나 더 가까운 곳을 찾아보세요.",
          "Every candidate would make you late. Move the appointment later or search from a closer origin.",
        ),
      };
    }
    if (top === "DISTANCE_LIMIT") {
      return {
        headline: tr(
          "이동 거리 조건 안에서는 대안이 없었습니다.",
          "No alternative met your travel-distance limit.",
        ),
      };
    }
    if (top === "OFFICIALLY_CLOSED") {
      return {
        headline: tr(
          "그 시간대에 운영하는 곳이 없었습니다. 시간을 바꾸면 결과가 달라질 수 있어요.",
          "No verified place is open in that time window. Change the time and try again.",
        ),
      };
    }
    if (
      top === "OPERATING_STATUS_UNCONFIRMED" ||
      top === "OPERATING_STATUS_UPSTREAM_UNAVAILABLE"
    ) {
      return {
        headline: tr(
          "공식 운영정보로 체류 시간 전체의 개방 여부를 확인하지 못했습니다. 시간을 바꾸거나 나중에 다시 시도해 주세요.",
          "Official data could not confirm opening for the full stay. Change the time or try again later.",
        ),
      };
    }
    /* 실측에서 가장 많이 나오는 두 사유였는데 둘 다 아래 일반 문구로 떨어져,
       화면이 "왜 없는지"를 말하지 못했다. 우천을 고르면 실내 조건이 함께 걸리므로
       무엇이 후보를 걸러냈는지 이름을 붙여 준다. */
    if (top === "INDOOR_UNVERIFIED") {
      return {
        headline: tr(
          "비를 피할 수 있다고 공식 정보로 확인된 곳이 이 범위에 없었습니다. 상황을 '지연'으로 바꾸면 실외 후보까지 함께 찾습니다.",
          "No place in range is confirmed usable indoors. Switch the situation to a delay to include outdoor options.",
        ),
      };
    }
    if (top === "TRAVEL_PURPOSE_MISMATCH") {
      return {
        headline: tr(
          "원래 하려던 일정과 같은 종류의 장소가 이 범위에 없었습니다. 다른 종류라도 괜찮으시면 조건을 넓혀 다시 찾아보세요.",
          "No place in range matches the kind of stop you planned. Widen the conditions if a different kind is acceptable.",
        ),
      };
    }
    if (top === "ACCESSIBILITY_UNVERIFIED") {
      return {
        headline: tr(
          "요청한 이동 편의 조건이 공식 무장애 정보로 확인된 곳이 없었습니다. 확인되지 않은 곳을 임의로 통과시키지는 않습니다.",
          "No place has your requested accessibility confirmed in the official barrier-free data. We do not pass unverified places through.",
        ),
      };
    }
    if (top === "OPEN_WINDOW_OVERFLOW") {
      return {
        headline: tr(
          "다녀오면 남은 시간을 넘깁니다. 머무는 시간을 줄이거나 시간을 더 확보하면 결과가 달라집니다.",
          "Every candidate would overrun your window. Shorten the stay or allow more time.",
        ),
      };
    }
    return {
      headline: tr(
        "억지로 추천하지 않습니다. 확인하지 못한 후보는 보여드리지 않습니다.",
        "We do not force a recommendation. Unverified candidates stay out of the safe list.",
      ),
    };
  }, [rejectionSummary, availableMinutes, tr]);

  const selectedNeedsAcknowledgement = Boolean(
    selectedOption &&
      !optionApplicationSafety(selectedOption, language).canApply,
  );

  const detectOrigin = useCallback(() => {
    if (!navigator.geolocation) {
      setOriginNote(
        tr(
          "이 브라우저에서는 위치를 확인할 수 없습니다.",
          "This browser cannot access location. Search for the place below.",
        ),
      );
      return;
    }
    setOriginBusy(true);
    setOriginNote(tr("현재 위치를 확인하고 있습니다.", "Locating you…"));
    navigator.geolocation.getCurrentPosition(
      (position) => {
        /* Coordinates are truncated to five decimals and sent in a POST body,
           never a URL, so they stay out of access logs. */
        const latitude = Number(position.coords.latitude.toFixed(5));
        const longitude = Number(position.coords.longitude.toFixed(5));
        postJson("/api/v1/location/resolve", { latitude, longitude })
          .then((payload) => {
            const root = asRecord(payload);
            const resolved =
              asRecord(root?.location) ?? asRecord(root?.data) ?? root;
            setOrigin({
              latitude,
              longitude,
              label:
                readText(resolved, ["label"]) ||
                tr("현재 위치", "Current location"),
              areaCode:
                readText(resolved, ["areaCode", "regionCode"]) || undefined,
              sigunguCode:
                readText(resolved, ["sigunguCode", "districtCode"]) ||
                undefined,
            });
            setOriginQuery("");
            setOriginHits([]);
            const area = readText(resolved, ["areaName", "regionName"]);
            const district = readText(resolved, ["districtName", "sigunguName"]);
            setOriginNote([area, district].filter(Boolean).join(" ") || "");
            setOriginBusy(false);
            go("appointment");
          })
          .catch((error: Error) => {
            setOriginBusy(false);
            setOriginNote(error.message);
          });
      },
      () => {
        setOriginBusy(false);
        setOriginNote(
          tr(
            "위치 권한이 거부되었습니다. 아래에서 장소를 직접 검색해 주세요.",
            "Location permission was declined. Search for your current place below.",
          ),
        );
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, [go, tr]);

  /* Both the origin and the appointment steps resolve a typed place name the
     same way, against the official tourism search. */
  const lookupPlaces = useCallback(async (
    keyword: string,
    purpose: "current_origin" | "saved_stop",
  ): Promise<PlaceHit[]> => {
    const response = await fetch("/api/v1/places/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, purpose, fallback: "auto" }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const root = asRecord(payload);
      throw new RequestError(
        readText(asRecord(asRecord(payload)?.error), ["message"]) ||
          tr("장소를 찾지 못했습니다.", "The place search failed."),
        requestIdFrom(response, root) || undefined,
      );
    }
    const root = asRecord(payload);
    const searchPath = asRecord(root?.searchPath);
    const branch = asRecord(searchPath?.branchQuery);
    lastBranchQuery.current = branch
      ? {
          branch: readText(branch, ["branch"]),
          resolved: branch.branchResolved !== false,
        }
      : null;
    const rows = ["places", "items", "results", "candidates"]
      .map((key) => root?.[key])
      .find(Array.isArray) as unknown[] | undefined;
    return (rows ?? []).flatMap((item): PlaceHit[] => {
      const row = asRecord(item);
      const title = readText(row, ["title", "name"]);
      const rawLatitude = row?.latitude ?? row?.mapY;
      const rawLongitude = row?.longitude ?? row?.mapX;
      const latitude = parseKoreaCoordinate(rawLatitude, 32, 39.8);
      const longitude = parseKoreaCoordinate(rawLongitude, 124, 132);
      const provider = readText(row, ["provider"]);
      const retention = readText(row, ["retention"]);
      if (!title || latitude === undefined || longitude === undefined) {
        return [];
      }
      return [
        {
          title,
          address: readText(row, ["address", "addr1"]) || undefined,
          latitude,
          longitude,
          areaCode: readText(row, ["regionCode", "areaCode"]) || undefined,
          sigunguCode:
            readText(row, ["districtCode", "sigunguCode"]) || undefined,
          provider:
            provider === "kto" ||
            provider === "kakao_local" ||
            provider === "forward_geocoder"
              ? provider
              : undefined,
          sourceLabel:
            readText(row, ["sourceLabel"]) ||
            (provider === "kto"
              ? "한국관광공사 국문 관광정보"
              : "장소 검색 제공자"),
          retention:
            retention === "persistable" ? "persistable" : "ephemeral",
          matchReason: readText(row, ["matchReason"]) || undefined,
        },
      ];
    });
  }, [tr]);

  const searchOriginPlace = useCallback(async () => {
    const keyword = originQuery.trim();
    if (keyword.length < 2) {
      setOriginNote(
        tr(
          "현재 장소명이나 주소를 두 글자 이상 입력해 주세요.",
          "Enter at least two characters for your current place or address.",
        ),
      );
      return;
    }
    setOriginSearchBusy(true);
    setOriginNote("");
    setOrigin(null);
    setOriginHits([]);
    try {
      const hits = await lookupPlaces(keyword, "current_origin");
      setOriginHits(hits.slice(0, 6));
      if (!hits.length) {
        setOriginNote(
          tr(
            "검색 결과가 없습니다. 장소명이나 주소를 다르게 입력해 보세요.",
            "No result. Try a different place name or address.",
          ),
        );
      }
    } catch (error) {
      setOriginNote(requestErrorText(error, language));
    } finally {
      setOriginSearchBusy(false);
    }
  }, [originQuery, lookupPlaces, tr, language]);

  const searchAppointmentPlace = useCallback(async () => {
    const keyword = apptQuery.trim();
    if (keyword.length < 2) {
      setApptNote(
        tr(
          "약속 장소명이나 주소를 두 글자 이상 입력해 주세요.",
          "Enter at least two characters for the appointment place or address.",
        ),
      );
      return;
    }
    setApptBusy(true);
    setApptNote("");
    setApptPlace(null);
    setApptHits([]);
    try {
      /* 약속 장소는 좌표만 있으면 도착 시간을 계산할 수 있다. 예전에는
         공식 관광정보(persistable)만 허용해서, 사무실·신축 상가·프랜차이즈
         지점처럼 관광정보에 없는 약속 장소를 아예 지정할 수 없었다.
         공식 관광정보를 먼저 보여 주고, 아닌 결과는 그렇다고 표시한다. */
      const hits = await lookupPlaces(keyword, "saved_stop");
      const officialFirst = [
        ...hits.filter((hit) => hit.retention === "persistable"),
        ...hits.filter((hit) => hit.retention !== "persistable"),
      ];
      setApptHits(officialFirst.slice(0, 6));
      const branchInfo = lastBranchQuery.current;
      if (hits.length && branchInfo && !branchInfo.resolved) {
        setApptNote(
          tr(
            `‘${branchInfo.branch}’ 지점은 공식 관광정보와 연결된 장소 검색에서 확인되지 않았습니다. 아래는 같은 상호의 다른 지점입니다. 지점이 맞는지 주소로 확인해 주세요.`,
            `The ‘${branchInfo.branch}’ branch was not found in the connected place data. The results below are other branches of the same brand — check the address to confirm.`,
          ),
        );
      }
      if (!hits.length) {
        setApptNote(
          tr(
            "그 이름으로는 찾지 못했습니다. 지점명을 빼고 상호만 넣거나(예: ‘성심당’), 도로명 주소로 다시 검색해 주세요.",
            "Nothing matched that name. Try the brand name without the branch (for example ‘성심당’), or search by street address.",
          ),
        );
      }
    } catch (error) {
      setApptNote(requestErrorText(error, language));
    } finally {
      setApptBusy(false);
    }
  }, [apptQuery, lookupPlaces, tr, language]);

  /* Registers the synthesised two-node itinerary, then runs recovery. The
     traveller sees one "찾는 중" screen while both calls happen. */
  const runRecovery = useCallback(async (
    options: { includeOutdoor?: boolean } = {},
  ) => {
    /* 실외 포함 여부를 인자로 받는다. 상태를 세팅하고 곧바로 실행하면 이
       콜백의 클로저가 아직 옛 값을 보므로, 버튼이 한 번 더 눌려야 반영되는
       경합이 생긴다. */
    const includeOutdoor = options.includeOutdoor ?? allowOutdoor;
    if (
      !incident ||
      !origin ||
      !originSelectionCurrent ||
      !apptPlace ||
      !appointmentSelectionCurrent ||
      availableMinutes == null ||
      availableMinutes < MIN_APPOINTMENT_MINUTES ||
      availableMinutes > MAX_APPOINTMENT_MINUTES
    ) {
      return;
    }
    if (applyInFlightRef.current) {
      applyRequestGenerationRef.current += 1;
      applyAbort.current?.abort();
      applyAbort.current = null;
      applyInFlightRef.current = false;
      setActionBusy(false);
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setApiLog([]);
    setRecoveryStale(false);
    setErrorText("");
    setErrorRequestId("");
    setRecoveryRequestId("");
    setRecoveryPersisted(false);
    setSelectedOptionId("");
    setExecution(null);
    setProofShareLinks({ actionable: null, historical: null });
    setActionPriority("polite");
    setActionMessage("");
    setShareMessage("");
    go("searching");

    const push = (line: string) =>
      setApiLog((previous) =>
        previous.includes(line) ? previous : [...previous, line],
      );

    try {
      const nowIso = new Date().toISOString();
      const nodes = [
        {
          id: "now",
          sequence: 0,
          type: "visit" as const,
          title: "지금 있는 곳",
          startAt: nowIso,
          locked: false,
          reservation: false,
        },
        {
          id: "next",
          sequence: 1,
          type: "reservation" as const,
          title: apptPlace.title,
          startAt: kstIso(apptDate, apptTime),
          locked: true,
          reservation: true,
          location: {
            latitude: apptPlace.latitude,
            longitude: apptPlace.longitude,
            label: apptPlace.title,
            areaCode: apptPlace.areaCode,
            sigunguCode: apptPlace.sigunguCode,
          },
        },
      ];

      push(
        tr(
          "일정 잠금 조건 등록",
          "Registering the protected appointment",
        ),
      );
      const registered = await postJson("/api/v1/itineraries", {
        ephemeralLocationNodeIds: ["now"],
        itinerary: {
          title: "오늘의 여행",
          timezone: "Asia/Seoul",
          audience,
          nodes,
        },
      }, controller.signal);
      const registeredRoot = asRecord(registered);
      const itineraryId = readText(
        asRecord(registeredRoot?.itinerary) ?? registeredRoot,
        ["id"],
      );
      if (itineraryId) {
        setRegistered({
          id: itineraryId,
          lockedAppointment: {
            id: nodes[1].id,
            startAt: nodes[1].startAt,
            title: nodes[1].title,
            locked: nodes[1].locked,
            reservation: nodes[1].reservation,
          },
        });
      }
      if (!itineraryId) {
        throw new Error("일정을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }

      push(
        tr(
          "공식 관광지·좌표·운영 근거 확인",
          "Checking official place, coordinate and opening evidence",
        ),
      );
      push(
        tr(
          "원래 여행 목적과 대안의 연결성 비교",
          "Comparing each option with your original travel purpose",
        ),
      );
      push(
        tr(
          "공식 무장애 정보로 이동 조건 검증",
          "Verifying mobility needs against official accessibility data",
        ),
      );
      push(
        tr(
          "30일 관광 집중률로 상대적 혼잡도 비교",
          "Comparing relative crowding with the 30-day tourism concentration series",
        ),
      );

      const recovered = await postJson("/api/v1/recover", {
        origin,
        incident,
        audience,
        /* 명시적으로 보낸 값이 엔진의 우천 기본값을 이긴다. */
        indoorOnly: incident === "rain" ? !includeOutdoor : false,
        availableMinutes: Math.min(240, availableMinutes),
        maxDistanceMeters: audience === "general" ? 2500 : 1500,
        radiusMeters: 5000,
        safetyBufferMinutes: 15,
        minimumStayMinutes: 30,
        analyticsConsent: false,
        itinerary: {
          id: itineraryId,
          title: "오늘의 여행",
          timezone: "Asia/Seoul",
          audience,
          nodes,
          disruptedNodeId: "now",
          nextFixedNodeId: "next",
        },
      }, controller.signal);

      if (controller.signal.aborted) return;

      const root = asRecord(recovered);
      const list = Array.isArray(root?.options)
        ? (root.options as RecoveryOption[])
        : [];
      const requestId = readText(root, ["requestId"]);
      const persistence = asRecord(root?.persistence);
      const persistedRunId = readText(persistence, ["runId"]);
      setRecoveryRequestId(requestId);
      setRecoveryPersisted(
        Boolean(
          requestId &&
            readText(persistence, ["status"]) === "persisted" &&
            persistedRunId === requestId,
        ),
      );
      setRejectedCount(
        typeof root?.rejectedCount === "number" ? root.rejectedCount : 0,
      );
      setRejectionSummary(knownRejectionSummary(root?.rejectionSummary));
      setOptions(list);
      setAcknowledgedOptionId("");
      setSelectedOptionId(
        list.find(
          (option) =>
            !option.confirmationRequired &&
            (option.evidenceGaps?.length ?? 0) === 0,
        )?.id ?? "",
      );
      go(list.length ? "options" : "empty");
    } catch (error) {
      if (controller.signal.aborted) return;
      const requestError = error as RequestError;
      setErrorText(
        requestError.message ||
          tr(
            "일시적인 연결 문제입니다. 같은 조건으로 다시 시도해 주세요.",
            "A temporary connection problem occurred. Try the same request again.",
          ),
      );
      setErrorRequestId(requestError.requestId ?? "");
      go("error");
    }
  }, [
    incident,
    origin,
    originSelectionCurrent,
    apptPlace,
    appointmentSelectionCurrent,
    apptDate,
    apptTime,
    availableMinutes,
    audience,
    allowOutdoor,
    go,
    tr,
  ]);

  const applySelectedOption = async () => {
    if (!selectedOption) {
      setActionPriority("assertive");
      setActionMessage(
        tr("검증된 복구안을 먼저 선택해 주세요.", "Select a verified recovery option first."),
      );
      return;
    }
    const safety = optionApplicationSafety(selectedOption, language);
    if (!safety.canApply) {
      setActionPriority("assertive");
      setActionMessage(
        safety.reasons.join(" "),
      );
      return;
    }
    if (!recoveryRequestId || !recoveryPersisted || !registered) {
      setActionPriority("assertive");
      setActionMessage(
        tr(
          "저장된 복구 실행을 확인하지 못했습니다. 같은 조건으로 다시 찾아주세요.",
          "This recovery run was not persisted. Run the same search again.",
        ),
      );
      return;
    }
    if (applyInFlightRef.current) {
      setActionPriority("polite");
      setActionMessage(
        tr(
          "서버의 실제 활성 일정을 확인하고 있습니다. 확인이 끝난 뒤 다시 선택해 주세요.",
          "IEOGA is verifying the server's active itinerary. Choose again after the check finishes.",
        ),
      );
      return;
    }

    const expected = {
      runId: recoveryRequestId,
      optionId: selectedOption.id,
      baseItineraryId: registered.id,
    };
    const requestGeneration = ++applyRequestGenerationRef.current;
    const controller = new AbortController();
    let reconciledAuthoritativeExecution = false;
    applyAbort.current = controller;
    applyInFlightRef.current = true;
    setActionBusy(true);
    setActionPriority("polite");
    setActionMessage(
      tr("복구 일정을 적용하고 있습니다.", "Applying the recovery itinerary."),
    );
    try {
      const applyPayload = await postJson(
        `/api/v1/recover/${encodeURIComponent(expected.runId)}/apply`,
        { optionId: expected.optionId },
        controller.signal,
      );
      const applyExecution = normalizeJourneyExecution(applyPayload);
      /* POST 200/201은 적용 성공의 근거가 아니다. 다른 탭의 A→B→A 경합에서
         과거 A 응답을 받을 수 있으므로 같은 요청 세대에서 authoritative GET을
         다시 읽고 실행 식별자·원본·잠금·전체 토폴로지를 모두 대조한다. */
      const activePayload = await getJson(
        "/api/v1/journey/active",
        controller.signal,
      );
      const authoritativeExecution = normalizeJourneyExecution(activePayload);

      if (
        requestGeneration !== applyRequestGenerationRef.current ||
        controller.signal.aborted
      ) {
        return;
      }

      const exactApplication = Boolean(
        applyExecution &&
          authoritativeExecution &&
          authoritativeExecutionMatchesApply(
            applyExecution,
            authoritativeExecution,
            expected,
          ) &&
          applyExecution.baseItineraryId === expected.baseItineraryId &&
          authoritativeExecution.baseItineraryId ===
            expected.baseItineraryId &&
          executionPreservesLockedAppointment(
            applyExecution,
            registered.lockedAppointment,
          ) &&
          executionPreservesLockedAppointment(
            authoritativeExecution,
            registered.lockedAppointment,
          ),
      );

      if (!exactApplication) {
        /* 불일치 시 방금 누른 안을 성공으로 보이지 않는다. GET이 정상 execution을
           돌려줬다면 그것이 서버의 실제 상태이므로 즉시 그 cockpit으로 복원한다. */
        if (authoritativeExecution) {
          setExecution(authoritativeExecution);
          setSelectedOptionId(
            options.some(
              (option) => option.id === authoritativeExecution.sourceOptionId,
            )
              ? authoritativeExecution.sourceOptionId
              : "",
          );
          reconciledAuthoritativeExecution = true;
          go("active");
        }
        throw new Error(
          authoritativeExecution
            ? tr(
                "서버의 실제 활성 일정이 방금 누른 복구안과 달라 적용 성공으로 처리하지 않았습니다. 화면을 서버의 실제 일정으로 복원했습니다.",
                "The server's active itinerary differs from the option you chose, so IEOGA did not report a successful apply. The screen was restored to the server's actual itinerary.",
              )
            : tr(
                "서버가 방금 누른 복구안을 현재 활성 일정으로 확인하지 않아 적용하지 않았습니다. 최신 상황으로 다시 찾아주세요.",
                "The server did not confirm the option as the current active itinerary, so it was not applied. Run recovery again from the latest situation.",
              ),
        );
      }

      if (
        !applyExecution ||
        !authoritativeExecution
      ) {
        throw new Error(
          tr(
            "적용된 복구 일정의 진행 단계를 확인하지 못했습니다.",
            "The applied itinerary did not include executable steps.",
          ),
        );
      }
      /* 적용은 경로를 활성화할 뿐 실제 도착을 증명하지 않는다. 서버가 준
         active 상태를 completed로 덮으면 약속에 도착하기도 전에 계약을
         지켰다고 표시하게 된다. 이후 도착 확인 응답만 실행 상태를 전진시킨다. */
      setExecution(authoritativeExecution);
      setActionPriority("polite");
      setActionMessage(
        tr(
          "복구안이 적용됐습니다. 아래 길찾기와 도착 확인을 순서대로 진행해 주세요.",
          "Recovery applied. Follow navigation and confirm each arrival in order.",
        ),
      );
      go("active");
    } catch (error) {
      if (
        requestGeneration !== applyRequestGenerationRef.current ||
        controller.signal.aborted
      ) {
        return;
      }
      const requestError = error as RequestError;
      setActionPriority("assertive");
      setActionMessage(
        `${requestError.message}${
          requestError.requestId
            ? tr(
                ` · 요청 ID ${requestError.requestId}`,
                ` · Request ID ${requestError.requestId}`,
              )
            : ""
        }`,
      );
    } finally {
      if (requestGeneration === applyRequestGenerationRef.current) {
        applyAbort.current = null;
        applyInFlightRef.current = false;
        setActionBusy(false);
      }
      if (reconciledAuthoritativeExecution) {
        setShareMessage("");
      }
    }
  };

  const presentProofShareLink = async (
    link: ProofShareLink,
    title: string,
  ) => {
    const shareUrl = new URL(link.relativeUrl, window.location.origin);
    if (
      shareUrl.origin !== window.location.origin ||
      !/^\/share\/[^/?#]+$/.test(shareUrl.pathname)
    ) {
      throw new Error(
        tr(
          "공유 링크의 안전한 주소를 확인하지 못했습니다.",
          "The proof link did not have a verified safe address.",
        ),
      );
    }
    const absoluteUrl = shareUrl.toString();
    if (typeof navigator.share === "function") {
      await navigator.share({
        title: `IEOGA · ${title}`,
        text:
          link.proofKind === "historical_execution"
            ? tr(
                "현재 출발 가능 여부가 아닌, 종료된 여행의 실행 이력 증명입니다.",
                "A historical execution record for an ended journey, not proof that it is currently safe to depart.",
              )
            : tr(
                "다음 예약과 원래 목적을 지키는 여행 복구 판정 증명입니다.",
                "A recovery decision proof for protecting the next appointment and original travel purpose.",
              ),
        url: absoluteUrl,
      });
      setShareMessage(
        link.proofKind === "historical_execution"
          ? tr(
              "과거 실행 이력 증명을 공유했습니다. 현재 이동 결정에는 사용할 수 없습니다.",
              "Historical execution proof shared. It must not be used for a current travel decision.",
            )
          : tr("공유 완료", "Shared"),
      );
    } else {
      await navigator.clipboard.writeText(absoluteUrl);
      setShareMessage(
        link.proofKind === "historical_execution"
          ? tr(
              "7일 과거 실행 이력 링크를 복사했습니다. 현재 이동 결정에는 사용할 수 없습니다.",
              "Copied the 7-day historical execution link. It must not be used for a current travel decision.",
            )
          : tr("7일 증명 링크를 복사했습니다.", "Copied the 7-day proof link."),
      );
    }
  };

  const shareSavedProofLink = async (
    link: ProofShareLink,
    title: string,
  ) => {
    setActionBusy(true);
    setActionPriority("polite");
    setShareMessage(tr("저장한 증명 링크를 여는 중…", "Opening the saved proof link…"));
    try {
      await presentProofShareLink(link, title);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setActionPriority("polite");
        setShareMessage(tr("공유를 취소했습니다.", "Sharing cancelled."));
      } else {
        setActionPriority("assertive");
        setShareMessage(requestErrorText(error, language));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const shareSelectedOption = async () => {
    if (
      selectedOption &&
      !optionApplicationSafety(selectedOption, language).canApply
    ) {
      setActionPriority("assertive");
      setShareMessage(
        tr(
          "필수 조건의 공식 근거가 모두 확인되기 전에는 복구 증명을 공유할 수 없습니다.",
          "Proof cannot be shared until every required condition is verified by official evidence.",
        ),
      );
      return;
    }
    if (!selectedOption || !recoveryRequestId || !recoveryPersisted) {
      setActionPriority("assertive");
      setShareMessage(
        tr(
          "저장이 확인된 복구안만 증명 링크를 만들 수 있습니다.",
          "A proof link requires a persisted recovery option.",
        ),
      );
      return;
    }
    setActionBusy(true);
    setActionPriority("polite");
    setShareMessage(
      selectedProofShareLink
        ? tr("저장한 증명 링크를 여는 중…", "Opening the saved proof link…")
        : tr("출발 전 판정 증명 링크 생성 중…", "Creating a pre-departure decision proof…"),
    );
    try {
      let link = selectedProofShareLink;
      if (!link) {
        const payload = await postJson("/api/v1/share", {
            runId: recoveryRequestId,
            optionId: selectedOption.id,
          });
        const createdLink = proofShareLinkFromPayload(payload, {
          runId: recoveryRequestId,
          optionId: selectedOption.id,
          proofKind: "actionable_recovery",
        });
        if (!createdLink) {
          throw new Error(
            tr(
              "서버가 현재 출발 판단에 사용할 수 있는 판정 증명 계약을 확인하지 못했습니다.",
              "The server did not return a verified actionable decision-proof contract.",
            ),
          );
        }
        link = createdLink;
        setProofShareLinks((current) => ({
          ...current,
          actionable: createdLink,
        }));
      }
      await presentProofShareLink(link, selectedOption.title);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setActionPriority("polite");
        setShareMessage(tr("공유를 취소했습니다.", "Sharing cancelled."));
      } else {
        setActionPriority("assertive");
        const requestError = error as RequestError;
        setShareMessage(
          `${requestError.message}${
            requestError.requestId
              ? tr(
                  ` · 요청 ID ${requestError.requestId}`,
                  ` · Request ID ${requestError.requestId}`,
                )
              : ""
          }`,
        );
      }
    } finally {
      setActionBusy(false);
    }
  };

  const createOrShareHistoricalProof = async () => {
    if (!execution) return;
    setActionBusy(true);
    setActionPriority("polite");
    setShareMessage(
      executionHistoricalProofShareLink
        ? tr(
            "저장한 과거 실행 이력 링크를 여는 중…",
            "Opening the saved historical execution link…",
          )
        : tr(
            "현재 이동 결정과 분리된 과거 실행 이력 증명을 만드는 중…",
            "Creating historical execution proof that is separate from any current travel decision…",
          ),
    );
    try {
      let link = executionHistoricalProofShareLink;
      if (!link) {
        const payload = await postJson("/api/v1/share", {
          runId: execution.sourceRunId,
          optionId: execution.sourceOptionId,
        });
        const createdLink = proofShareLinkFromPayload(payload, {
          runId: execution.sourceRunId,
          optionId: execution.sourceOptionId,
          proofKind: "historical_execution",
          executionId: execution.id,
        });
        if (!createdLink) {
          throw new Error(
            tr(
              "서버가 과거 실행 이력과 현재 이동 불가 표시를 함께 확인하지 않아 링크를 만들지 않았습니다.",
              "The server did not confirm both the historical execution and the not-currently-actionable marker, so no link was accepted.",
            ),
          );
        }
        link = createdLink;
        setProofShareLinks((current) => ({
          ...current,
          historical: createdLink,
        }));
      }
      await presentProofShareLink(
        link,
        options.find((option) => option.id === execution.sourceOptionId)?.title ??
          execution.steps[0]?.title ??
          "IEOGA",
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setActionPriority("polite");
        setShareMessage(tr("공유를 취소했습니다.", "Sharing cancelled."));
      } else {
        setActionPriority("assertive");
        setShareMessage(requestErrorText(error, language));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const confirmCurrentArrival = useCallback(async () => {
    if (
      !execution ||
      !currentExecutionStep ||
      execution.status !== "active" ||
      arrivalInFlightRef.current
    ) {
      return;
    }
    if (
      !registered ||
      execution.baseItineraryId !== registered.id ||
      !executionPreservesLockedAppointment(
        execution,
        registered.lockedAppointment,
      )
    ) {
      setActionPriority("assertive");
      setActionMessage(
        tr(
          "서버의 활성 일정이 이 화면의 잠근 약속과 달라 도착 기록을 보내지 않았습니다. 최신 상황으로 다시 복구해 주세요.",
          "The server's active itinerary differs from this screen's protected appointment, so no arrival was sent. Run recovery again from the latest situation.",
        ),
      );
      return;
    }
    const expectedExecution = execution;
    arrivalInFlightRef.current = true;
    setActionBusy(true);
    setActionPriority("polite");
    setActionMessage(
      tr("도착 기록을 저장하고 있습니다.", "Saving your arrival."),
    );
    try {
      const response = await fetch("/api/v1/journey/active", {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "arrive_step",
          stepId: currentExecutionStep.id,
        }),
      });
      const payload = asRecord(await response.json().catch(() => null));
      const normalized = normalizeJourneyExecution(payload);
      if (!response.ok || !normalized) {
        const message =
          readText(asRecord(payload?.error), ["message"]) ||
          tr(
            "도착 기록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
            "Arrival could not be saved. Please retry.",
          );
        throw new RequestError(
          message,
          requestIdFrom(response, payload) || undefined,
        );
      }
      if (
        normalized.id !== expectedExecution.id ||
        normalized.sourceRunId !== expectedExecution.sourceRunId ||
        normalized.sourceOptionId !== expectedExecution.sourceOptionId ||
        normalized.baseItineraryId !== expectedExecution.baseItineraryId ||
        !executionPreservesLockedAppointment(
          normalized,
          registered.lockedAppointment,
        )
      ) {
        throw new Error(
          tr(
            "서버의 활성 일정이 바뀌어 도착 기록을 이 화면에 반영하지 않았습니다. 최신 상황으로 다시 복구해 주세요.",
            "The server's active itinerary changed, so this screen did not accept the arrival response. Run recovery again from the latest situation.",
          ),
        );
      }
      if (
        normalized.status !== "active" &&
        normalized.status !== "contract_met" &&
        normalized.status !== "contract_missed" &&
        normalized.status !== "completed"
      ) {
        throw new Error(
          tr(
            "도착 뒤의 실행 상태를 안전하게 확인하지 못했습니다.",
            "The execution state after arrival could not be verified safely.",
          ),
        );
      }
      setExecution(normalized);
      if (
        normalized.status === "contract_missed" ||
        normalized.contractMissedAt
      ) {
        setActionPriority("assertive");
        setActionMessage(
          tr(
            "도착은 기록했지만 약속 시각을 지키지 못했습니다. 정시 도착 성공으로 표시하지 않습니다.",
            "Arrival was recorded, but the promised time was missed. It is not reported as an on-time success.",
          ),
        );
      } else if (
        normalized.status === "contract_met" ||
        normalized.contractMetAt
      ) {
        setActionPriority("polite");
        setActionMessage(
          tr(
            "다음 고정 일정 도착을 확인했습니다. 원래 일정으로 안전하게 복귀할 수 있습니다.",
            "The fixed appointment is confirmed. You can safely resume the original itinerary.",
          ),
        );
      } else if (normalized.status === "completed") {
        setActionPriority("assertive");
        setActionMessage(
          tr(
            "여행 단계는 끝났지만 약속 준수 근거가 없어 성공으로 표시하지 않습니다.",
            "The trip steps ended, but no appointment outcome was verified, so IEOGA does not show a success.",
          ),
        );
      } else {
        setActionPriority("polite");
        setActionMessage(
          tr(
            "도착을 확인했습니다. 다음 장소로 이어갑니다.",
            "Arrival confirmed. Continue to the next place.",
          ),
        );
      }
    } catch (error) {
      const requestError = error as RequestError;
      setActionPriority("assertive");
      setActionMessage(
        `${requestError.message}${
          requestError.requestId
            ? tr(
                ` · 요청 ID ${requestError.requestId}`,
                ` · Request ID ${requestError.requestId}`,
              )
            : ""
        }`,
      );
    } finally {
      arrivalInFlightRef.current = false;
      setActionBusy(false);
    }
  }, [currentExecutionStep, execution, registered, tr]);

  const back = useCallback(() => {
    if (step === "origin") go("incident", true);
    else if (step === "appointment") go("origin", true);
    else if (step === "options" || step === "empty" || step === "error") {
      go("appointment", true);
    } else if (step === "active") {
      go("options", true);
    }
  }, [step, go]);

  const canGoBack =
    step !== "incident" && step !== "searching";

  return (
    <div className={styles.shell} lang={language}>
      <div className={styles.top}>
        {step === "incident" ? (
          <Link
            className={styles.back}
            href="/"
            aria-label={tr("이어가 홈으로", "Go to IEOGA home")}
          >
            ←
          </Link>
        ) : (
          <button
            type="button"
            className={styles.back}
            onClick={back}
            disabled={!canGoBack}
            aria-label={tr("이전 단계로", "Go to the previous step")}
          >
            ←
          </button>
        )}
        <div
          className={styles.progress}
          aria-label={tr(
            `여행 복구 ${Math.min(stepIndex + 1, 5)}단계`,
            `Recovery step ${Math.min(stepIndex + 1, 5)} of 5`,
          )}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={STEP_ORDER.length}
          aria-valuenow={Math.min(stepIndex + 1, STEP_ORDER.length)}
        >
          {STEP_ORDER.map((entry, index) => (
            <span
              key={entry}
              className={[
                styles.tick,
                index < stepIndex ? styles.tickDone : "",
                index === stepIndex ? styles.tickNow : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          ))}
        </div>
        <div className={styles.language} aria-label="Language">
          <button
            type="button"
            className={language === "ko" ? styles.languageOn : ""}
            onClick={() => setLanguage("ko")}
            aria-pressed={language === "ko"}
          >
            KO
          </button>
          <button
            type="button"
            className={language === "en" ? styles.languageOn : ""}
            onClick={() => setLanguage("en")}
            aria-pressed={language === "en"}
          >
            EN
          </button>
        </div>
      </div>

      <div
        key={step}
        className={`${styles.screen} ${goingBack ? styles.screenBack : ""}`}
      >
        {step === "incident" && (
          <>
            <span className={styles.eyebrow}>
              {tr("1단계 · 약 10초", "Step 1 · about 10 seconds")}
            </span>
            <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
              {tr("지금 무슨 일이", "What changed")}
              <br />
              {tr("생겼나요?", "right now?")}
            </h1>
            <p className={styles.sub}>
              {tr(
                "하나만 눌러주세요. 일정을 미리 등록하지 않아도 됩니다.",
                "Choose one. You do not need to register an itinerary first.",
              )}
            </p>
            <div className={styles.body}>
              {INCIDENTS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  className={`${styles.choice} ${
                    incident === entry.value ? styles.choiceOn : ""
                  }`}
                  onClick={() => {
                    invalidateRecoveryResults();
                    setIncident(entry.value);
                    go("origin");
                  }}
                >
                  <span className={styles.choiceMark}>{entry.mark}</span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>
                      {language === "ko" ? entry.title : entry.titleEn}
                    </span>
                    <span className={styles.choiceSub}>
                      {language === "ko" ? entry.sub : entry.subEn}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "origin" && (
          <>
            <span className={styles.eyebrow}>{tr("2단계", "Step 2")}</span>
            <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
              {tr("지금 어디 계세요?", "Where are you now?")}
            </h1>
            <p className={styles.sub}>
              {tr(
                "현재 위치는 복구 계산에만 쓰며 저장하지 않습니다. 좌표는 소수점 다섯 자리로 줄여 전송합니다.",
                "Live location is used only for this recovery calculation and is not stored. Coordinates are reduced to five decimal places.",
              )}
            </p>
            <div className={styles.body}>
              <button
                type="button"
                className={styles.choice}
                onClick={() => {
                  invalidateRecoveryResults();
                  detectOrigin();
                }}
                disabled={originBusy}
              >
                <span className={styles.choiceMark}>📍</span>
                <span className={styles.choiceText}>
                  <span className={styles.choiceTitle}>
                    {originBusy
                      ? tr("확인하는 중…", "Locating…")
                      : tr("현재 위치로 시작", "Use my current location")}
                  </span>
                  <span className={styles.choiceSub}>
                    {originNote ||
                      tr(
                        "권한을 허용하면 행정구역까지 자동 입력돼요",
                        "Allow once to resolve the current district",
                      )}
                  </span>
                </span>
              </button>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="origin-place">
                  {tr(
                    "또는 지금 있는 곳을 검색",
                    "Or search for your current place",
                  )}
                </label>
                <input
                  id="origin-place"
                  className={styles.input}
                  type="search"
                  placeholder={tr(
                    "예: 부산역, 광안리해수욕장",
                    "e.g. Busan Station",
                  )}
                  value={originQuery}
                  onChange={(event) => {
                    invalidateRecoveryResults();
                    setOriginQuery(event.target.value);
                    setOrigin(null);
                    setOriginHits([]);
                    setOriginNote("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void searchOriginPlace();
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.ghost}
                  style={{ marginTop: 0 }}
                  onClick={() => void searchOriginPlace()}
                  disabled={originSearchBusy || !originQuery.trim()}
                >
                  {originSearchBusy
                    ? tr("찾는 중…", "Searching…")
                    : tr(
                        "관광정보·장소 데이터 검색",
                        "Search tourism and place data",
                      )}
                </button>
              </div>

              {originHits.map((hit) => (
                <button
                  key={`${hit.title}-${hit.latitude}-${hit.longitude}`}
                  type="button"
                  className={`${styles.choice} ${
                    origin?.latitude === hit.latitude &&
                    origin?.longitude === hit.longitude
                      ? styles.choiceOn
                      : ""
                  }`}
                  onClick={() => {
                    invalidateRecoveryResults();
                    setOrigin({
                      latitude: hit.latitude,
                      longitude: hit.longitude,
                      label: hit.title,
                      areaCode: hit.areaCode,
                      sigunguCode: hit.sigunguCode,
                    });
                    setOriginQuery(hit.title);
                    setOriginHits([]);
                    setOriginNote(
                      tr(
                        `${hit.title}에서 출발합니다. 출처: ${hit.sourceLabel}. 이 출발 좌표는 일정에 저장하지 않습니다.`,
                        `Starting from ${hit.title}. Source: ${sourceLabelText(hit.sourceLabel, "en")}. This origin coordinate is not stored in the itinerary.`,
                      ),
                    );
                  }}
                >
                  <span className={styles.choiceMark}>📌</span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>{hit.title}</span>
                    {hit.address && (
                      <span className={styles.choiceSub}>{hit.address}</span>
                    )}
                    <span className={styles.choiceSub}>
                      {tr("출처", "Source")} · {sourceLabelText(hit.sourceLabel, language)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "appointment" && (
          <>
            <span className={styles.eyebrow}>
              {tr("3단계 · 마지막", "Step 3 · final input")}
            </span>
            <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
              {tr("몇 시까지", "Where do you")}
              <br />
              {tr("어디로 가야 하나요?", "need to be, and when?")}
            </h1>
            <p className={styles.sub}>
              {tr(
                "이어가는 이 약속과 필수 조건을 지킬 수 있는 복구안만 보여줍니다.",
                "IEOGA only shows recovery options that protect this appointment and every required condition.",
              )}
            </p>
            {recoveryStale && (
              <p className={styles.staleNotice} role="status">
                {tr(
                  "조건이 바뀌었습니다. 이전 실패·후보·선택은 폐기했어요. 새 조건으로 다시 찾아주세요.",
                  "Conditions changed. The previous failure, options and selection were cleared. Search again with the new conditions.",
                )}
              </p>
            )}
            <div className={styles.body}>
              <div className={styles.appointmentFields}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="appt-date">
                    {tr("도착 날짜", "Arrival date")}
                  </label>
                  <input
                    id="appt-date"
                    className={styles.input}
                    type="date"
                    value={apptDate}
                    min={appointmentDateBounds?.minimum}
                    max={appointmentDateBounds?.maximum}
                    onChange={(event) => {
                      invalidateRecoveryResults();
                      setAppointment((previous) => ({
                        ...previous,
                        date: event.target.value,
                      }));
                    }}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="appt-time">
                    {tr("도착 시각", "Arrival time")}
                  </label>
                  <input
                    id="appt-time"
                    className={styles.input}
                    type="time"
                    value={apptTime}
                    onChange={(event) => {
                      invalidateRecoveryResults();
                      setAppointment((previous) => ({
                        ...previous,
                        time: event.target.value,
                      }));
                    }}
                  />
                </div>
              </div>
              <p
                className={`${styles.fieldNote} ${
                  appointmentWindowInvalid ? styles.fieldError : ""
                }`}
                role={appointmentWindowInvalid ? "alert" : undefined}
              >
                {appointmentWindowInvalid
                  ? availableMinutes == null
                    ? tr(
                        "유효한 도착 날짜와 시각을 입력해 주세요.",
                        "Enter a valid arrival date and time.",
                      )
                    : availableMinutes < MIN_APPOINTMENT_MINUTES
                    ? tr(
                        "현재부터 최소 15분 뒤의 약속을 선택해 주세요.",
                        "Choose an appointment at least 15 minutes from now.",
                      )
                    : tr(
                        "현재부터 24시간 이내의 약속을 선택해 주세요.",
                        "Choose an appointment within the next 24 hours.",
                      )
                  : tr(
                      "현재 시각 기준 15분 뒤부터 24시간 이내까지 선택할 수 있습니다.",
                      "Choose a time from 15 minutes to 24 hours from now.",
                    )}
              </p>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="appt-place">
                  {tr("약속 장소", "Appointment place")}
                </label>
                <input
                  id="appt-place"
                  className={styles.input}
                  type="search"
                  placeholder={tr(
                    "예: 부산역, 감천문화마을",
                    "e.g. Busan Station",
                  )}
                  value={apptQuery}
                  onChange={(event) => {
                    invalidateRecoveryResults();
                    setApptQuery(event.target.value);
                    setApptPlace(null);
                    setApptHits([]);
                    setApptNote("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void searchAppointmentPlace();
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => void searchAppointmentPlace()}
                  disabled={apptBusy || !apptQuery.trim()}
                  style={{ marginTop: 0 }}
                >
                  {apptBusy
                    ? tr("찾는 중…", "Searching…")
                    : tr(
                        "저장 가능한 관광정보 검색",
                        "Search storable tourism data",
                      )}
                </button>
              </div>

              {apptNote && <p className={styles.sub}>{apptNote}</p>}

              {apptHits.map((hit) => (
                <button
                  key={`${hit.title}-${hit.latitude}-${hit.longitude}`}
                  type="button"
                  className={`${styles.choice} ${
                    apptPlace?.title === hit.title &&
                    apptPlace?.latitude === hit.latitude
                      ? styles.choiceOn
                      : ""
                  }`}
                  onClick={() => {
                    invalidateRecoveryResults();
                    setApptPlace(hit);
                    setApptQuery(hit.title);
                    setApptHits([]);
                    setApptNote(
                      tr(
                        `${withParticle(hit.title, "을/를")} 약속 장소로 정했어요. 출처: ${hit.sourceLabel}.`,
                        `${hit.title} is set as the appointment place. Source: ${sourceLabelText(hit.sourceLabel, "en")}.`,
                      ),
                    );
                  }}
                >
                  <span className={styles.choiceMark}>📌</span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>{hit.title}</span>
                    {hit.address && (
                      <span className={styles.choiceSub}>{hit.address}</span>
                    )}
                    <span className={styles.choiceSub}>
                      {tr("출처", "Source")} ·{" "}
                      {sourceLabelText(hit.sourceLabel, language)}
                    </span>
                    {/* 검색어에 지점명이 있었고 그 지점 단서로 찾아낸 결과라면
                        왜 이 결과가 맞는지 알려 준다. */}
                    {hit.matchReason === "branch_area" && (
                      <span className={styles.choiceSub}>
                        {tr(
                          "입력한 지점 위치 주변에서 찾은 곳입니다.",
                          "Found near the branch location you typed.",
                        )}
                      </span>
                    )}
                    {/* 카카오 로컬 장소의 면책 문구를 뺐다. 여행자는 방금 자기가 고른 곳이
                        공사 데이터셋에 있는지 없는지 궁금하지 않다. 좌표만 쓴다는
                        사실은 우리 사정이고, 그 결과(관광 근거가 안 붙는 것)는
                        복구안 화면에서 이미 드러난다. */}
                  </span>
                </button>
              ))}

              <div className={styles.field} style={{ marginTop: 10 }}>
                <span className={styles.label}>
                  {tr("이동 조건", "Mobility condition")}
                </span>
                {AUDIENCES.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    className={`${styles.choice} ${
                      audience === entry.value ? styles.choiceOn : ""
                    }`}
                    style={{ minHeight: 56 }}
                    onClick={() => {
                      invalidateRecoveryResults();
                      setAudience(entry.value);
                    }}
                  >
                    <span className={styles.choiceText}>
                      <span className={styles.choiceTitle}>
                        {language === "ko" ? entry.label : entry.labelEn}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {step === "searching" && (
          <div className={styles.searching}>
            <div className={styles.spinner} />
            <div>
              <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1} style={{ fontSize: 22 }}>
                {tr("지킬 것을 먼저 잠그고", "Protecting what must stay")}
                <br />
                {tr("대안을 검증하고 있어요", "and verifying alternatives")}
              </h1>
              <p className={styles.sub}>
                {tr(
                  "한국관광공사 공식 데이터로 확인합니다",
                  "Checking official Korea Tourism Organization data",
                )}
              </p>
            </div>
            <div className={styles.apiLog}>
              {apiLog.map((line) => (
                <div key={line} className={styles.apiRow}>
                  <span className={styles.apiDot} />
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        {step === "options" && (
          <>
            <span className={styles.eyebrow}>
              {tr("검증 결과", "Verification result")}
            </span>
            <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
              {tr(
                `${apptTime} 약속까지 갈 수 있는`,
                `${verifiedOptionCount} place${
                  verifiedOptionCount === 1 ? "" : "s"
                } can still get you`,
              )}
              <br />
              {language === "ko"
                ? `${verifiedOptionCount}곳을 찾았어요`
                : `there by ${apptTime}`}
            </h1>
            <p className={styles.sub}>
              {tr(
                `시간·이동 조건을 못 지키는 ${rejectedCount}곳은 빼고 골랐어요.${
                  options.length - verifiedOptionCount > 0
                    ? ` 공식 근거가 부족한 ${options.length - verifiedOptionCount}곳은 적용할 수 없습니다.`
                    : ""
                }`,
                `${rejectedCount} place${
                  rejectedCount === 1 ? " was" : "s were"
                } excluded.${
                  options.length - verifiedOptionCount > 0
                    ? ` ${options.length - verifiedOptionCount} unverified option${
                        options.length - verifiedOptionCount === 1 ? " is" : "s are"
                      } shown for transparency but cannot be applied.`
                    : ""
                }`,
              )}
            </p>
            {options.length > 1 && (
              <>
                <div className={styles.sortRow} role="group" aria-label={tr("정렬 기준", "Sort by")}>
                  {(
                    [
                      ["recommended", "추천순", "Recommended"],
                      ["nearest_first", "가까운 순", "Nearest"],
                      ["quiet_first", "한적한 순", "Quietest"],
                      ["busy_first", "붐비는 순", "Busiest"],
                    ] as const
                  ).map(([value, ko, en]) => (
                    <button
                      key={value}
                      type="button"
                      className={optionSort === value ? styles.sortActive : styles.sortChip}
                      aria-pressed={optionSort === value}
                      onClick={() => setOptionSort(value)}
                    >
                      {tr(ko, en)}
                    </button>
                  ))}
                </div>
                {optionSort === "recommended" && (
                  <p className={styles.sortNote}>
                    {tr(
                      "추천순은 안전 조건을 통과한 뒤 최소 변경·편안함·지역 발견을 대표하는 안을 먼저 보여줍니다. 카드의 기초 적합도 점수순과는 다를 수 있습니다.",
                      "Recommended order shows representative options for minimal change, comfort and local discovery after safety checks. It may differ from the Base fit score order.",
                    )}
                  </p>
                )}
              </>
            )}
            <div className={styles.body}>
              {sortFlowOptions(options, optionSort).map((option, optionIndex) => {
                const safety = optionApplicationSafety(option, language);
                const isBlocked = !safety.canApply;
                const selected = selectedOptionId === option.id;
                return (
                <article
                  key={option.id}
                  className={`${styles.card} ${
                    selected ? styles.cardSelected : ""
                  } ${isBlocked ? styles.cardUnverified : ""}`}
                >
                  {option.imageUrl && (
                    <div className={styles.cardImage}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={option.imageUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => {
                          event.currentTarget.parentElement?.remove();
                        }}
                      />
                    </div>
                  )}
                  <div className={styles.cardTop}>
                    <div>
                      <span className={styles.rank}>
                        {tr(
                          `추천 ${optionIndex + 1}`,
                          `Suggestion ${optionIndex + 1}`,
                        )}
                      </span>
                      <h2 className={styles.cardTitle}>{option.title}</h2>
                      {option.address && (
                        <p className={styles.cardAddr}>{option.address}</p>
                      )}
                    </div>
                    {option.strategyLabel && (
                      <span className={styles.badge}>
                        {(language === "en" && option.strategyLabelEn) ||
                          option.strategyLabel}
                      </span>
                    )}
                  </div>

                  {isBlocked && (
                    <section
                      className={styles.gapAlert}
                      role="alert"
                      aria-label={tr(
                        "공식 근거 확인 필요",
                        "Official evidence required",
                      )}
                    >
                      <strong>
                        {tr(
                          safety.availabilityStatus === "confirmed_closed"
                            ? "지금은 문을 열지 않아 선택할 수 없습니다"
                            : "공식 확인 전에는 선택할 수 없습니다",
                          safety.availabilityStatus === "confirmed_closed"
                            ? "This place is closed and cannot be selected"
                            : "This option cannot be selected until verified",
                        )}
                      </strong>
                      <p>
                        {tr(
                          "헛걸음이나 다음 약속 지연을 막기 위해 운영·경로·필수 조건이 모두 확인된 후보만 일정에 적용합니다.",
                          "To prevent a wasted trip or a missed appointment, only options with verified opening, route and required conditions can be applied.",
                        )}
                      </p>
                      <ul>
                        {safety.reasons.map((reason, reasonIndex) => (
                          <li key={`${option.id}-safety-${reasonIndex}`}>
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <div className={styles.stats}>
                    <div className={styles.stat}>
                      <div className={styles.statVal}>
                        {option.estimatedTravelMinutes != null
                          ? tr(
                              `${option.estimatedTravelMinutes}분`,
                              `${option.estimatedTravelMinutes} min`,
                            )
                          : "—"}
                      </div>
                      <div className={styles.statKey}>
                        {tr("이동", "Travel")}
                      </div>
                    </div>
                    <div className={styles.stat}>
                      <div className={styles.statVal}>
                        {option.distanceMeters != null
                          ? `${(option.distanceMeters / 1000).toFixed(1)}km`
                          : "—"}
                      </div>
                      <div className={styles.statKey}>
                        {tr("거리", "Distance")}
                      </div>
                    </div>
                    {/* `✓`/`!` 하나로는 무엇이 검증됐는지 알 수 없었고, 확인이
                        필요한 항목은 이미 카드 위 경고와 아래 불릿이 말한다.
                        그 자리에 여행자가 실제로 쓰는 값을 넣는다. */}
                    <div className={styles.stat}>
                      <div className={styles.statVal}>
                        {crowdBadgeText(option.crowd, language) || "—"}
                      </div>
                      <div className={styles.statKey}>
                        {tr("붐빔", "Crowd")}
                      </div>
                    </div>
                  </div>

                  {/* 값이 없는 항목은 상자를 만들지 않는다.
                      "요청하지 않았습니다"·"찾지 못했습니다"만 적힌 상자를 네
                      개 늘어놓으면, 화면의 절반이 **없다는 말**로 채워져
                      정작 확인한 근거가 묻힌다. 확인한 것만 보여 주고,
                      확인하지 못해서 **결정에 영향을 주는 것**은 이미 카드
                      상단의 경고와 아래 `why` 문장이 따로 말한다. */}
                  {(() => {
                    const facts = [
                      { key: "availability", ko: "운영 정보", en: "Opening", value: option.availability },
                      /* 실내 조건 상자를 뺐다. 이 상자는 여행자가 실내를
                         **요청했을 때만** 뜨는데, 그때는 모든 후보가 실내라
                         카드마다 같은 값이 된다. 같은 값이 모든 카드에 있으면
                         카드를 고르는 데 쓰이지 않고, 내용도 "콘텐츠 유형으로
                         판단했습니다"라는 우리 판정 과정이었다. */
                      { key: "accessibility", ko: "접근성", en: "Accessibility", value: option.accessibility },

                    ]
                      .map((fact) => ({
                        ...fact,
                        text: evidenceText(fact.value, language),
                      }))
                      .filter((fact) => {
                        if (!fact.text) return false;
                        /* 붐빔은 "공식 정보 없음"도 남긴다 — 데이터가 없다는
                           사실 자체가 다른 후보와 비교할 때 쓰인다. 나머지는
                           우리 요청 조건에 대한 설명이라 상자를 쓸 값어치가
                           없다. */
                        return !/(요청하지 않았|찾지 못했|확인하지 못했|필수 조건으로 쓰지 않았|not requested|could not|no .*available)/i.test(
                          fact.text,
                        );
                      });
                    if (!facts.length) return null;
                    return (
                      <div className={styles.guideFacts}>
                        {facts.map((fact) => (
                          /* 운영시간 원문은 한 줄로 안 끝난다 — 하절기·동절기가
                             따로 있고 휴무 요일이 붙는다. 절반 폭에 넣으면
                             열 줄짜리 좁은 기둥이 되어 읽히지 않으므로 가로
                             전체를 준다. */
                          <dl
                            key={fact.key}
                            className={
                              fact.key === "availability" ? styles.factWide : undefined
                            }
                          >
                            <dt>{tr(fact.ko, fact.en)}</dt>
                            <dd>{fact.text}</dd>
                          </dl>
                        ))}
                      </div>
                    );
                  })()}

                  {!!option.purposePreservation?.statement && (
                    <p className={styles.cardAddr} style={{ marginTop: 14 }}>
                      {(language === "en" &&
                        option.purposePreservation.statementEn) ||
                        option.purposePreservation.statement}
                    </p>
                  )}

                  {!!option.why?.length && (
                    <ul className={styles.why}>
                      {((language === "en" && option.whyEn) || option.why)
                        .slice(0, 4)
                        .map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}

                  {/* API 이름 칩을 뺐다. `관광공사 KorService2`·`보조 TMAP
                      보행자 경로안내`는 여행자가 알 필요 없는 우리 쪽 사정이고,
                      카드 한 장을 세로로 길게 만들면서 정작 읽어야 할 시간·거리·
                      운영 정보를 아래로 밀어냈다.

                      출처를 감추는 것은 아니다. 어떤 데이터로 판정했는지는
                      `데이터 출처` 화면과 결과의 `sourceLedger`에 그대로 남아
                      있고, 심사에서 확인할 수 있다. 카드는 결정을 돕는 자리이지
                      계보를 밝히는 자리가 아니다. */}

                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={styles.selectButton}
                      disabled={isBlocked}
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedOptionId(option.id);
                        setActionPriority("polite");
                        setActionMessage("");
                        setShareMessage("");
                      }}
                    >
                      {isBlocked
                        ? safety.availabilityStatus === "confirmed_closed"
                          ? tr("휴무·폐점 시간이라 선택 불가", "Closed — cannot select")
                          : tr("공식 확인 전 적용 불가", "Cannot apply until verified")
                        : selected
                          ? tr("선택한 복구안", "Selected option")
                          : tr("이 복구안 선택", "Select this option")}
                    </button>
                    <a
                      href={`https://map.kakao.com/link/map/${encodeURIComponent(option.title)},${option.latitude},${option.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {tr("지도에서 미리 보기 ↗", "Preview on map ↗")}
                    </a>
                  </div>
                </article>
                );
              })}
            </div>
            {(actionMessage || shareMessage) && (
              <div
                className={styles.actionStatus}
                role={actionPriority === "assertive" ? "alert" : "status"}
                aria-live={actionPriority}
              >
                {actionMessage && <p>{actionMessage}</p>}
                {shareMessage && <p>{shareMessage}</p>}
              </div>
            )}
          </>
        )}

        {step === "active" && execution && (
          <>
            {executionContractMissed ? (
              <section
                className={styles.state}
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
                data-testid="flow-contract-missed"
              >
                <div className={`${styles.stateMark} ${styles.stateBad}`}>!</div>
                <div>
                  <span className={styles.eyebrow}>
                    {tr("약속 준수 실패", "Appointment missed")}
                  </span>
                  <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
                    {tr(
                      "도착했지만 약속 시각을 지키지 못했습니다.",
                      "You arrived, but did not meet the promised time.",
                    )}
                  </h1>
                  <p className={styles.sub}>
                    {tr(
                      "도착 기록은 보존하지만 정시 도착 성공으로 표시하거나 집계하지 않습니다. 남은 여행은 지금 상황에서 다시 복구해 주세요.",
                      "The arrival remains recorded, but IEOGA does not display or count it as an on-time success. Recover the remaining trip from your current situation.",
                    )}
                  </p>
                </div>
                {nextFixedExecutionStep?.scheduledAt && contractArrivalAt && (
                  <dl className={styles.missedFacts}>
                    <div>
                      <dt>{tr("약속 시각", "Promised time")}</dt>
                      <dd>
                        {formatKstTime(nextFixedExecutionStep.scheduledAt, language)}
                      </dd>
                    </div>
                    <div>
                      <dt>{tr("도착 확인", "Arrival recorded")}</dt>
                      <dd>{formatKstTime(contractArrivalAt, language)}</dd>
                    </div>
                  </dl>
                )}
                <div className={styles.completionActions}>
                  <a className={styles.ctaLink} href="/flow">
                    {tr("지금 상황에서 다시 복구", "Recover again from here")}
                  </a>
                  <a className={styles.ctaLink} href="tel:1330">
                    {tr(
                      "관광통역안내 1330 연결",
                      "Call the 1330 Travel Helpline",
                    )}
                  </a>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    data-testid="flow-create-historical-proof"
                    onClick={() => void createOrShareHistoricalProof()}
                    disabled={actionBusy}
                  >
                    {executionHistoricalProofShareLink
                      ? tr(
                          "실패 실행 이력 증명 다시 공유",
                          "Share the missed execution proof again",
                        )
                      : tr(
                          "실패 실행 이력 증명 만들기",
                          "Create missed execution proof",
                        )}
                  </button>
                  <p className={styles.proofUnavailable}>
                    {tr(
                      "현재 출발 가능 증명이 아니라 약속 실패를 포함한 과거 실행 이력입니다. 현재 이동 결정에 사용하면 안 됩니다.",
                      "This is historical execution evidence including the missed appointment, not proof that it is currently safe to depart. Do not use it for a current travel decision.",
                    )}
                  </p>
                </div>
              </section>
            ) : executionContractMet ? (
              <div className={styles.state}>
                <div className={`${styles.stateMark} ${styles.stateGood}`}>
                  ✓
                </div>
                <div>
                  <span className={styles.eyebrow}>
                    {tr("복구 계약 완료", "Recovery contract met")}
                  </span>
                  <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
                    {tr(
                      "다음 약속을 지키고\n원래 일정으로 돌아왔어요",
                      "Appointment protected.\nYour original trip resumes.",
                    )
                      .split("\n")
                      .map((line, index) => (
                        <span key={line}>
                          {index > 0 && <br />}
                          {line}
                        </span>
                      ))}
                  </h1>
                  {/* 설명 문장 대신 **바뀐 경로**를 보인다. 여행자가 이
                      화면에서 알고 싶은 것은 "우리가 무엇을 저장했는가"가
                      아니라 "그래서 내 오늘 동선이 어떻게 되는가"다. */}
                  <ol className={styles.completedRoute}>
                    {(execution.steps ?? []).map((step, index) => (
                      <li key={step.id ?? `${step.title}-${index}`}>
                        <span>{index + 1}</span>
                        <div>
                          <strong>{step.title}</strong>
                          {(step.role === "next_fixed"
                            ? step.scheduledAt
                            : step.estimatedArrivalAt ?? step.scheduledAt) && (
                            <em>
                              {formatKstTime(
                                step.role === "next_fixed"
                                  ? step.scheduledAt
                                  : step.estimatedArrivalAt ?? step.scheduledAt,
                                language,
                              )}
                            </em>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className={styles.completionActions}>
                  <Link className={styles.ctaLink} href="/">
                    {tr(
                      "원래 일정 이어서 보기",
                      "Resume the original itinerary",
                    )}
                  </Link>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    data-testid="flow-create-historical-proof"
                    onClick={() => void createOrShareHistoricalProof()}
                    disabled={actionBusy}
                  >
                    {executionHistoricalProofShareLink
                      ? tr(
                          "과거 실행 이력 증명 다시 공유",
                          "Share historical execution proof again",
                        )
                      : tr(
                          "과거 실행 이력 증명 만들기",
                          "Create historical execution proof",
                        )}
                  </button>
                  <p
                    className={styles.proofUnavailable}
                    data-testid="flow-historical-proof-not-actionable"
                  >
                    {tr(
                      "이 링크는 종료된 여행의 실행 상태와 시각을 보여 주는 이력입니다. 현재 영업·경로·예약 가능 여부나 지금 출발해도 된다는 뜻이 아니며, 현재 이동 결정에 사용하면 안 됩니다.",
                      "This link records the ended journey's execution status and timestamps. It does not show current opening, route or booking availability, is not proof that it is safe to depart now, and must not be used for a current travel decision.",
                    )}
                  </p>
                  {executionActionableProofShareLink && (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() =>
                        void shareSavedProofLink(
                          executionActionableProofShareLink,
                          options.find(
                            (option) =>
                              option.id === execution.sourceOptionId,
                          )?.title ?? execution.steps[0]?.title ?? "IEOGA",
                        )
                      }
                      disabled={actionBusy}
                    >
                      {tr(
                        "출발 전 저장한 판정 증명도 공유",
                        "Also share the saved pre-departure proof",
                      )}
                    </button>
                  )}
                </div>
                {(actionMessage || shareMessage) && (
                  <div
                    className={styles.actionStatus}
                    role={actionPriority === "assertive" ? "alert" : "status"}
                    aria-live={actionPriority}
                  >
                    {actionMessage && <p>{actionMessage}</p>}
                    {shareMessage && <p>{shareMessage}</p>}
                  </div>
                )}
                {/* 성공 화면에서 요청 ID를 뺐다. 잘 끝난 여행에서 여행자가
                    이 값으로 할 일이 없다. 실패 화면에는 그대로 남는다 —
                    거기서는 문의할 때 쓰는 유일한 단서다. */}
              </div>
            ) : execution.status === "completed" ? (
              <section
                className={styles.state}
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
                data-testid="flow-completed-without-contract"
              >
                <div className={`${styles.stateMark} ${styles.stateWarn}`}>!</div>
                <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
                  {tr(
                    "여행 단계는 끝났지만 약속 준수를 확인하지 못했습니다.",
                    "The trip steps ended, but the appointment outcome was not verified.",
                  )}
                </h1>
                <p className={styles.sub}>
                  {tr(
                    "약속 준수 근거가 없어 성공으로 표시하지 않습니다. 필요하면 1330에 도움을 요청하거나 최신 상황으로 다시 복구해 주세요.",
                    "Without appointment-outcome evidence, IEOGA does not show a success. Call 1330 for help or recover again from the latest situation.",
                  )}
                </p>
                <div className={styles.completionActions}>
                  <a className={styles.ctaLink} href="/flow">
                    {tr("최신 상황으로 다시 복구", "Recover from the latest situation")}
                  </a>
                  <a className={styles.ctaLink} href="tel:1330">
                    {tr("관광통역안내 1330 연결", "Call the 1330 Travel Helpline")}
                  </a>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    data-testid="flow-create-historical-proof"
                    onClick={() => void createOrShareHistoricalProof()}
                    disabled={actionBusy}
                  >
                    {executionHistoricalProofShareLink
                      ? tr(
                          "과거 실행 이력 증명 다시 공유",
                          "Share historical execution proof again",
                        )
                      : tr(
                          "과거 실행 이력 증명 만들기",
                          "Create historical execution proof",
                        )}
                  </button>
                </div>
              </section>
            ) : currentExecutionStep ? (
              <>
                <span className={styles.eyebrow}>
                  {tr("복구 여행 진행 중", "Recovery in progress")}
                </span>
                <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
                  {executionRole(currentExecutionStep, language)}
                  <br />
                  {currentExecutionStep.title}
                </h1>
                <p className={styles.sub}>
                  {currentExecutionStep.locationLabel ||
                    tr("목적지 위치를 확인해 주세요.", "Check the destination location.")}
                </p>

                <div className={styles.body}>
                  <section className={styles.activeCard}>
                    <div className={styles.activeFacts}>
                      <dl>
                        <dt>{tr("도착 예정", "Expected arrival")}</dt>
                        <dd>
                          {formatKstTime(
                            currentExecutionStep.estimatedArrivalAt ??
                              currentExecutionStep.scheduledAt,
                            language,
                          )}
                        </dd>
                      </dl>
                      <dl>
                        <dt>{tr("지킬 다음 약속", "Protected appointment")}</dt>
                        <dd>
                          {nextFixedExecutionStep?.title ??
                            apptPlace?.title ??
                            tr("다음 약속", "Next appointment")}{" "}
                          ·{" "}
                          {formatKstTime(
                            nextFixedExecutionStep?.scheduledAt ??
                              kstIso(apptDate, apptTime),
                            language,
                          )}
                        </dd>
                      </dl>
                    </div>
                    <a
                      className={styles.routeLink}
                      href={navigationUrl(currentExecutionStep)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {tr(
                        "카카오맵으로 다음 장소 길찾기",
                        "Navigate to the next place with Kakao Map",
                      )}
                      <span aria-hidden="true">→</span>
                    </a>
                    <p className={styles.routeNote}>
                      {tr(
                        "지도 앱에서 경로를 확인한 뒤 실제 도착했을 때만 아래 버튼을 눌러주세요.",
                        "Check the route in the map app, then confirm only after you actually arrive.",
                      )}
                    </p>
                  </section>

                  <ol className={styles.executionList}>
                    {execution.steps.map((entry) => (
                      <li
                        key={entry.id}
                        className={
                          entry.status === "current"
                            ? styles.executionCurrent
                            : entry.status === "arrived"
                              ? styles.executionArrived
                              : ""
                        }
                      >
                        <span aria-hidden="true">
                          {entry.status === "arrived"
                            ? "✓"
                            : entry.status === "current"
                              ? "→"
                              : entry.sequence + 1}
                        </span>
                        <div>
                          <small>{executionRole(entry, language)}</small>
                          <strong>{entry.title}</strong>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
                {actionMessage && (
                  <div
                    className={styles.actionStatus}
                    role={actionPriority === "assertive" ? "alert" : "status"}
                    aria-live={actionPriority}
                  >
                    <p>{actionMessage}</p>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.state}>
                <div className={`${styles.stateMark} ${styles.stateBad}`}>!</div>
                <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1}>
                  {tr(
                    "진행할 다음 단계를 확인하지 못했습니다.",
                    "The next executable step could not be found.",
                  )}
                </h1>
                <Link className={styles.ctaLink} href="/">
                  {tr("저장된 일정에서 다시 열기", "Open the saved itinerary")}
                </Link>
              </div>
            )}
          </>
        )}

        {step === "empty" && (
          <div className={styles.state}>
            <div className={`${styles.stateMark} ${styles.stateWarn}`}>🔍</div>
            <div>
              <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1} style={{ fontSize: 22 }}>
                {tr("조건을 지키는 대안이", "No option meets")}
                <br />
                {tr("지금은 없습니다", "every condition right now")}
              </h1>
              {/* "없다"만 남기면 고장과 구분되지 않는다. 어떤 조건이
                  후보를 걸러냈는지와, 그래서 무엇을 바꾸면 되는지를
                  같이 알려준다. */}
              <p className={styles.sub}>{emptyReason.headline}</p>
            </div>
            {!!rejectionSummary.length && (
              <div className={styles.card} style={{ width: "100%" }}>
                <h2 className={styles.cardTitle} style={{ fontSize: 15 }}>
                  {tr(
                    `검토한 ${rejectedCount}곳이 제외된 이유`,
                    `Why ${rejectedCount} reviewed place${
                      rejectedCount === 1 ? " was" : "s were"
                    } excluded`,
                  )}
                </h2>
                <ul className={styles.why}>
                  {rejectionSummary.slice(0, 4).map((entry) => (
                    <li key={entry.reasonCode}>
                      {REJECTION_LABELS[entry.reasonCode][language]}{" "}
                      ·{" "}
                      {tr(
                        `${entry.count}곳`,
                        `${entry.count} place${entry.count === 1 ? "" : "s"}`,
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className={styles.noteCard}>
              {tr(
                `이 결과는 그냥 사라지지 않습니다. ‘${
                  INCIDENTS.find((entry) => entry.value === incident)?.title
                }’ 상황에서 안전한 대안이 없었다는 사실은 동의·공개 기준을 충족할 때만 익명 집계됩니다.`,
                `This result is not silently discarded. When consent and publication thresholds are met, the lack of a safe alternative for “${
                  INCIDENTS.find((entry) => entry.value === incident)?.titleEn
                }” is aggregated without precise location.`,
              )}
            </div>
          </div>
        )}

        {step === "error" && (
          <div className={styles.state}>
            <div className={`${styles.stateMark} ${styles.stateBad}`}>!</div>
            <div>
              <h1 className={styles.title} ref={stepHeadingRef} tabIndex={-1} style={{ fontSize: 22 }}>
                {tr(
                  "복구안을 만들지 못했어요",
                  "Recovery could not be created",
                )}
              </h1>
              <p className={styles.sub}>{errorText}</p>
              <p className={styles.errorHelp}>
                {tr(
                  "연결 상태를 확인한 뒤 같은 조건으로 재시도하세요. 계속 실패하면 아래 요청 ID와 함께 문의해 주세요.",
                  "Check your connection and retry the same request. If it keeps failing, report the request ID below.",
                )}
              </p>
              {errorRequestId && (
                <p className={styles.proofId}>
                  {tr("요청 ID", "Request ID")}{" "}
                  <code>{errorRequestId}</code>
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className={styles.foot}>
        {step === "appointment" && (
          <button
            type="button"
            className={styles.cta}
            disabled={
              !appointmentSelectionCurrent ||
              availableMinutes == null ||
              availableMinutes < MIN_APPOINTMENT_MINUTES ||
              availableMinutes > MAX_APPOINTMENT_MINUTES
            }
            onClick={() => void runRecovery()}
          >
            {!appointmentSelectionCurrent
              ? tr(
                  "약속 장소를 선택해 주세요",
                  "Select the appointment place",
                )
              : availableMinutes != null &&
                  availableMinutes < MIN_APPOINTMENT_MINUTES
                ? tr(
                    "약속까지 15분 이상 남아야 해요",
                    "At least 15 minutes must remain",
                  )
                : availableMinutes != null &&
                    availableMinutes > MAX_APPOINTMENT_MINUTES
                  ? tr(
                      "24시간 이내의 약속을 선택해 주세요",
                      "Choose an appointment within 24 hours",
                    )
                : tr(
                    "예약을 지키는 복구안 찾기",
                    "Find a recovery that protects the appointment",
                  )}
          </button>
        )}

        {step === "origin" && (
          <button
            type="button"
            className={styles.cta}
            onClick={() => go("appointment")}
            disabled={!originSelectionCurrent}
          >
            {originSelectionCurrent
              ? tr("다음", "Continue")
              : tr(
                  "현재 위치를 확인하거나 장소를 검색해 주세요",
                  "Locate yourself or select a searched place",
                )}
          </button>
        )}

        {step === "empty" && (
          <button
            type="button"
            className={styles.cta}
            onClick={() => go("appointment", true)}
          >
            {tr("조건 바꿔서 다시 찾기", "Change conditions and search again")}
          </button>
        )}

        {step === "error" && (
          <div className={styles.footStack}>
            {incident === "rain" && !allowOutdoor && (
              /* 실측 최다 탈락 사유가 실내 미확인이었는데 그 조건을 풀 수단이
                 화면에 없었다. 되돌릴 수 있는 조건은 되돌릴 수 있어야 한다. */
              <button
                type="button"
                className={styles.cta}
                onClick={() => {
                  invalidateRecoveryResults();
                  setAllowOutdoor(true);
                  void runRecovery({ includeOutdoor: true });
                }}
              >
                {tr(
                  "실외 후보까지 포함해 다시 찾기",
                  "Search again including outdoor places",
                )}
              </button>
            )}
            <button
              type="button"
              className={
                incident === "rain" && !allowOutdoor
                  ? styles.secondaryButton
                  : styles.cta
              }
              onClick={() => void runRecovery()}
            >
              {tr("같은 조건으로 다시 시도", "Retry the same request")}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => go("appointment", true)}
            >
              {tr("조건 바꾸기", "Change conditions")}
            </button>
          </div>
        )}

        {step === "options" && (
          <div className={styles.footStack}>
            {selectedNeedsAcknowledgement && selectedOption && (
              /* 확인하지 못한 조건을 읽고 동의하면 적용을 연다. 동의해도 카드가
                 "검증됨"으로 바뀌지는 않으며, 무엇이 확인되지 않았는지는 그대로
                 남는다. 공유는 여전히 완전 검증된 결과에만 허용한다. */
              <label className={styles.ackRow}>
                <input
                  type="checkbox"
                  checked={acknowledgedOptionId === selectedOption.id}
                  onChange={(event) =>
                    setAcknowledgedOptionId(
                      event.target.checked ? selectedOption.id : "",
                    )
                  }
                />
                <span>
                  <strong>
                    {tr(
                      "확인되지 않은 조건을 알고 이어갑니다",
                      "I understand what was not verified",
                    )}
                  </strong>
                  <small>
                    {(selectedOption.evidenceGaps ?? [])
                      .map(
                        (gap) =>
                          (language === "en" ? gap.noteEn : "") ||
                          gap.note ||
                          REJECTION_LABELS[
                            gap.code as RejectionReasonCode
                          ]?.[language] ||
                          "",
                      )
                      .filter(Boolean)
                      .join(" · ") ||
                      tr(
                        "원래 하려던 활동과 종류가 다릅니다.",
                        "This is a different kind of stop than you planned.",
                      )}
                  </small>
                  <small>
                    {tr(
                      "출발 전에 운영기관에 직접 확인해 주세요. 이어가는 확인되지 않은 조건을 충족으로 바꾸지 않습니다.",
                      "Please confirm with the venue before you set out. IEOGA does not mark an unverified condition as met.",
                    )}
                  </small>
                </span>
              </label>
            )}
            <button
              type="button"
              className={styles.cta}
              data-testid="flow-apply-option"
              onClick={() => void applySelectedOption()}
              disabled={
                !selectedOption ||
                (selectedNeedsAcknowledgement &&
                  acknowledgedOptionId !== selectedOption.id) ||
                actionBusy ||
                !recoveryPersisted
              }
            >
              {actionBusy
                ? tr("적용 중…", "Applying…")
                : selectedOption
                  ? selectedNeedsAcknowledgement
                    ? tr(
                        `확인하고 ${withParticle(selectedOption.title, "으로/로")} 이어가기`,
                        `Acknowledge and continue with ${selectedOption.title}`,
                      )
                    : tr(
                        `${withParticle(selectedOption.title, "으로/로")} 이어가기`,
                        `Continue with ${selectedOption.title}`,
                      )
                  : tr(
                      "복구안을 선택해 주세요",
                      "Select a recovery option",
                    )}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              data-testid="flow-create-proof"
              onClick={() => void shareSelectedOption()}
              disabled={
                !selectedOption ||
                selectedOption.confirmationRequired ||
                (selectedOption.evidenceGaps?.length ?? 0) > 0 ||
                actionBusy ||
                !recoveryPersisted
              }
            >
              {selectedProofShareLink
                ? tr(
                    "저장한 출발 전 판정 증명 다시 공유",
                    "Share the saved pre-departure proof again",
                  )
                : tr(
                    "출발 전 판정 증명 링크 만들기",
                    "Create a pre-departure decision proof",
                  )}
            </button>
            <p className={styles.proofTimingNote}>
              {tr(
                "판정 증명은 생성 시점의 공식 근거를 고정합니다. 완료 뒤 과거 근거를 새 링크로 다시 만들 수 없으므로 필요하면 출발 전에 생성해 주세요.",
                "A decision proof freezes the official evidence available when it is created. Because old evidence cannot be recreated as a new link after completion, create it before departure if you need one.",
              )}
            </p>
          </div>
        )}

        {step === "active" &&
          execution &&
          currentExecutionStep &&
          execution.status === "active" &&
          !executionContractMissed &&
          registered &&
          execution.baseItineraryId === registered.id &&
          executionPreservesLockedAppointment(
            execution,
            registered.lockedAppointment,
          ) && (
            <button
              type="button"
              className={styles.cta}
              data-testid="flow-confirm-arrival"
              onClick={() => void confirmCurrentArrival()}
              disabled={actionBusy}
            >
              {actionBusy
                ? tr("도착 기록 중…", "Saving arrival…")
                : tr(
                    "실제로 이 장소에 도착했어요",
                    "I have actually arrived here",
                  )}
            </button>
          )}

        {/* 여행이 끝나면 버튼이 하나도 남지 않아 막다른 길이었다. 도착 확인이
            사라진 자리에 다음에 할 수 있는 일을 둔다.
            새로 찾기는 `/flow`로 다시 들어가 상태를 통째로 비운다 — 끝난
            여행의 입력이 다음 요청에 섞이지 않아야 한다. */}
        {step === "active" &&
          execution &&
          executionContractMet && (
            <div className={styles.actions}>
              <a className={styles.cta} href="/flow">
                {tr("처음부터 다시 찾기", "Start over")}
              </a>
              <Link className={styles.ctaLink} href="/">
                {tr("이어가 홈으로", "Back to IEOGA home")}
              </Link>
            </div>
          )}
      </div>
    </div>
  );
}
