"use client";

import {
  useEffect,
  useId,
  useRef,
} from "react";
import styles from "./SimulationGuide.module.css";

export type SimulationGuideProps = {
  isOpen: boolean;
  isLoading?: boolean;
  loadError?: string | null;
  onClose: () => void;
  onDismiss?: () => void;
  onLoadPracticeItinerary: () => void;
};

const GUIDE_STEPS = [
  {
    title: "원래 여행을 먼저 저장해요",
    description:
      "꼭 지켜야 할 예약과 바꿔도 되는 장소를 알려주면, 이어가가 원래 여행의 기준을 기억해요.",
  },
  {
    title: "지금 있는 곳을 편하게 찾아요",
    description:
      "위치를 허용하면 자동으로 입력하고, 허용하지 않으면 장소 이름만 검색해요. 위·경도는 입력하지 않아도 돼요.",
  },
  {
    title: "여행이 끊긴 이유를 한 번만 눌러요",
    description:
      "비, 이동 지연, 혼잡, 걷기 어려움 중 지금 상황과 가장 가까운 항목을 선택해요.",
  },
  {
    title: "복구한 여행을 끝까지 이어가요",
    description:
      "복구안 적용, 길찾기, 도착 확인을 차례로 진행하면 다음 예약과 남은 원래 일정까지 완주할 수 있어요.",
  },
] as const;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function SimulationGuide({
  isOpen,
  isLoading = false,
  loadError,
  onClose,
  onDismiss,
  onLoadPracticeItinerary,
}: SimulationGuideProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    const focusTimer = window.setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 0);

    document.body.style.overflow = "hidden";

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-hidden") !== "true",
      );

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (
        event.shiftKey &&
        (activeElement === first || !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last || !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleDocumentKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className={styles.backdrop}
      data-testid="simulation-guide"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={isLoading}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div>
            <p className={styles.kicker}>처음이라면 1분이면 충분해요</p>
            <h2 id={titleId}>여행이 끊겼을 때, 이렇게 이어가요</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="사용 가이드 닫기"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <p id={descriptionId} className={styles.introduction}>
          이어가는 전체 일정을 다시 짜지 않아요. 지금 바꿔야 할 한 곳만
          복구하고, 다음 예약부터 원래 여행으로 돌아가게 도와줘요.
        </p>

        <ol className={styles.steps} aria-label="이어가 사용 순서">
          {GUIDE_STEPS.map((step, index) => (
            <li
              key={step.title}
              className={styles.step}
              data-guide-step={index + 1}
            >
              <span className={styles.stepNumber} aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className={styles.actionArea}>
          {loadError ? (
            <p className={styles.errorMessage} role="alert">
              {loadError}
            </p>
          ) : null}

          <button
            type="button"
            className={styles.primaryButton}
            onClick={onLoadPracticeItinerary}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <span className={styles.spinner} aria-hidden="true" />
                실제 장소를 찾는 중…
              </>
            ) : (
              "실제 장소로 연습 일정 불러오기"
            )}
          </button>
          <p className={styles.actionNote} aria-live="polite">
            {isLoading
              ? "연결된 장소 검색에서 연습할 여행지를 확인하고 있어요."
              : "연결된 장소 검색 결과를 불러오며, 장소와 시간은 언제든 바꿀 수 있어요."}
          </p>
          <button
            type="button"
            className={styles.dismissButton}
            onClick={onDismiss ?? onClose}
          >
            다음에 볼게요
          </button>
        </div>
      </div>
    </div>
  );
}
