import type { JourneyExecution, JourneyExecutionStep } from "./execution";

/* 동선이 꼬였는지 판정한다.
 *
 * 지정과제 1번의 실시간 변수 중 하나가 "동선 꼬임"인데, 이 앱에는 **탐지하는
 * 코드가 아예 없었다.** 진행 중 실행이 받는 동작은 `arrive_step`과 `abandon`
 * 둘뿐이었고, 도착이 예정보다 늦어도 아무 일이 일어나지 않았다. 사용자가 스스로
 * "이러다 다음 약속을 놓치겠다"고 깨닫고 복구를 다시 요청해야 했다. 그런데 위기
 * 순간에 그 판단을 하는 것이 어려워서 이 앱을 쓰는 것이다.
 *
 * 새 호출도, 스키마 변경도 필요하지 않다. 필요한 값이 이미 저장돼 있다 —
 * `journey_execution_steps`의 `scheduledAt`·`estimatedArrivalAt`·
 * `durationMinutes`·`arrivedAt`. 원격 D1 마이그레이션이 토큰 권한으로 막혀 있는
 * 상황에서 이 점이 결정적이다.
 *
 * 판정 방식:
 * 계획은 각 단계의 예정 시각을 이미 기록해 두었다. 사용자가 25분 늦게 도착하면
 * 그 뒤의 모든 예정 시각이 대체로 같은 25분만큼 밀린다 — 이동시간과 체류시간은
 * 그대로이기 때문이다. 그래서 지연을 계획이 갖고 있던 **여유**와 비교한다.
 * 여유는 다음 고정 약속의 `scheduledAt - estimatedArrivalAt`, 즉 복구안을 만들 때
 * 확보해 둔 버퍼다. 지연이 그 여유를 넘으면 약속을 지킬 수 없다.
 *
 * 이 방식은 새 경로 계산을 하지 않는다. 도착을 찍는 순간에 외부 호출을 넣으면
 * 그 탭이 느려지고, 실패하면 도착 기록 자체가 위험해진다. 추정을 다시 하지 않고
 * 계획이 이미 검증해 둔 숫자를 쓴다.
 *
 * 하지 않는 것:
 * - 되돌아가기·지그재그 같은 기하학적 꼬임은 판정하지 않는다. 그것을 고치려면
 *   순서를 바꿔야 하고, 잠긴 단계와 예약을 모두 풀어야 하며, 이 제품이 약속한
 *   "한 번의 변경"과 충돌한다. 실제 피해(약속을 놓치는 것)는 아래 판정이 잡는다.
 * - 사용자를 대신해 다시 복구하지 않는다. 사실과 남은 여유를 알리고, 다시 찾을지는
 *   사용자가 고른다.
 */

export type JourneyDrift =
  | {
      status: "on_track";
      /* 음수면 예정보다 이르다. */
      delayMinutes: number;
    }
  | {
      status: "behind";
      delayMinutes: number;
      /* 계획이 갖고 있던 여유. 알 수 없으면 비어 있다. */
      slackMinutes?: number;
      nextFixedTitle?: string;
      nextFixedScheduledAt?: string;
      /* 지연이 여유를 넘었는가. `slackMinutes`를 모르면 판정하지 않는다. */
      nextFixedAtRisk: boolean;
      note: string;
      noteEn: string;
    }
  | {
      status: "unknown";
      reason: string;
    };

/* 자가 보고 도착은 몇 분씩 흔들린다. 그 흔들림으로 경고를 띄우면 경고가
   무의미해지고, 무의미한 경고는 정직한 경고까지 무시하게 만든다. */
export const DRIFT_REPORT_THRESHOLD_MINUTES = 10;

function plannedArrivalAt(step: JourneyExecutionStep): number {
  /* 역할별로 시각이 다른 컬럼에 들어간다 — `replacement`는 `scheduledAt`,
     `next_fixed`는 `estimatedArrivalAt`. 둘 다 보고 있는 값을 쓴다. */
  const candidates = [step.scheduledAt, step.estimatedArrivalAt];
  for (const value of candidates) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

export function assessJourneyDrift(
  execution: Pick<
    JourneyExecution,
    "steps" | "nextFixedStepSequence" | "status"
  >,
): JourneyDrift {
  if (execution.status !== "active" && execution.status !== "contract_met") {
    return { status: "unknown", reason: "진행 중인 여행이 아닙니다." };
  }

  /* 가장 최근에 도착을 찍은 단계를 기준으로 본다. */
  const arrived = execution.steps
    .filter((step) => step.status === "arrived" && step.arrivedAt)
    .sort((a, b) => b.sequence - a.sequence);
  const latest = arrived[0];
  if (!latest) {
    return {
      status: "unknown",
      reason: "아직 도착을 확인한 단계가 없어 지연을 판정하지 않았습니다.",
    };
  }

  const actual = Date.parse(latest.arrivedAt as string);
  const planned = plannedArrivalAt(latest);
  if (!Number.isFinite(actual) || !Number.isFinite(planned)) {
    return {
      status: "unknown",
      reason: "예정 도착 시각이 없어 지연을 판정하지 않았습니다.",
    };
  }

  const delayMinutes = Math.round((actual - planned) / 60_000);
  if (delayMinutes < DRIFT_REPORT_THRESHOLD_MINUTES) {
    return { status: "on_track", delayMinutes };
  }

  const nextFixed = execution.steps.find(
    (step) =>
      step.sequence === execution.nextFixedStepSequence &&
      step.sequence > latest.sequence,
  );
  /* 다음 고정 약속이 없거나 이미 지났으면 지킬 약속이 없다. 늦었다는 사실만
     알린다 — 남은 시간이 줄었다는 것 자체가 사용자에게 쓸모 있다. */
  /* 여유는 두 컬럼의 **차이**다. `plannedArrivalAt`은 둘 중 있는 값 하나를
     고르므로 여기서는 쓸 수 없다 — 그렇게 하면 여유가 항상 0이 된다. */
  const scheduledAt = nextFixed?.scheduledAt
    ? Date.parse(nextFixed.scheduledAt)
    : Number.NaN;
  const estimatedAt = nextFixed?.estimatedArrivalAt
    ? Date.parse(nextFixed.estimatedArrivalAt)
    : Number.NaN;
  const slackMinutes =
    Number.isFinite(scheduledAt) && Number.isFinite(estimatedAt)
      ? Math.round((scheduledAt - estimatedAt) / 60_000)
      : undefined;
  const nextFixedAtRisk =
    slackMinutes !== undefined && delayMinutes > slackMinutes;

  return {
    status: "behind",
    delayMinutes,
    slackMinutes,
    nextFixedTitle: nextFixed?.title,
    nextFixedScheduledAt: nextFixed?.scheduledAt,
    nextFixedAtRisk,
    note: nextFixedAtRisk
      ? `${latest.title} 도착이 예정보다 ${delayMinutes}분 늦었습니다. 다음 고정 일정(${nextFixed?.title ?? "다음 약속"})까지 확보해 둔 여유는 ${slackMinutes}분이므로 이대로면 지키기 어렵습니다.`
      : slackMinutes !== undefined
        ? `${latest.title} 도착이 예정보다 ${delayMinutes}분 늦었습니다. 다음 고정 일정까지 여유가 ${slackMinutes}분 있어 아직 지킬 수 있습니다.`
        : `${latest.title} 도착이 예정보다 ${delayMinutes}분 늦었습니다. 지켜야 할 다음 고정 일정은 확인되지 않았습니다.`,
    noteEn: nextFixedAtRisk
      ? `You arrived at ${latest.title} ${delayMinutes} minutes later than planned. The plan held ${slackMinutes} minutes of slack before ${nextFixed?.title ?? "your next fixed stop"}, so it no longer fits.`
      : slackMinutes !== undefined
        ? `You arrived at ${latest.title} ${delayMinutes} minutes later than planned. ${slackMinutes} minutes of slack remain before your next fixed stop.`
        : `You arrived at ${latest.title} ${delayMinutes} minutes later than planned. No next fixed stop was found to check against.`,
  };
}
