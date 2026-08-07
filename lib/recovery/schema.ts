import { z } from "zod";
import {
  districtBelongsToRegion,
  isOfficialRegionCode,
  isPlausibleOfficialDistrictCode,
} from "@/lib/kto/registry";

const optionalRegionCode = z
  .string()
  .trim()
  .refine(isOfficialRegionCode, "공식 시도 코드를 확인해 주세요.")
  .optional()
  .transform((value) => value || undefined);

const optionalDistrictCode = z
  .string()
  .trim()
  .refine(
    isPlausibleOfficialDistrictCode,
    "공식 시군구 코드 형식을 확인해 주세요.",
  )
  .optional()
  .transform((value) => value || undefined);

const coordinateFields = {
  latitude: z.number().min(32).max(39.8),
  longitude: z.number().min(124).max(132),
  label: z.string().trim().min(1).max(80),
  areaCode: optionalRegionCode,
  sigunguCode: optionalDistrictCode,
};

function validateCoordinateAdministrativeScope(
  location: { areaCode?: string; sigunguCode?: string },
  context: z.RefinementCtx,
) {
  if (location.sigunguCode && !location.areaCode) {
    context.addIssue({
      code: "custom",
      path: ["areaCode"],
      message: "시군구 코드와 함께 공식 시도 코드가 필요합니다.",
    });
  } else if (
    location.areaCode &&
    location.sigunguCode &&
    !districtBelongsToRegion(
      location.areaCode,
      location.sigunguCode,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["sigunguCode"],
      message: "시군구 코드가 선택한 시도에 속하지 않습니다.",
    });
  }
}

const coordinateSchema = z
  .object(coordinateFields)
  .superRefine(validateCoordinateAdministrativeScope);

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
    .enum(["general", "assisted", "stroller", "wheelchair", "senior"])
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

/* 빈 시간 추천 입력. 여행자는 분 단위로 계획하지 않으므로 시각은 30분 격자로만
   받고, 체류 시간도 30분 배수로 제한한다. 그래야 "10분 뒤까지 12분 머문다"처럼
   실제로는 아무도 세우지 않는 계획이 검증 대상으로 들어오지 않는다. */
const OPEN_WINDOW_STEP_MINUTES = 30;

const openWindowNextPlaceSchema = z
  .object({
    ...coordinateFields,
    arriveBy: z.string().datetime({ offset: true }),
  })
  .superRefine(validateCoordinateAdministrativeScope);

export const openWindowSchema = z
  .object({
    /* 이 시각까지가 자유 시간이다. 다음 장소가 있으면 그 도착 시각과 같거나
       그보다 뒤일 수 없다. */
    availableUntil: z.string().datetime({ offset: true }),
    plannedStayMinutes: z
      .number()
      .int()
      .min(OPEN_WINDOW_STEP_MINUTES)
      .max(300)
      .refine(
        (value) => value % OPEN_WINDOW_STEP_MINUTES === 0,
        "예상 체류 시간은 30분 단위로 선택해 주세요.",
      ),
    nextPlace: openWindowNextPlaceSchema.optional(),
  })
  .superRefine((window, context) => {
    if (!window.nextPlace) return;
    const arriveBy = Date.parse(window.nextPlace.arriveBy);
    const until = Date.parse(window.availableUntil);
    if (Number.isFinite(arriveBy) && Number.isFinite(until) && arriveBy < until) {
      context.addIssue({
        code: "custom",
        path: ["availableUntil"],
        message:
          "자유 시간의 끝은 다음 장소 도착 시각보다 늦을 수 없습니다.",
      });
    }
  });

export const recoveryRequestSchema = z
  .object({
    origin: z
      .object({
        ...coordinateFields,
        label: z.string().trim().min(1).max(80).default("현재 위치"),
      })
      .superRefine(validateCoordinateAdministrativeScope),
    incident: z.enum(["rain", "delay", "crowd", "less_walk"]),
    availableMinutes: z.number().int().min(15).max(240),
    maxDistanceMeters: z.number().int().min(300).max(20_000),
    audience: z
      .enum(["general", "assisted", "stroller", "wheelchair", "senior"])
      .default("general"),
    /* 3상태다. 미지정이면 우천 상황에서 실내를 요구하고, 명시적 `false`는
       그 기본값을 이긴다. `.default(false)`였을 때는 두 값이 구분되지 않아
       여행자가 실내 조건을 풀 수단이 아예 없었다 — 우천을 고르면 실외 후보가
       전부 사라지고 그 상태를 되돌릴 방법이 화면에 없었다. */
    indoorOnly: z.boolean().optional(),
    /* 여행자가 고른 이동수단. 도보·자차는 TMAP, 대중교통·자전거는 카카오맵
       길찾기로 계산한다. 네 수단 모두 2026-08-04 실호출로 응답을 확인했다.
       확인되지 않은 수단은 목록에 두지 않는다 — 고를 수는 있는데 검증은 안 되는
       선택지는 여행자에게 잘못된 도착 시각을 주는 것과 같다. */
    travelMode: z
      .enum(["walk", "car", "transit", "bicycle"])
      .default("walk"),
    radiusMeters: z.number().int().min(500).max(20_000).default(5_000),
    safetyBufferMinutes: z.number().int().min(5).max(90).default(15),
    minimumStayMinutes: z.number().int().min(10).max(180).default(30),
    /* 두 진입 경로 중 정확히 하나. 등록된 일정을 고치는 복구와, 지금 빈 시간을
       채우는 추천은 보존해야 하는 대상이 다르므로 같은 요청에 섞이면 어느 쪽
       기준으로 검증했는지 증명서가 설명할 수 없다. */
    /* 심사용 제거실험. 지정한 공사 서비스를 이 요청에서만 호출하지 않는다.
       기획 15.3의 20점 방어조건 4는 "API 제거 시 품질 저하가 정량적으로
       나타난다"를 요구하는데, 보고서 문장이 아니라 심사위원이 화면에서 직접
       끄고 차이를 보게 하는 것이 목적이다. 끈 서비스는 응답의 ablation에
       그대로 적히므로, 무엇을 빼고 얻은 수치인지 숨길 수 없다.

       국문 관광정보(KorService2)는 후보 자체를 만드는 유일한 원천이라 끄면
       비교가 아니라 빈 결과가 되므로 목록에 두지 않는다. */
    disabledSources: z
      .array(
        z.enum([
          "TarRlteTarService1",
          "TatsCnctrRateService",
          "KorWithService2",
        ]),
      )
      .max(3)
      .optional(),
    itinerary: recoveryItinerarySchema.optional(),
    openWindow: openWindowSchema.optional(),
    analyticsConsent: z.boolean().optional().default(false),
  })
  .superRefine((input, context) => {
    if (!input.itinerary && !input.openWindow) {
      context.addIssue({
        code: "custom",
        path: ["itinerary"],
        message:
          "원래 일정을 등록하거나, 지금 비어 있는 시간 조건을 알려 주세요.",
      });
      return;
    }
    if (input.itinerary && input.openWindow) {
      context.addIssue({
        code: "custom",
        path: ["openWindow"],
        message:
          "일정 복구와 빈 시간 추천은 한 번에 함께 요청할 수 없습니다.",
      });
    }
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

export function recoveryAdministrativeScopes(
  input: RecoveryRequest,
): Array<{ regionCode: string; districtCode: string }> {
  const locations = [
    input.origin,
    ...(input.itinerary?.nodes ?? []).flatMap((node) =>
      node.location ? [node.location] : [],
    ),
    ...(input.openWindow?.nextPlace ? [input.openWindow.nextPlace] : []),
  ];
  return [
    ...new Map(
      locations.flatMap((location) => {
        const regionCode = location.areaCode
          ? location.areaCode.length === 5
            ? location.areaCode.slice(0, 2)
            : location.areaCode
          : undefined;
        const districtCode = location.sigunguCode ??
          (location.areaCode?.length === 5
            ? location.areaCode
            : undefined);
        return regionCode && districtCode
          ? [[`${regionCode}:${districtCode}`, { regionCode, districtCode }] as const]
          : [];
      }),
    ).values(),
  ];
}

export type ItineraryRegistration = z.infer<
  typeof itineraryRegistrationSchema
>;
export type RecoveryOutcomeInput = z.infer<typeof recoveryOutcomeSchema>;
export type RecoveryApplyInput = z.infer<typeof recoveryApplySchema>;
export type JourneyExecutionActionInput = z.infer<
  typeof journeyExecutionActionSchema
>;
