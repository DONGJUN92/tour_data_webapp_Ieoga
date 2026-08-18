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
    if (node.endAt && !node.startAt) {
      context.addIssue({
        code: "custom",
        path: ["startAt"],
        message: "일정 종료 시각을 입력하려면 시작 시각도 필요합니다.",
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

type ItineraryCore = z.infer<typeof itineraryCoreSchema>;

type ItineraryContractIssue = {
  path: Array<string | number>;
  message: string;
};

const KOREA_UTC_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function koreaDayIndex(value: Date): number {
  return Math.floor((value.getTime() + KOREA_UTC_OFFSET_MS) / DAY_MS);
}

/* One temporal contract is used by registration and recovery. This keeps a
   plan that was accepted at save time from turning into
   ITINERARY_CONTRACT_CHANGED only when recovery begins.

   Flexible nodes may omit a time, but every supplied time must increase in
   itinerary order and timed nodes may not overlap. At least one hard stop
   (locked or reserved) with a destination must still be in the future. That
   rejects accidentally submitted past-day plans without preventing an
   already-running itinerary from containing completed earlier stops. */
export function itineraryTemporalContractIssues(
  itinerary: ItineraryCore,
  now = new Date(),
): ItineraryContractIssue[] {
  const issues: ItineraryContractIssue[] = [];
  const ordered = itinerary.nodes
    .map((node, index) => ({
      node,
      index,
      sequence: node.sequence ?? index,
    }))
    .sort((a, b) => a.sequence - b.sequence);

  let previousTimed: { startAt: number; endAt?: number } | undefined;
  for (const entry of ordered) {
    if (!entry.node.startAt) continue;
    const startAt = Date.parse(entry.node.startAt);
    const endAt = entry.node.endAt
      ? Date.parse(entry.node.endAt)
      : undefined;
    if (previousTimed && startAt <= previousTimed.startAt) {
      issues.push({
        path: ["nodes", entry.index, "startAt"],
        message:
          "일정 시작 시각은 이동 순서에 따라 반드시 증가해야 합니다.",
      });
    }
    if (
      previousTimed?.endAt !== undefined &&
      startAt < previousTimed.endAt
    ) {
      issues.push({
        path: ["nodes", entry.index, "startAt"],
        message:
          "앞 일정이 끝나기 전에 다음 일정을 시작할 수 없습니다.",
      });
    }
    previousTimed = { startAt, endAt };
  }

  const hardStops = itinerary.nodes.filter(
    (node) => node.locked || node.reservation,
  );
  if (!hardStops.length) {
    issues.push({
      path: ["nodes"],
      message:
        "최소 한 개의 잠금 또는 예약 일정과 목적지를 등록해 주세요.",
    });
    return issues;
  }

  const actionableHardStop = hardStops.some(
    (node) =>
      Boolean(node.location) &&
      Boolean(node.startAt) &&
      Date.parse(node.startAt!) > now.getTime(),
  );
  if (!actionableHardStop) {
    issues.push({
      path: ["nodes"],
      message:
        "현재 시각 이후의 잠금 또는 예약 일정과 목적지가 최소 한 개 필요합니다.",
    });
  }

  /* Earlier stops from *today* are valid for an itinerary already in
     progress. A node from a previous Korea calendar day is not: mixing an
     old day into a new plan otherwise passes merely because one later locked
     stop exists. */
  for (const [index, node] of itinerary.nodes.entries()) {
    const scheduledAt = node.startAt ?? node.endAt;
    if (
      scheduledAt &&
      koreaDayIndex(new Date(scheduledAt)) < koreaDayIndex(now)
    ) {
      issues.push({
        path: ["nodes", index, node.startAt ? "startAt" : "endAt"],
        message:
          "이미 지난 날짜의 일정은 저장하거나 복구할 수 없습니다.",
      });
    }
  }
  return issues;
}

function validateItineraryNodes(
  itinerary: ItineraryCore,
  context: z.RefinementCtx,
  now = new Date(),
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
  for (const issue of itineraryTemporalContractIssues(itinerary, now)) {
    context.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message,
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
    const validationNow = new Date();
    validateItineraryNodes(itinerary, context, validationNow);
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
        if (Date.parse(nextFixed.startAt) <= validationNow.getTime()) {
          context.addIssue({
            code: "custom",
            path: ["nextFixedNodeId"],
            message: "다음 고정 일정은 현재 시각보다 뒤여야 합니다.",
          });
        } else if (
          Date.parse(nextFixed.startAt) <= Date.parse(baseline)
        ) {
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
          new Date(
            Math.max(
              validationNow.getTime(),
              Date.parse(
                itinerary.occurredAt ??
                  disrupted.startAt ??
                  new Date(0).toISOString(),
              ),
            ),
          ).toISOString(),
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
      const effectiveBaseline = Math.max(
        validationNow.getTime(),
        Date.parse(baseline),
      );
      const automaticNext = orderedNodes
        .slice(disruptedIndex + 1)
        .find(
          (node) =>
            (node.locked || node.reservation) &&
            Boolean(node.startAt) &&
            Boolean(node.location) &&
            Date.parse(node.startAt!) > effectiveBaseline,
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
          new Date(effectiveBaseline).toISOString(),
          context,
        );
      }
    }
  });

/* 빈 시간 추천 입력. 여행자는 분 단위로 계획하지 않으므로 시각은 30분 격자로만
   받고, 체류 시간도 30분 배수로 제한한다. 그래야 "10분 뒤까지 12분 머문다"처럼
   실제로는 아무도 세우지 않는 계획이 검증 대상으로 들어오지 않는다. */
const OPEN_WINDOW_STEP_MINUTES = 30;

/* `arriveBy`는 **선택**이다. 이것이 없으면 다음 장소는 하드 마감이 아니라
   방향 힌트다.

   예전에는 필수였고, 화면은 그 자리를 자유 시간의 끝으로 채워 보냈다. 그러면
   여행자가 말한 적 없는 마감("남은 시간이 끝날 때까지 그 장소에 도착해야 한다")이
   생기고, 그 장소가 조금만 멀면 **모든 후보가 산술적으로 탈락한다.** 실측에서
   대전역에서 한빛탑을 고르면 추천이 0곳이었고, 같은 조건에서 다음 장소만 비우면
   6곳이 나왔다. 없는 조건을 만들어 놓고 "갈 곳이 없다"고 답한 것이다.

   약속 시각을 아는 여행자는 그것을 준다. 모르는 여행자에게 억지로 만들어
   붙이지 않는다 — 대신 검증하지 않았다는 사실을 결과에 적는다. */
const openWindowNextPlaceSchema = z
  .object({
    ...coordinateFields,
    arriveBy: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine(validateCoordinateAdministrativeScope);

export const openWindowSchema = z
  .object({
    departureAt: z.string().datetime({ offset: true }).optional(),
    /* 이 시각까지가 자유 시간이다. 다음 장소의 약속 시각이 이보다 앞서면 그쪽이
       실제 마감이 되므로, 두 값 중 이른 쪽을 쓴다(엔진에서 계산). */
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
    const departureAt = window.departureAt
      ? Date.parse(window.departureAt)
      : undefined;
    const until = Date.parse(window.availableUntil);
    if (
      departureAt !== undefined &&
      Number.isFinite(departureAt) &&
      Number.isFinite(until) &&
      departureAt >= until
    ) {
      context.addIssue({
        code: "custom",
        path: ["departureAt"],
        message: "출발 시각은 자유 시간 종료 시각보다 앞서야 합니다.",
      });
    }
    if (!window.nextPlace?.arriveBy) return;
    /* 약속 시각이 자유 시간의 끝보다 **앞서는** 것은 정상이다 — 그쪽이 실제
       마감이고, 엔진이 이른 쪽을 쓴다. 예전에는 이 경우를 오류로 막았는데,
       그 제약 때문에 화면이 약속 시각을 물어볼 수조차 없었다.

       막아야 하는 것은 출발 시각보다 앞선 약속뿐이다 — 그건 이미 지난 약속이다. */
    const arriveBy = Date.parse(window.nextPlace.arriveBy);
    if (
      departureAt !== undefined &&
      Number.isFinite(departureAt) &&
      Number.isFinite(arriveBy) &&
      arriveBy <= departureAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["nextPlace", "arriveBy"],
        message: "다음 장소 도착 시각은 출발 시각보다 뒤여야 합니다.",
      });
    }
  });

export const recoveryRequestSchema = z
  .object({
    /* 모든 추천 판정의 공통 시계. `current`는 서버 수신 시각을 사용하고,
       `assumed`는 사용자가 그 시각에 현재 위치에 있다고 가정한다. 과거·미래
       상한과 일정 충돌은 서버 시계가 필요한 공통 resolver에서 검증한다. */
    referenceTime: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("current") }).strict(),
        z
          .object({
            mode: z.literal("assumed"),
            at: z.string().datetime({ offset: true }),
          })
          .strict(),
      ])
      .optional(),
    origin: z
      .object({
        ...coordinateFields,
        label: z.string().trim().min(1).max(80).default("현재 위치"),
      })
      .superRefine(validateCoordinateAdministrativeScope),
    incident: z.enum(["rain", "delay", "crowd", "less_walk"]),
    /* 호환 입력이다. 일정·빈 시간 모드의 실제 판정은 등록된 시각 계약을 쓰며,
       하루 일정도 표현할 수 있도록 과거 4시간 상한을 제거한다. */
    availableMinutes: z.number().int().min(15).max(1_440),
    /* @deprecated 이전 클라이언트 요청과 저장 데이터만을 위한 호환 필드다.
       엔진은 이 값을 후보 조회·판정·점수에 사용하지 않는다. */
    maxDistanceMeters: z
      .number()
      .int()
      .min(300)
      .max(20_000)
      .optional()
      .default(20_000),
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
    /* @deprecated 과거 반경 UI의 호환 필드. 후보 탐색은 공사 API 최대 반경
       20km를 내부적으로 사용하고 실제 이동·체류·복귀 가능 시간으로 검증한다. */
    radiusMeters: z
      .number()
      .int()
      .min(500)
      .max(20_000)
      .optional()
      .default(20_000),
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
    /* 여행자가 미리 고른 관광 분류. 비어 있으면 전체를 본다.

       왜 서버가 받아야 하는가: 화면에도 분류 필터가 있지만 그것은 **응답을 받은
       뒤** 걸러낸다. 즉 원하지 않는 분류의 후보에도 운영시간·경로 조회를 이미
       다 쓴 뒤에 화면에서 지운다. 요청당 외부 조회가 50건으로 막혀 있고 공사
       인증키에도 일일 한도가 있는 상황에서, 그 낭비는 곧 "원하는 분류에서 볼 수
       있는 곳의 수"를 깎는다.

       여기서 받으면 후보 탐색 직후 — 운영시간·경로를 부르기 **전에** — 걸러내므로
       같은 예산이 고른 분류에만 쓰인다. 분류를 좁힐수록 그 분류에서 더 많은
       후보를 검증할 수 있다. */
    tourismCategories: z
      .array(
        z.enum([
          "PARK",
          "HERITAGE",
          "FOOD",
          "CULTURE",
          "NATURE",
          "EXPERIENCE",
          "EVENT",
          "LEISURE",
          "SHOPPING",
          "ACCOMMODATION",
          "COURSE",
          "OTHER",
        ]),
      )
      .min(1)
      .max(12)
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
    /* 운영시간을 대조하지 못한 안을 적용할 때, 여행자가 그 사실을 읽고
       동의했는가. 화면의 체크박스만으로는 계약이 되지 않는다 — 서버가 묻지
       않으면 그 체크박스는 장식이고, 요청을 직접 만들면 우회된다. */
    acknowledgeUnverifiedHours: z.boolean().optional(),
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
