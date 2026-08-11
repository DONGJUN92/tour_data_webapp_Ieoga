import type { JourneyDrift } from "./drift";

export type JourneyExecutionStatus =
  | "active"
  | "contract_met"
  | "contract_missed"
  | "completed"
  | "abandoned"
  | "superseded";

export type JourneyExecutionStepRole =
  | "replacement"
  | "preserved"
  | "next_fixed"
  | "remaining_original";

export type JourneyExecutionStepStatus =
  | "pending"
  | "current"
  | "arrived"
  | "skipped";

export type JourneyExecutionStep = {
  id: string;
  sequence: number;
  originalNodeId?: string;
  role: JourneyExecutionStepRole;
  contentId?: string;
  title: string;
  type: string;
  scheduledAt?: string;
  estimatedArrivalAt?: string;
  durationMinutes?: number;
  locationLabel?: string;
  latitude: number;
  longitude: number;
  locked: boolean;
  reservation: boolean;
  verificationStatus: "continuity_verified" | "resumed_original";
  status: JourneyExecutionStepStatus;
  arrivedAt?: string;
};

export type JourneyExecution = {
  id: string;
  baseItineraryId: string;
  sourceRunId: string;
  sourceOptionId: string;
  status: JourneyExecutionStatus;
  currentStepSequence: number;
  nextFixedStepSequence: number;
  activatedAt: string;
  outcomePromptAt: string;
  contractMetAt?: string;
  contractMissedAt?: string;
  completedAt?: string;
  updatedAt: string;
  expiresAt: string;
  steps: JourneyExecutionStep[];
  /* 동선이 꼬였는지에 대한 판정. 예전에는 도착이 늦어도 아무 일이 일어나지
     않아서, 사용자가 스스로 "이러다 다음 약속을 놓치겠다"고 깨닫고 복구를 다시
     요청해야 했다. 위기 순간에 그 판단을 하기 어려워서 이 앱을 쓰는 것이다. */
  drift: JourneyDrift;
};
