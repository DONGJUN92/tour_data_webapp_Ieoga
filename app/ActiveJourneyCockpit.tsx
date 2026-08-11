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
  /* 복구안을 골라 실행에 들어온 뒤 되돌아갈 길이 없었다. 마음이 바뀌면 앱을
     처음부터 다시 시작하는 수밖에 없었다는 뜻이다. */
  onBack?: () => void;
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
  onBack,
}: Props) {
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [messagePriority, setMessagePriority] = useState<"polite" | "assertive">(
    "polite",
  );
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
  /* `completedAt`는 전체 동선 완료, contract_*는 약속 준수 결과다. 둘을
     합치면 늦게 도착하고 남은 여행을 마친 사람에게 성공 배지를 주게 된다. */
  const contractMissed =
    execution.status === "contract_missed" || Boolean(execution.contractMissedAt);
  const contractMet =
    !contractMissed &&
    (execution.status === "contract_met" || Boolean(execution.contractMetAt));
  const journeyFinished =
    execution.status !== "abandoned" &&
    (execution.status === "completed" || Boolean(execution.completedAt));
  const contractArrivalAt =
    nextFixed?.arrivedAt ?? execution.contractMissedAt ?? execution.contractMetAt;
  /* 실행 상태 머신은 다음 고정 일정 이후의 원래 일정도 `current`로 넘기고
     도착 확인을 받는다. 따라서 진행률 역시 실제 실행 전체를 분모로 삼는다.
     약속 도착만으로 100%를 표시하면 남은 일정과 completedAt의 의미가 깨진다. */
  const trackedSteps = execution.steps;
  const completedCount = trackedSteps.filter(
    (step) => step.status === "arrived",
  ).length;
  const trackedTotal = trackedSteps.length;
  const progress = trackedTotal
    ? Math.round((completedCount / trackedTotal) * 100)
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
    setMessagePriority("polite");
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
      if (
        payload.execution.id !== execution.id ||
        payload.execution.sourceRunId !== execution.sourceRunId ||
        payload.execution.sourceOptionId !== execution.sourceOptionId
      ) {
        throw new Error(
          tr(
            "서버의 활성 일정이 바뀌어 도착 기록을 반영하지 않았습니다. 현재 일정으로 돌아가 다시 확인해 주세요.",
            "The server's active itinerary changed, so this arrival was not accepted. Return to the current itinerary and check again.",
          ),
        );
      }
      onChange(payload.execution);
      setState("idle");
      setMessagePriority(
        payload.execution.status === "contract_missed" ||
          Boolean(payload.execution.contractMissedAt)
          ? "assertive"
          : "polite",
      );
      setMessage(
        payload.execution.status === "contract_missed" ||
          Boolean(payload.execution.contractMissedAt)
          ? tr(
              "도착은 기록했지만 약속 시각을 지키지 못했습니다. 남은 일정을 다시 복구하거나 관광통역안내 1330에 도움을 요청할 수 있습니다.",
              "Arrival was recorded, but the promised time was missed. Recover the remaining trip or call the 1330 Travel Helpline for help.",
            )
          : payload.execution.status === "contract_met" ||
              Boolean(payload.execution.contractMetAt)
          ? tr("다음 예약 도착을 확인했습니다. 남은 원래 일정을 계속 이어갑니다.", "Arrival at your next booking is confirmed. Your remaining stops continue.")
          : payload.execution.status === "completed" ||
              Boolean(payload.execution.completedAt)
            ? tr(
                "남은 여행 단계가 완료되었습니다. 약속 준수 결과는 별도 확인이 필요합니다.",
                "The remaining trip steps are complete. The appointment outcome still needs confirmation.",
              )
            : tr("다음 일정으로 이어갑니다.", "Continuing to your next stop."),
      );
    } catch (error) {
      setState("error");
      setMessagePriority("assertive");
      setMessage(
        error instanceof Error
          ? error.message
          : tr(
              "여행 진행 상태를 저장하지 못했습니다.",
              "Could not save your trip progress.",
            ),
      );
    }
  }

  if (execution.status === "abandoned") {
    return (
      <section
        className="journey-complete-card is-abandoned"
        data-testid="journey-abandoned"
        role={contractMissed ? "alert" : "status"}
        aria-live={contractMissed ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <p>{tr("복구 여행 종료", "Trip ended")}</p>
        <h1>
          {tr(
            "남은 여행 진행을 종료했습니다.",
            "You ended the remaining trip.",
          )}
        </h1>
        <p>
          {contractMissed
            ? tr(
                "약속 시각을 놓친 기록은 그대로 유지되며, 이후 남은 일정을 중단했습니다.",
                "The missed-appointment record remains, and the later stops were ended.",
              )
            : contractMet
              ? tr(
                  "다음 약속을 지킨 기록은 그대로 유지되며, 이후 남은 일정을 중단했습니다.",
                  "The met-appointment record remains, and the later stops were ended.",
                )
              : tr(
                  "약속 준수 성공으로 표시하지 않으며, 여행 중단 사실을 별도로 기록했습니다.",
                  "This is not shown as an appointment success; the trip termination is recorded separately.",
                )}
        </p>
        {contractMissed && onRecoverAgain && (
          <button type="button" onClick={onRecoverAgain}>
            {tr("남은 일정 다시 복구하기", "Recover the remaining trip")}
          </button>
        )}
        <button type="button" onClick={onCloseCompleted}>
          {tr("여행 화면으로 돌아가기", "Back to the trip screen")}
        </button>
      </section>
    );
  }

  if (journeyFinished) {
    return (
      <section
        className={`journey-complete-card ${contractMissed ? "is-contract-missed" : ""}`}
        data-testid={
          contractMissed
            ? "journey-completed-contract-missed"
            : "journey-completed"
        }
        role={contractMissed ? "alert" : "status"}
        aria-live={contractMissed ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span aria-hidden="true">{contractMet ? "✓" : "!"}</span>
        <p>{tr("여행 단계 완료", "Trip steps completed")}</p>
        <h1>
          {contractMissed
            ? tr(
                "여행은 마쳤지만 약속 시각은 지키지 못했습니다.",
                "The trip is complete, but the promised time was missed.",
              )
            : contractMet
              ? tr(
                  "다음 약속을 지키고 여행을 끝까지 이어갔어요.",
                  "You met the next appointment and completed the trip.",
                )
              : tr(
                  "남은 여행 단계를 완료했습니다.",
                  "You completed the remaining trip steps.",
                )}
        </h1>
        <p>
          {contractMissed
            ? tr(
                "도착 기록은 남아 있지만 정시 도착 성공으로 처리하지 않았습니다.",
                "The arrival remains recorded, but it is not counted as an on-time success.",
              )
            : contractMet
              ? tr(
                  "약속 시각 준수와 남은 일정 완료가 각각 기록되었습니다.",
                  "The on-time appointment and remaining-trip completion are recorded separately.",
                )
              : tr(
                  "약속 준수 근거가 없어 성공으로 표시하지 않습니다.",
                  "No appointment-outcome evidence is available, so this is not shown as a success.",
                )}
        </p>
        {contractMissed && (
          <div className="journey-complete-actions">
            {onRecoverAgain && (
              <button type="button" onClick={onRecoverAgain}>
                {tr("남은 일정 다시 복구하기", "Recover the remaining trip")}
              </button>
            )}
            <a href="tel:1330">
              {tr("관광통역안내 1330 연결", "Call the 1330 Travel Helpline")}
            </a>
          </div>
        )}
        <button type="button" onClick={onCloseCompleted}>
          {tr("새 여행 준비하기", "Plan a new trip")}
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
        <span>{tr("이어가는 중", "Picking your trip back up")}</span>
        {/* 셀 구간이 한 곳뿐이면(빈 시간에 한 곳 넣기) 숫자가 정보를 주지
            않는다. 1/1은 진행률이 아니라 장식이다. */}
        {trackedTotal > 1 && (
          <b>
            {contractMet || contractMissed
              ? tr("전체 복구 일정", "whole recovered trip")
              : tr("다음 예약을 향해", "toward your booking")} {completedCount}/
            {trackedTotal}
          </b>
        )}
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
              <dt>
                {contractMissed
                  ? tr("놓친 다음 예약", "Missed booking")
                  : contractMet
                    ? tr("지킨 다음 예약", "Protected booking")
                    : tr("지켜야 할 다음 예약", "Booking to protect")}
              </dt>
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

        {onBack && (
          <button
            type="button"
            className="cockpit-back"
            onClick={onBack}
          >
            {tr("← 이전으로", "← Back")}
          </button>
        )}

        <div className="cockpit-actions">
          {/* 빈 창을 먼저 열고 위치가 오면 주소를 채우던 방식을 버렸다.
              위치 권한 창이 떠 있는 동안, 또는 사용자가 무시하는 동안 그 탭이
              `about:blank`로 남았다 — 사용자가 본 것이 이 화면이다. 앱 스킴을
              팝업에 넣으면 아무 일도 일어나지 않아 더 확실히 멈춘다.

              카카오맵 웹은 어차피 출발지를 파라미터로 받지 않는다(좌표계가
              WCONGNAMUL이다). 그러니 링크를 그대로 따라가게 두고 목적지만
              확실히 채운다. 카카오가 출발지 자리를 "현재 위치"로 물어본다. */}
          <a
            className="cockpit-primary"
            href={navigationUrl(current)}
            target="_blank"
            rel="noreferrer"
          >
            {tr("현재 위치에서 길찾기", "Directions from where I am")}
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

      {contractMissed && (
        <div
          className="cockpit-contract-missed"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          data-testid="contract-missed-alert"
        >
          <strong>
            {tr(
              "도착했지만 약속 시각을 지키지 못했습니다.",
              "You arrived, but did not meet the promised time.",
            )}
          </strong>
          <span>
            {nextFixed?.scheduledAt && contractArrivalAt
              ? tr(
                  `약속 ${formatTime(nextFixed.scheduledAt, language)} · 도착 확인 ${formatTime(contractArrivalAt, language)}`,
                  `Promised ${formatTime(nextFixed.scheduledAt, language)} · arrival recorded ${formatTime(contractArrivalAt, language)}`,
                )
              : tr(
                  "도착 기록은 보존하지만 정시 도착 성공으로 집계하지 않습니다.",
                  "The arrival is retained, but it is not counted as an on-time success.",
                )}
          </span>
          <div className="cockpit-support-actions">
            {onRecoverAgain && (
              <button type="button" onClick={onRecoverAgain}>
                {tr("지금 상황에서 다시 복구", "Recover again from here")}
              </button>
            )}
            <a href="tel:1330">
              {tr("관광통역안내 1330 연결", "Call the 1330 Travel Helpline")}
            </a>
          </div>
        </div>
      )}

      {contractMet && (
        <div
          className="cockpit-contract-met"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
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
          {tr(
            "원본 일정은 그대로 보관되며, 현재 복구 버전만 실행 중입니다.",
            "Your original itinerary remains unchanged; only this recovery version is active.",
          )}
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
          {tr("복구 여행 종료", "End recovered trip")}
        </button>
      </div>
      {message && (
        <p
          className={`cockpit-message ${messagePriority === "assertive" ? "is-error" : ""}`}
          role={messagePriority === "assertive" ? "alert" : "status"}
          aria-live={messagePriority}
          aria-atomic="true"
        >
          {message}
        </p>
      )}
    </section>
  );
}
