import { z } from "zod";

const optionalRegionCode = z
  .string()
  .trim()
  .regex(/^(?:\d{2}|\d{5})$/)
  .optional()
  .transform((value) => value || undefined);

const optionalDistrictCode = z
  .string()
  .trim()
  .regex(/^\d{5}$/)
  .optional()
  .transform((value) => value || undefined);

const coordinateSchema = z.object({
  latitude: z.number().min(32).max(39.8),
  longitude: z.number().min(124).max(132),
  label: z.string().trim().min(1).max(80),
  areaCode: optionalRegionCode,
  sigunguCode: optionalDistrictCode,
});

export const itineraryNodeSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/),
    sequence: z.number().int().min(0).max(99).optional(),
    type: z
      .enum(["visit", "reservation", "meal", "transit", "stay", "other"])
      .default("visit"),
    title: z.string().trim().min(1).max(100),
    startAt: z.string().datetime({ offset: true }).optional(),
    endAt: z.string().datetime({ offset: true }).optional(),
    durationMinutes: z.number().int().min(10).max(720).optional(),
    locked: z.boolean().default(false),
    reservation: z.boolean().default(false),
    location: coordinateSchema.optional(),
  })
  .superRefine((node, context) => {
    if (
      node.startAt &&
      node.endAt &&
      Date.parse(node.endAt) <= Date.parse(node.startAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "일정 종료 시각은 시작 시각보다 뒤여야 합니다.",
      });
    }
    if ((node.locked || node.reservation) && !node.startAt) {
      context.addIssue({
        code: "custom",
        path: ["startAt"],
        message: "고정 일정과 예약 일정에는 시작 시각이 필요합니다.",
      });
    }
    if ((node.locked || node.reservation) && !node.location) {
      context.addIssue({
        code: "custom",
        path: ["location"],
        message: "고정 일정과 예약 일정에는 위치가 필요합니다.",
      });
    }
  });

const itineraryCoreSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(100).default("내 여행 일정"),
  timezone: z.literal("Asia/Seoul").default("Asia/Seoul"),
  audience: z
    .enum(["general", "stroller", "wheelchair", "senior"])
    .default("general"),
  nodes: z.array(itineraryNodeSchema).min(2).max(30),
});

function validateItineraryNodes(
  itinerary: z.infer<typeof itineraryCoreSchema>,
  context: z.RefinementCtx,
) {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const [index, node] of itinerary.nodes.entries()) {
    if (ids.has(node.id)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "id"],
        message: "일정 노드 ID는 서로 달라야 합니다.",
      });
    }
    ids.add(node.id);
    const sequence = node.sequence ?? index;
    if (sequences.has(sequence)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "sequence"],
        message: "일정 순서는 서로 달라야 합니다.",
      });
    }
    sequences.add(sequence);
  }
  if (!itinerary.nodes.some((node) => node.locked || node.reservation)) {
    context.addIssue({
      code: "custom",
      path: ["nodes"],
      message: "최소 한 개의 다음 고정 또는 예약 일정을 등록해 주세요.",
    });
  }
}

function validateContinuityPath(
  orderedNodes: z.infer<typeof itineraryCoreSchema>["nodes"],
  disruptedIndex: number,
  nextFixedIndex: number,
  baseline: string,
  context: z.RefinementCtx,
) {
  let previousTime = Date.parse(baseline);
  for (
    let index = disruptedIndex + 1;
    index <= nextFixedIndex;
    index += 1
  ) {
    const node = orderedNodes[index];
    if (!node.startAt) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "startAt"],
        message:
          "복구 경로에서 보존할 모든 일정에는 시작 시각이 필요합니다.",
      });
    }
    if (!node.location) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "location"],
        message:
          "복구 경로에서 보존할 모든 일정에는 위치가 필요합니다.",
      });
    }
    if (node.startAt) {
      const currentTime = Date.parse(node.startAt);
      if (currentTime <= previousTime) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "startAt"],
          message:
            "중단 이후 보존할 일정의 시작 시각은 이동 순서대로 증가해야 합니다.",
        });
      }
      previousTime = currentTime;
    }
  }
}

export const itineraryRegistrationSchema = itineraryCoreSchema.superRefine(
  validateItineraryNodes,
);

export const recoveryItinerarySchema = itineraryCoreSchema
  .extend({
    occurredAt: z.string().datetime({ offset: true }).optional(),
    disruptedNodeId: z.string().trim().min(1).max(64),
    nextFixedNodeId: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((itinerary, context) => {
    validateItineraryNodes(itinerary, context);
    const orderedNodes = [...itinerary.nodes].sort(
      (a, b) =>
        (a.sequence ?? itinerary.nodes.indexOf(a)) -
        (b.sequence ?? itinerary.nodes.indexOf(b)),
    );
    const disrupted = orderedNodes.find(
      (node) => node.id === itinerary.disruptedNodeId,
    );
    if (!disrupted) {
      context.addIssue({
        code: "custom",
        path: ["disruptedNodeId"],
        message: "중단된 일정이 일정표에 존재해야 합니다.",
      });
    } else if (disrupted.locked || disrupted.reservation) {
      context.addIssue({
        code: "custom",
        path: ["disruptedNodeId"],
        message:
          "잠금 또는 예약 일정은 복구 대상으로 교체할 수 없습니다. 먼저 해당 일정의 잠금을 해제해 주세요.",
      });
    }
    if (itinerary.nextFixedNodeId) {
      const nextFixed = orderedNodes.find(
        (node) => node.id === itinerary.nextFixedNodeId,
      );
      const disruptedIndex = disrupted
        ? orderedNodes.findIndex((node) => node.id === disrupted.id)
        : -1;
      const nextFixedIndex = nextFixed
        ? orderedNodes.findIndex((node) => node.id === nextFixed.id)
        : -1;
      if (!nextFixed) {
        context.addIssue({
          code: "custom",
          path: ["nextFixedNodeId"],
          message: "다음 고정 일정이 일정표에 존재해야 합니다.",
        });
      } else if (!nextFixed.locked && !nextFixed.reservation) {
        context.addIssue({
          code: "custom",
          path: ["nextFixedNodeId"],
          message: "다음 일정은 고정 또는 예약 상태여야 합니다.",
        });
      } else if (
        disruptedIndex >= 0 &&
        nextFixedIndex <= disruptedIndex
      ) {
        context.addIssue({
          code: "custom",
          path: ["nextFixedNodeId"],
          message:
            "다음 고정 일정은 중단된 일정 뒤에 배치되어야 합니다.",
        });
      } else if (nextFixed.startAt) {
        const baseline =
          itinerary.occurredAt ??
          disrupted?.startAt ??
          new Date(0).toISOString();
        if (Date.parse(nextFixed.startAt) <= Date.parse(baseline)) {
          context.addIssue({
            code: "custom",
            path: ["nextFixedNodeId"],
            message: "다음 고정 일정은 중단 발생 시각보다 뒤여야 합니다.",
          });
        }
      }
      if (
        disrupted &&
        nextFixed &&
        disruptedIndex >= 0 &&
        nextFixedIndex > disruptedIndex
      ) {
        validateContinuityPath(
          orderedNodes,
          disruptedIndex,
          nextFixedIndex,
          itinerary.occurredAt ??
            disrupted.startAt ??
            new Date(0).toISOString(),
          context,
        );
      }
      if (itinerary.nextFixedNodeId === itinerary.disruptedNodeId) {
        context.addIssue({
          code: "custom",
          path: ["nextFixedNodeId"],
          message: "중단 일정과 다음 고정 일정은 달라야 합니다.",
        });
      }
    } else if (disrupted) {
      const disruptedIndex = orderedNodes.findIndex(
        (node) => node.id === disrupted.id,
      );
      const baseline =
        itinerary.occurredAt ??
        disrupted.startAt ??
        new Date(0).toISOString();
      const automaticNext = orderedNodes
        .slice(disruptedIndex + 1)
        .find(
          (node) =>
            (node.locked || node.reservation) &&
            Boolean(node.startAt) &&
            Boolean(node.location) &&
            Date.parse(node.startAt!) > Date.parse(baseline),
        );
      if (!automaticNext) {
        context.addIssue({
          code: "custom",
          path: ["nextFixedNodeId"],
          message:
            "중단 일정 뒤에 도착 시각과 위치가 있는 다음 고정 일정을 등록해 주세요.",
        });
      } else {
        validateContinuityPath(
          orderedNodes,
          disruptedIndex,
          orderedNodes.indexOf(automaticNext),
          baseline,
          context,
        );
      }
    }
  });

export const recoveryRequestSchema = z.object({
  origin: coordinateSchema.extend({
    label: z.string().trim().min(1).max(80).default("현재 위치"),
  }),
  incident: z.enum(["rain", "delay", "crowd", "less_walk"]),
  availableMinutes: z.number().int().min(15).max(240),
  maxDistanceMeters: z.number().int().min(300).max(20_000),
  audience: z
    .enum(["general", "stroller", "wheelchair", "senior"])
    .default("general"),
  indoorOnly: z.boolean().default(false),
  radiusMeters: z.number().int().min(500).max(20_000).default(5_000),
  safetyBufferMinutes: z.number().int().min(5).max(90).default(15),
  minimumStayMinutes: z.number().int().min(10).max(180).default(30),
  itinerary: recoveryItinerarySchema,
  analyticsConsent: z.boolean().optional().default(false),
});

export const recoveryOutcomeSchema = z
  .object({
    optionId: z.string().trim().min(10).max(220),
    event: z.enum([
      "selected",
      "applied",
      "arrived",
      "continued",
      "abandoned",
    ]),
    reasonCode: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const recoveryApplySchema = z
  .object({
    optionId: z.string().trim().min(10).max(220),
  })
  .strict();

export const journeyExecutionActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("arrive_step"),
      stepId: z.string().trim().min(8).max(220),
    })
    .strict(),
  z
    .object({
      action: z.literal("abandon"),
      reasonCode: z.string().trim().min(1).max(80).default("USER_ABANDONED"),
    })
    .strict(),
]);

export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export type ItineraryRegistration = z.infer<
  typeof itineraryRegistrationSchema
>;
export type RecoveryOutcomeInput = z.infer<typeof recoveryOutcomeSchema>;
export type RecoveryApplyInput = z.infer<typeof recoveryApplySchema>;
export type JourneyExecutionActionInput = z.infer<
  typeof journeyExecutionActionSchema
>;
