export type JourneyExecutionStatus =
  | "active"
  | "contract_met"
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
  completedAt?: string;
  updatedAt: string;
  expiresAt: string;
  steps: JourneyExecutionStep[];
};
