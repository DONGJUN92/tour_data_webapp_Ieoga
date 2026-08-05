"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  JourneyExecution,
  JourneyExecutionStep,
} from "@/lib/recovery/execution";

type Props = {
  execution: JourneyExecution;
  onChange: (execution: JourneyExecution) => void;
  onCloseCompleted: () => void;
  /* 이 화면은 복구를 적용한 뒤 여행이 끝날 때까지 계속 보이는 화면인데
     영어 대응이 하나도 없어서, 영어로 쓰던 사용자가 적용 버튼을 누르는
     순간부터 화면이 통째로 한국어로 바뀌었다. */
  language?: "ko" | "en";
  /* 동선이 꼬여 다음 고정 일정을 지킬 수 없을 때 누를 수 있는 경로. 넘기지
     않으면 사실만 알리고 버튼을 만들지 않는다 — 누를 곳 없는 버튼을 보여
     주는 것보다 낫다. */
  onRecoverAgain?: () => void;
};

function formatTime(value: string | undefined, language: "ko" | "en"): string {
  if (!value) return language === "en" ? "Time to confirm" : "시간 확인";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function stepRole(
  step: JourneyExecutionStep,
  language: "ko" | "en",
): string {
  const roles = {
    replacement: { ko: "바뀐 일정", en: "Changed stop" },
    next_fixed: { ko: "다음 예약", en: "Next booking" },
    preserved: { ko: "보존 일정", en: "Kept stop" },
    remaining_original: { ko: "원래 일정", en: "Original stop" },
  } as const;
  return (roles[step.role] ?? roles.remaining_original)[language];
}

function navigationUrl(step: JourneyExecutionStep): string {
  return `https://map.kakao.com/link/to/${encodeURIComponent(step.title)},${step.latitude},${step.longitude}`;
}

export function ActiveJourneyCockpit({
  execution,
  onChange,
  onCloseCompleted,
  language = "ko",
  onRecoverAgain,
}: Props) {
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const current = useMemo(
    () =>
      execution.steps.find(
        (step) => step.sequence === execution.currentStepSequence,
      ) ?? execution.steps.find((step) => step.status === "current"),
    [execution],
  );
  const nextFixed = execution.steps.find(
    (step) => step.sequence === execution.nextFixedStepSequence,
  );
  const completedCount = execution.steps.filter(
    (step) => step.status === "arrived",
  ).length;
  const progress = execution.steps.length
    ? Math.round((completedCount / execution.steps.length) * 100)
    : 0;
  const promptReached = now >= Date.parse(execution.outcomePromptAt);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const refresh = () => setNow(Date.now());
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  async function update(
    action:
      | { action: "arrive_step"; stepId: string }
      | { action: "abandon"; reasonCode: string },
  ) {
    setState("loading");
    setMessage("");
    try {
      const response = await fetch("/api/v1/journey/active", {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(action),
      });
      const payload = (await response.json().catch(() => null)) as {
        execution?: JourneyExecution;
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.execution) {
        throw new Error(
          payload?.error?.message ?? tr("여행 진행 상태를 저장하지 못했습니다.", "Could not save your trip progress."),
        );
      }
      onChange(payload.execution);
      setState("idle");
      setMessage(
        payload.execution.status === "contract_met"
          ? tr("다음 예약 도착을 확인했습니다. 남은 원래 일정을 계속 이어갑니다.", "Arrival at your next booking is confirmed. Your remaining stops continue.")
          : payload.execution.status === "completed"
            ? tr("복구된 여행을 끝까지 완주했습니다.", "You finished the recovered trip.")
            : tr("다음 일정으로 이어갑니다.", "Continuing to your next stop."),
      );
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "여행 진행 상태를 저장하지 못했습니다.",
      );
    }
  }

  if (execution.status === "completed") {
    return (
      <section className="journey-complete-card" data-testid="journey-completed">
        <span aria-hidden="true">✓</span>
        <p>{tr("여행 완주", "Trip completed")}</p>
        <h1>{tr("복구된 일정으로 여행을 끝까지 이어갔어요.", "You kept the trip going all the way with the recovered plan.")}</h1>
        <p>
          {tr(
            "다음 예약 도착과 남은 원래 일정의 완료가 모두 기록되었습니다.",
            "Arrival at your booking and every remaining stop are recorded.",
          )}
        </p>
        <button type="button" onClick={onCloseCompleted}>
          {tr("새 여행 준비하기", "Plan a new trip")}
        </button>
      </section>
    );
  }

  if (execution.status === "abandoned") {
    return (
      <section className="journey-complete-card is-abandoned">
        <p>{tr("복구 여행 종료", "Trip ended")}</p>
        <h1>{tr("이번 여행 진행을 종료했습니다.", "This trip has been ended.")}</h1>
        <button type="button" onClick={onCloseCompleted}>
          {tr("여행 화면으로 돌아가기", "Back to the trip screen")}
        </button>
      </section>
    );
  }

  if (!current || !nextFixed) return null;

  return (
    <section
      className="active-journey-cockpit"
      aria-labelledby="active-journey-title"
      data-testid="active-journey-cockpit"
      tabIndex={-1}
    >
      <div className="cockpit-progress" aria-label={tr(`여행 진행률 ${progress}%`, `Trip progress ${progress}%`)}>
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="cockpit-topline">
        <span>{tr("복구 여행 진행 중", "Recovered trip in progress")}</span>
        <b>
          {completedCount}/{execution.steps.length} {tr("완료", "done")}
        </b>
      </div>

      <div className="cockpit-main">
        <div className="cockpit-copy">
          <p>{stepRole(current, language)}</p>
          <h1 id="active-journey-title">{current.title}</h1>
          <span>{current.locationLabel || tr("목적지 위치 확인", "Destination to confirm")}</span>
          <div className="cockpit-facts">
            <dl>
              <dt>{tr("예상·예약 시각", "Expected time")}</dt>
              <dd>
                {formatTime(
                  current.estimatedArrivalAt ?? current.scheduledAt,
                  language,
                )}
              </dd>
            </dl>
            <dl>
              <dt>{tr("지켜야 할 다음 예약", "Booking to protect")}</dt>
              <dd>
                {nextFixed.title} ·{" "}
                {formatTime(
                  nextFixed.estimatedArrivalAt ?? nextFixed.scheduledAt,
                  language,
                )}
              </dd>
            </dl>
          </div>
        </div>

        <div className="cockpit-actions">
          <a
            className="cockpit-primary"
            href={navigationUrl(current)}
            target="_blank"
            rel="noreferrer"
          >
            {tr("다음 장소 길찾기", "Directions to the next stop")}
            <span aria-hidden="true">→</span>
          </a>
          <button
            type="button"
            className="cockpit-arrived"
            onClick={() =>
              void update({ action: "arrive_step", stepId: current.id })
            }
            disabled={state === "loading"}
          >
            {state === "loading"
              ? tr("도착 기록 중…", "Recording arrival…")
              : tr("이 장소에 도착했어요", "I arrived here")}
          </button>
        </div>
      </div>

      {/* 동선이 꼬였을 때. 예전에는 도착이 늦어도 아무 일이 일어나지 않아서,
          사용자가 스스로 "이러다 다음 약속을 놓치겠다"고 깨닫고 복구를 다시
          요청해야 했다. 위기 순간에 그 판단을 하기 어려워서 이 앱을 쓴다.
          우리가 대신 다시 복구하지는 않는다 — 사실과 남은 여유를 알리고
          고르는 것은 사용자다. */}
      {execution.drift?.status === "behind" && (
        <div
          className={
            execution.drift.nextFixedAtRisk
              ? "cockpit-drift is-at-risk"
              : "cockpit-drift"
          }
          role="status"
        >
          <strong>
            {execution.drift.nextFixedAtRisk
              ? tr(
                  "이대로면 다음 고정 일정을 지키기 어렵습니다.",
                  "Your next fixed stop no longer fits.",
                )
              : tr("예정보다 늦어졌습니다.", "You are running late.")}
          </strong>
          <span>
            {language === "en"
              ? execution.drift.noteEn
              : execution.drift.note}
          </span>
          {execution.drift.nextFixedAtRisk && onRecoverAgain && (
            <button type="button" onClick={onRecoverAgain}>
              {tr("지금 상황으로 다시 찾기", "Search again from here")}
            </button>
          )}
        </div>
      )}

      {execution.status === "contract_met" && (
        <div className="cockpit-contract-met" role="status">
          <strong>{tr("다음 예약을 지켰어요.", "Your booking is safe.")}</strong>
          <span>{tr("이제 남아 있는 원래 일정도 같은 순서로 이어갑니다.", "Your remaining stops continue in the same order.")}</span>
        </div>
      )}
      {promptReached &&
        execution.status === "active" &&
        current.sequence < execution.nextFixedStepSequence && (
          <div className="cockpit-time-alert" role="status">
            {tr(
              "다음 예약 도착 시각이 가까워졌습니다. 지금 단계에 도착하면 바로 다음 장소로 이동해 주세요.",
              "Your booking time is close. Once you arrive here, head to the next stop right away.",
            )}
          </div>
        )}

      <details className="cockpit-itinerary">
        <summary>{tr("전체 복구 일정 보기", "See the whole recovered plan")}</summary>
        <ol>
          {execution.steps.map((step) => (
            <li
              key={step.id}
              className={
                step.status === "current"
                  ? "is-current"
                  : step.status === "arrived"
                    ? "is-arrived"
                    : ""
              }
            >
              <span aria-hidden="true">
                {step.status === "arrived"
                  ? "✓"
                  : step.sequence === execution.currentStepSequence
                    ? "→"
                    : step.sequence + 1}
              </span>
              <div>
                <b>{stepRole(step, language)}</b>
                <strong>{step.title}</strong>
                <small>
                  {formatTime(step.estimatedArrivalAt ?? step.scheduledAt, language)}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </details>

      <div className="cockpit-footer">
        <span>
          원본 일정은 그대로 보관되며, 현재 복구 버전만 실행 중입니다.
        </span>
        <button
          type="button"
          onClick={() =>
            void update({
              action: "abandon",
              reasonCode: "USER_STOPPED_EXECUTION",
            })
          }
          disabled={state === "loading"}
        >
          복구 여행 종료
        </button>
      </div>
      {message && (
        <p
          className={`cockpit-message ${state === "error" ? "is-error" : ""}`}
          role={state === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      )}
    </section>
  );
}
