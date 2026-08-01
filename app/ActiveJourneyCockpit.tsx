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
};

function formatTime(value?: string): string {
  if (!value) return "시간 확인";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function stepRole(step: JourneyExecutionStep): string {
  if (step.role === "replacement") return "바뀐 일정";
  if (step.role === "next_fixed") return "다음 예약";
  if (step.role === "preserved") return "보존 일정";
  return "원래 일정";
}

function navigationUrl(step: JourneyExecutionStep): string {
  return `https://map.kakao.com/link/to/${encodeURIComponent(step.title)},${step.latitude},${step.longitude}`;
}

export function ActiveJourneyCockpit({
  execution,
  onChange,
  onCloseCompleted,
}: Props) {
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
          payload?.error?.message ?? "여행 진행 상태를 저장하지 못했습니다.",
        );
      }
      onChange(payload.execution);
      setState("idle");
      setMessage(
        payload.execution.status === "contract_met"
          ? "다음 예약 도착을 확인했습니다. 남은 원래 일정을 계속 이어갑니다."
          : payload.execution.status === "completed"
            ? "복구된 여행을 끝까지 완주했습니다."
            : "다음 일정으로 이어갑니다.",
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
        <p>여행 완주</p>
        <h1>복구된 일정으로 여행을 끝까지 이어갔어요.</h1>
        <p>
          다음 예약 도착과 남은 원래 일정의 완료가 모두 기록되었습니다.
        </p>
        <button type="button" onClick={onCloseCompleted}>
          새 여행 준비하기
        </button>
      </section>
    );
  }

  if (execution.status === "abandoned") {
    return (
      <section className="journey-complete-card is-abandoned">
        <p>복구 여행 종료</p>
        <h1>이번 여행 진행을 종료했습니다.</h1>
        <button type="button" onClick={onCloseCompleted}>
          여행 화면으로 돌아가기
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
      <div className="cockpit-progress" aria-label={`여행 진행률 ${progress}%`}>
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="cockpit-topline">
        <span>복구 여행 진행 중</span>
        <b>
          {completedCount}/{execution.steps.length} 완료
        </b>
      </div>

      <div className="cockpit-main">
        <div className="cockpit-copy">
          <p>{stepRole(current)}</p>
          <h1 id="active-journey-title">{current.title}</h1>
          <span>{current.locationLabel || "목적지 위치 확인"}</span>
          <div className="cockpit-facts">
            <dl>
              <dt>예상·예약 시각</dt>
              <dd>
                {formatTime(
                  current.estimatedArrivalAt ?? current.scheduledAt,
                )}
              </dd>
            </dl>
            <dl>
              <dt>지켜야 할 다음 예약</dt>
              <dd>
                {nextFixed.title} ·{" "}
                {formatTime(
                  nextFixed.estimatedArrivalAt ?? nextFixed.scheduledAt,
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
            다음 장소 길찾기
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
            {state === "loading" ? "도착 기록 중…" : "이 장소에 도착했어요"}
          </button>
        </div>
      </div>

      {execution.status === "contract_met" && (
        <div className="cockpit-contract-met" role="status">
          <strong>다음 예약을 지켰어요.</strong>
          <span>이제 남아 있는 원래 일정도 같은 순서로 이어갑니다.</span>
        </div>
      )}
      {promptReached &&
        execution.status === "active" &&
        current.sequence < execution.nextFixedStepSequence && (
          <div className="cockpit-time-alert" role="status">
            다음 예약 도착 확인 시각이 가까워졌습니다. 현재 단계 도착 후 바로
            다음 목적지로 이동해 주세요.
          </div>
        )}

      <details className="cockpit-itinerary">
        <summary>전체 복구 일정 보기</summary>
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
                <b>{stepRole(step)}</b>
                <strong>{step.title}</strong>
                <small>
                  {formatTime(step.estimatedArrivalAt ?? step.scheduledAt)}
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
