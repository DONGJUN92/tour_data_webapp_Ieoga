import { getDb } from "@/db";
import { regionalGapCounters } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { RecoveryResult } from "@/lib/recovery/types";
import type { RecoveryRequest } from "@/lib/recovery/schema";

/**
 * 지역별 "여행이 끊긴 이유"의 익명 집계.
 *
 * 기획안 6.5가 약속한 `감지된 공백 → 자동 생성 미션 → 개선 확인` 루프의 재료다.
 * 지금까지 화면에 나온 미션은 "정책 근거 데이터 완성도 점검"처럼 **우리 파이프라인**
 * 점검 항목뿐이었다. 지자체 담당자가 그것으로 할 수 있는 일이 없다 — 자기 지역에
 * 대한 정보가 아니기 때문이다.
 *
 * 여기서 쌓는 것은 이어가만 만들 수 있는 자료다. 방문 통계는 "몇 명이 왔는가"를
 * 말하지만, 이 표는 **"온 사람이 여행을 계속할 수 있었는가, 못했다면 무엇이
 * 막았는가"** 를 말한다. 기획안이 "관광 콘텐츠의 `존재`가 아니라 `대체 가능성`을
 * 측정하는 신규 지표"라고 적은 것이 이것이다.
 *
 * 담는 것은 건수뿐이다. 장소명·좌표·세션은 담지 않는다 — 엔진의 `rejectionSummary`가
 * 이미 그렇게 설계돼 있고, 그 성질 덕분에 이 집계를 지자체와 공유할 수 있다.
 */

function available(): boolean {
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

/* 낮과 밤을 가른다. "야간 복구 불가"는 기획안이 따로 든 공백이다. */
function dayPartOf(referenceAt: Date): "day" | "night" {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(referenceAt),
  );
  if (!Number.isFinite(hour)) return "day";
  return hour >= 19 || hour < 8 ? "night" : "day";
}

/**
 * 한 번의 복구 결과에서 사유별 건수를 누적한다.
 *
 * 응답 경로에서 부르지만 외부 호출을 쓰지 않는다(D1은 내부 예산). 실패해도
 * 여행자의 응답에는 영향이 없어야 하므로 조용히 넘어간다 — 이 집계는 정책 화면의
 * 재료이고, 그것 때문에 추천이 막히면 우선순위가 거꾸로다.
 */
export async function recordRegionalGaps(params: {
  input: RecoveryRequest;
  result: RecoveryResult;
}): Promise<number> {
  const { input, result } = params;
  const regionCode = result.scope.regionCode;
  if (!regionCode || !available()) return 0;
  if (!result.rejectionSummary.length) return 0;

  const districtCode = result.scope.districtCode ?? "_all";
  const dayPart = dayPartOf(new Date(result.referenceTime.at));
  const incident = input.incident;
  const audience = input.audience ?? "general";
  const emptyResult = result.options.length === 0 ? 1 : 0;
  const nowIso = new Date().toISOString();

  const rows = result.rejectionSummary.map((entry) => ({
    /* 결정적 키다. 같은 조합은 한 행에 누적된다. */
    id: `${regionCode}:${districtCode}:${entry.reasonCode}:${dayPart}:${incident}:${audience}`,
    regionCode,
    districtCode,
    reasonCode: entry.reasonCode,
    dayPart,
    incident,
    audience,
    rejectionCount: entry.count,
    observationCount: 1,
    emptyResultCount: emptyResult,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
  }));

  try {
    await getDb()
      .insert(regionalGapCounters)
      .values(rows)
      .onConflictDoUpdate({
        target: regionalGapCounters.id,
        set: {
          rejectionCount: sql`${regionalGapCounters.rejectionCount} + excluded.rejection_count`,
          observationCount: sql`${regionalGapCounters.observationCount} + excluded.observation_count`,
          emptyResultCount: sql`${regionalGapCounters.emptyResultCount} + excluded.empty_result_count`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
    return rows.length;
  } catch {
    return 0;
  }
}

export type RegionalGap = {
  reasonCode: string;
  dayPart: "day" | "night";
  rejectionCount: number;
  observationCount: number;
  emptyResultCount: number;
  lastSeenAt: string;
  /* 지자체가 실제로 할 수 있는 일. 기획안 6.5의 `자동 생성 미션` 열이다. */
  action: string;
  /* 그 일을 했을 때 무엇이 달라지는지. `개선 확인` 열이다. */
  verification: string;
};

/* 사유 코드 → 지자체가 할 수 있는 일. 기획안 6.5 표를 그대로 옮긴다.
   추측한 조치를 적지 않는다 — 각 항목은 그 사유가 뜻하는 공식 데이터의 공백에
   직접 대응한다. */
const GAP_ACTIONS: Record<string, { action: string; verification: string }> = {
  /* 기간이 있는 콘텐츠 고유의 공백이다. 휴무와 섞어 세면 지자체는 운영시간을
     고치려 들지만, 실제로 필요한 일은 끝난 행사 정리와 새 행사 등록이다. */
  EVENT_NOT_RUNNING: {
    action:
      "이 시각에 열리는 행사·공연이 공식 정보에 없습니다. 진행 중인 행사의 기간을 최신으로 등록하고, 종료된 행사가 계속 검색되지 않도록 정리해 주세요.",
    verification:
      "기간이 갱신되면 같은 날짜 요청에서 이 사유의 탈락 수가 줄고 행사 후보가 늘어납니다.",
  },
  OFFICIALLY_CLOSED: {
    action:
      "이 시간대에 문을 여는 관광 콘텐츠가 부족합니다. 야간·연중무휴 운영 콘텐츠를 발굴하거나, 실제로는 운영 중인데 공식 운영시간이 등록되지 않은 곳을 확인해 주세요.",
    verification:
      "운영시간이 등록되면 같은 시각 요청에서 이 사유의 탈락 수가 줄어듭니다.",
  },
  OPERATING_STATUS_UNVERIFIABLE: {
    action:
      "공식 운영시간 표기를 대조할 수 없는 곳이 많습니다. `detailIntro2`의 운영시간·휴무일 항목을 채워 주세요.",
    verification:
      "표기가 채워지면 확인 없이 바로 추천할 수 있는 곳이 늘어납니다.",
  },
  ACCESSIBILITY_UNVERIFIED: {
    action:
      "무장애여행정보에 등록되지 않은 곳이 많습니다. 출입 동선·내부 이동 정보를 등록해 주세요.",
    verification:
      "등록되면 이동 도움이 필요한 여행자에게 제시할 수 있는 곳이 늘어납니다.",
  },
  INDOOR_UNVERIFIED: {
    action:
      "우천 시 실내 대안이 부족합니다. 실내 이용이 가능한 콘텐츠의 공식 분류를 확인해 주세요.",
    verification: "우천 상황 요청에서 유효 대안 수가 늘어납니다.",
  },
  ROUTE_UNAVAILABLE: {
    action:
      "경로 제공자가 길을 찾지 못한 곳이 있습니다. 좌표 오류이거나 보행 접근이 실제로 어려운 지점일 수 있습니다.",
    verification: "좌표가 정정되면 같은 곳이 후보로 통과합니다.",
  },
  OPEN_WINDOW_OVERFLOW: {
    action:
      "짧은 빈 시간에 다녀올 만한 콘텐츠가 부족합니다. 대표 명소 주변의 가까운 대체 콘텐츠를 발굴해 주세요.",
    verification: "가까운 콘텐츠가 늘면 짧은 창에서도 대안이 생깁니다.",
  },
  NEXT_FIXED_APPOINTMENT_AT_RISK: {
    action:
      "예약 사이에 끼워 넣을 수 있는 콘텐츠가 부족합니다. 이동 시간이 짧은 대체 거점을 확인해 주세요.",
    verification: "가까운 거점이 늘면 예약을 지키면서도 대안이 생깁니다.",
  },
  CONCENTRATION_HIGH: {
    action:
      "대안 후보까지 혼잡이 예측됩니다. 저집중 연관 관광지로 수요를 분산할 연결망이 필요합니다.",
    verification: "분산 후보가 늘면 혼잡 회피 추천이 가능해집니다.",
  },
};

/**
 * 지역의 공백을 심각한 순으로 읽는다.
 *
 * D1 한 번의 질의로 읽는다. 이 화면은 정책 담당자가 보는 화면이므로 실시간성이
 * 필요하지 않고, 외부 호출도 쓰지 않는다.
 */
export async function readRegionalGaps(params: {
  regionCode: string;
  districtCode?: string;
  limit?: number;
}): Promise<{ gaps: RegionalGap[]; totalObservations: number }> {
  if (!available()) return { gaps: [], totalObservations: 0 };
  try {
    const conditions = [eq(regionalGapCounters.regionCode, params.regionCode)];
    if (params.districtCode && params.districtCode !== "_all") {
      conditions.push(
        eq(regionalGapCounters.districtCode, params.districtCode),
      );
    }
    const rows = await getDb()
      .select()
      .from(regionalGapCounters)
      .where(and(...conditions))
      .orderBy(desc(regionalGapCounters.rejectionCount))
      .limit(params.limit ?? 40);

    const totalObservations = rows.reduce(
      (sum, row) => sum + row.observationCount,
      0,
    );
    const gaps = rows
      .filter((row) => GAP_ACTIONS[row.reasonCode])
      .map((row) => ({
        reasonCode: row.reasonCode,
        dayPart: (row.dayPart === "night" ? "night" : "day") as
          | "day"
          | "night",
        rejectionCount: row.rejectionCount,
        observationCount: row.observationCount,
        emptyResultCount: row.emptyResultCount,
        lastSeenAt: row.lastSeenAt,
        action: GAP_ACTIONS[row.reasonCode].action,
        verification: GAP_ACTIONS[row.reasonCode].verification,
      }));
    return { gaps, totalObservations };
  } catch {
    return { gaps: [], totalObservations: 0 };
  }
}
