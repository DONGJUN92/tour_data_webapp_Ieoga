"use client";

import { useEffect, useState } from "react";
import type { Language } from "./product-app-model";
import {
  formatReferenceTime,
  koreaDateTimeLocalValue,
  referenceTimeCaveat,
  resolveReferenceTime,
  scheduledReferenceFromOffset,
  type ReferenceTimeMode,
} from "./reference-time";
import styles from "./ReferenceTimePicker.module.css";

type Props = {
  idPrefix: string;
  language: Language;
  mode: ReferenceTimeMode;
  localValue: string;
  onModeChange: (mode: ReferenceTimeMode) => void;
  onLocalValueChange: (value: string) => void;
};

const QUICK_OFFSETS = [30, 60, 90, 120] as const;

function quickLabel(language: Language, minutes: number): string {
  if (minutes < 60) return language === "en" ? `In ${minutes} min` : `${minutes}분 뒤`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!remainder) return language === "en" ? `In ${hours}h` : `${hours}시간 뒤`;
  return language === "en"
    ? `In ${hours}h ${remainder}m`
    : `${hours}시간 ${remainder}분 뒤`;
}

export function ReferenceTimePicker({
  idPrefix,
  language,
  mode,
  localValue,
  onModeChange,
  onLocalValueChange,
}: Props) {
  /* 서버와 첫 클라이언트 렌더가 같은 값으로 시작해야 분 경계에서도 hydration이
     안정적이다. 실제 검증 시계는 첫 사용자 동작에서 채운다. */
  const [nowMs, setNowMs] = useState(0);
  /* 아무것도 누르지 않았는데 "현재 시각"이 이미 초록색으로 칠해져 있으면, 그
     화면은 사용자가 하지 않은 선택을 했다고 말하는 것이다. 실제로 그렇게 읽혀서
     "왜 누르지도 않았는데 골라져 있나"는 혼동이 나왔다. 동작은 그대로 두고 —
     고르지 않으면 여전히 현재 시각으로 조회한다 — 표시만 실제로 누른 뒤에
     칠한다. */
  const [modeChosen, setModeChosen] = useState(false);
  const resolution = resolveReferenceTime(mode, localValue, language, nowMs);
  const caveat = resolution.ok
    ? referenceTimeCaveat(resolution.timestamp, language, nowMs)
    : "";
  const helpId = `${idPrefix}-reference-help`;
  const errorId = `${idPrefix}-reference-error`;
  const inputId = `${idPrefix}-reference-datetime`;

  useEffect(() => {
    const refresh = () => setNowMs(Date.now());
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  return (
    <fieldset className={styles.fieldset}>
      <legend>
        {language === "en" ? "Search reference time" : "조회 기준 시간"}
      </legend>
      <p className={styles.intro} id={helpId}>
        {language === "en"
          ? "Opening hours, weather and travel time are checked as if you were at the selected place at this time."
          : "선택한 시각에 해당 위치에 있다고 가정하고 운영시간·날씨·이동 시간을 확인합니다."}
      </p>
      <div
        className={styles.modeChoices}
        role="radiogroup"
        aria-label={language === "en" ? "Reference-time mode" : "조회 기준 방식"}
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === "now"}
          className={modeChosen && mode === "now" ? styles.active : styles.choice}
          onClick={() => {
            setNowMs(Date.now());
            setModeChosen(true);
            onModeChange("now");
          }}
        >
          <strong>{language === "en" ? "Current time" : "현재 시각"}</strong>
          <small>
            {language === "en" ? "Use the time when I search" : "조회 버튼을 누르는 시각 사용"}
          </small>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "scheduled"}
          className={
            modeChosen && mode === "scheduled" ? styles.active : styles.choice
          }
          onClick={() => {
            const actionNowMs = Date.now();
            setNowMs(actionNowMs);
            setModeChosen(true);
            if (
              !resolveReferenceTime(
                "scheduled",
                localValue,
                language,
                actionNowMs,
              ).ok
            ) {
              onLocalValueChange(scheduledReferenceFromOffset(30, actionNowMs));
            }
            onModeChange("scheduled");
          }}
        >
          <strong>{language === "en" ? "Choose a time" : "날짜·시각 선택"}</strong>
          <small>{language === "en" ? "Assume I am there later" : "그 시각에 있을 것으로 가정"}</small>
        </button>
      </div>

      {mode === "scheduled" && (
        <div className={styles.scheduledPanel}>
          <label htmlFor={inputId}>
            <span>{language === "en" ? "Date and time (KST)" : "날짜와 시각 (한국시간)"}</span>
            <input
              id={inputId}
              type="datetime-local"
              value={localValue}
              min={koreaDateTimeLocalValue(nowMs - 60_000)}
              /* 상한을 두지 않는다. 운영시간·휴무일은 시각과 무관하게 유효하고
                 자동차 경로예측도 먼 미래를 답한다. 확인할 수 없는 것은 아래
                 안내로 밝힌다. */
              step={60}
              aria-invalid={!resolution.ok}
              aria-describedby={`${helpId}${!resolution.ok ? ` ${errorId}` : ""}`}
              onChange={(event) => {
                setNowMs(Date.now());
                onLocalValueChange(event.target.value);
              }}
              required
            />
          </label>
          <div
            className={styles.quickChoices}
            aria-label={language === "en" ? "Quick future-time choices" : "빠른 미래 시각 선택"}
          >
            {QUICK_OFFSETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => {
                  const actionNowMs = Date.now();
                  setNowMs(actionNowMs);
                  onLocalValueChange(
                    scheduledReferenceFromOffset(minutes, actionNowMs),
                  );
                }}
              >
                {quickLabel(language, minutes)}
              </button>
            ))}
          </div>
          {resolution.ok ? (
            <p className={styles.summary} role="status">
              {language === "en"
                ? `Search as of ${formatReferenceTime(resolution.iso, language)} KST.`
                : `${formatReferenceTime(resolution.iso, language)} 기준으로 조회합니다.`}
            </p>
          ) : (
            <p className={styles.error} id={errorId} role="alert">
              {resolution.message}
            </p>
          )}
          {caveat && (
            <p className={styles.caveat} role="status">
              {caveat}
            </p>
          )}
          <button
            className={styles.reset}
            type="button"
            onClick={() => {
              setModeChosen(true);
              onModeChange("now");
            }}
          >
            {language === "en" ? "Return to current time" : "현재 시각으로 되돌리기"}
          </button>
        </div>
      )}
    </fieldset>
  );
}
