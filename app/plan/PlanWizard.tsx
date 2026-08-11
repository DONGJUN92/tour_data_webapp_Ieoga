"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { HALF_HOUR_TIMES, todayInKorea } from "../product-app-model";
import { ManualLocationPicker, type ManualPlace } from "../ManualLocationPicker";
import styles from "./plan.module.css";

type Step = "date" | "start" | "appointment" | "confirm";
type Language = "ko" | "en";
type PlanEntry = { place: ManualPlace; time: string; locked: boolean };

const STEPS: Step[] = ["date", "start", "appointment", "confirm"];
const START_TIME = "09:00";
const MIN_LEAD_MINUTES = 15;

function appointmentAt(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

function formatPlanDate(date: string, language: Language): string {
  const parsed = new Date(`${date}T12:00:00+09:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(parsed);
}

function firstPlanError(
  date: string,
  plan: PlanEntry[],
  language: Language,
  now = Date.now(),
): string {
  const t = (ko: string, en: string) => (language === "en" ? en : ko);
  if (!date || date < todayInKorea()) {
    return t(
      "오늘보다 이전 날짜에는 새 여행을 등록할 수 없습니다.",
      "A new trip cannot be scheduled in the past.",
    );
  }
  let previous = START_TIME;
  for (const entry of plan) {
    if (entry.time <= previous) {
      return t(
        `일정 시각은 앞 일정(${previous})보다 늦어야 합니다.`,
        `Each stop must be later than the previous stop (${previous}).`,
      );
    }
    if (
      date === todayInKorea() &&
      appointmentAt(date, entry.time) < now + MIN_LEAD_MINUTES * 60_000
    ) {
      return t(
        "오늘 일정은 현재 시각보다 최소 15분 뒤로 잡아 주세요.",
        "For today, schedule each new stop at least 15 minutes from now.",
      );
    }
    previous = entry.time;
  }
  if (!plan.some((entry) => entry.locked)) {
    return t(
      "이어가가 반드시 지킬 예약 또는 고정 일정을 하나 이상 잠가 주세요.",
      "Lock at least one booking or fixed appointment for IEOGA to protect.",
    );
  }
  return "";
}

export function PlanWizard() {
  const [language, setLanguage] = useState<Language>("ko");
  const [step, setStep] = useState<Step>("date");
  const [date, setDate] = useState(todayInKorea());
  const [start, setStart] = useState<ManualPlace | null>(null);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [pending, setPending] = useState<ManualPlace | null>(null);
  const [pendingTime, setPendingTime] = useState("14:00");
  const [pendingLocked, setPendingLocked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState("");
  const index = STEPS.indexOf(step);
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const times = useMemo(() => HALF_HOUR_TIMES, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title =
      language === "en" ? "Register a trip · IEOGA" : "여행 일정 등록 · 이어가";
    return () => {
      document.documentElement.lang = "ko";
    };
  }, [language]);

  function clearError() {
    if (error) setError("");
  }

  function dateIsValid(): boolean {
    if (date && date >= todayInKorea()) return true;
    setError(
      tr(
        "오늘 또는 이후의 여행 날짜를 선택해 주세요.",
        "Choose today or a future travel date.",
      ),
    );
    return false;
  }

  function validatePending(): string {
    if (!pending) {
      return tr("먼저 장소를 선택해 주세요.", "Select a place first.");
    }
    const previousTime = plan.at(-1)?.time ?? START_TIME;
    if (pendingTime <= previousTime) {
      return tr(
        `이 장소는 앞 일정(${previousTime})보다 늦은 시각으로 잡아 주세요.`,
        `Schedule this stop later than the previous stop (${previousTime}).`,
      );
    }
    if (
      date === todayInKorea() &&
      appointmentAt(date, pendingTime) <
        Date.now() + MIN_LEAD_MINUTES * 60_000
    ) {
      return tr(
        "오늘 일정은 현재 시각보다 최소 15분 뒤로 잡아 주세요.",
        "For today, choose a time at least 15 minutes from now.",
      );
    }
    return "";
  }

  function addPending() {
    clearError();
    const validation = validatePending();
    if (validation || !pending) {
      setError(validation);
      return;
    }
    setPlan((previous) => [
      ...previous,
      { place: pending, time: pendingTime, locked: pendingLocked },
    ]);
    setPending(null);
    setPendingLocked(true);
    setPendingTime((current) => {
      const currentIndex = times.findIndex((time) => time.value === current);
      return times[Math.min(currentIndex + 2, times.length - 1)]?.value ?? current;
    });
  }

  function review() {
    clearError();
    const validation = firstPlanError(date, plan, language);
    if (validation) {
      setError(validation);
      return;
    }
    setStep("confirm");
  }

  function back() {
    clearError();
    if (step === "appointment") {
      if (pending) {
        setPending(null);
        setPendingLocked(true);
        return;
      }
      if (plan.length) {
        setPlan((previous) => previous.slice(0, -1));
        return;
      }
    }
    if (index <= 0) return;
    const target = STEPS[index - 1];
    setPending(null);
    setPendingLocked(true);
    setStep(target);
  }

  async function save() {
    if (!start) return;
    const validation = firstPlanError(date, plan, language);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const nodes = [
        {
          id: "start",
          sequence: 0,
          type: "visit" as const,
          title: start.title,
          startAt: `${date}T${START_TIME}:00+09:00`,
          locked: false,
          reservation: false,
          location: {
            latitude: start.latitude,
            longitude: start.longitude,
            label: start.title,
          },
        },
        ...plan.map((entry, entryIndex) => ({
          id: `stop-${entryIndex + 1}`,
          sequence: entryIndex + 1,
          type: entry.locked ? ("reservation" as const) : ("visit" as const),
          title: entry.place.title,
          startAt: `${date}T${entry.time}:00+09:00`,
          locked: entry.locked,
          reservation: entry.locked,
          location: {
            latitude: entry.place.latitude,
            longitude: entry.place.longitude,
            label: entry.place.title,
          },
        })),
      ];
      const response = await fetch("/api/v1/itineraries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itinerary: {
            title: language === "en" ? "My trip" : "오늘의 여행",
            timezone: "Asia/Seoul",
            audience: "general",
            nodes,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        itinerary?: { id?: string };
        requestId?: string;
        error?: { requestId?: string };
      } | null;
      if (!response.ok) {
        const requestId =
          response.headers.get("x-request-id") ||
          payload?.requestId ||
          payload?.error?.requestId;
        throw new Error(
          `${tr("일정을 저장하지 못했습니다.", "Could not save the itinerary.")}${
            requestId ? ` · ${tr("요청 ID", "Request ID")} ${requestId}` : ""
          }`,
        );
      }
      setSavedId(payload?.itinerary?.id ?? "saved");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : tr("일정을 저장하지 못했습니다.", "Could not save the itinerary."),
      );
    } finally {
      setSaving(false);
    }
  }

  const languageToggle = (
    <div className={styles.language} role="group" aria-label={tr("언어 선택", "Language")}>
      <button
        type="button"
        className={language === "ko" ? styles.languageOn : ""}
        aria-pressed={language === "ko"}
        onClick={() => setLanguage("ko")}
      >
        KO
      </button>
      <button
        type="button"
        className={language === "en" ? styles.languageOn : ""}
        aria-pressed={language === "en"}
        onClick={() => setLanguage("en")}
      >
        EN
      </button>
    </div>
  );

  if (savedId) {
    return (
      <div className={styles.done}>
        {languageToggle}
        <div className={styles.doneMark} aria-hidden="true">✓</div>
        <h1>{tr("일정을 등록했어요", "Your trip is registered")}</h1>
        <p className={styles.summaryDate}>{formatPlanDate(date, language)}</p>
        <ol className={styles.route}>
          <li>
            <span>1</span>
            <div><strong>{start?.title}</strong><em>{START_TIME}</em></div>
          </li>
          {plan.map((entry, entryIndex) => (
            <li key={`${entry.place.title}-${entryIndex}`}>
              <span>{entryIndex + 2}</span>
              <div>
                <strong>{entry.place.title}</strong>
                <em>{entry.time}{entry.locked ? tr(" · 잠금", " · locked") : ""}</em>
              </div>
            </li>
          ))}
        </ol>
        <Link className={styles.primary} href="/app">
          {tr("일정이 틀어지면 여기서 복구하기", "Recover this trip if plans change")}
        </Link>
        <Link className={styles.secondary} href="/">
          {tr("처음으로", "Home")}
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.wizard}>
      <header className={styles.head}>
        {index > 0 ? (
          <button type="button" className={styles.back} onClick={back}>
            ←<span className="sr-only">{tr("이전 단계", "Previous step")}</span>
          </button>
        ) : (
          <Link className={styles.back} href="/">
            ←<span className="sr-only">{tr("처음으로", "Home")}</span>
          </Link>
        )}
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={index + 1}
          aria-label={tr(
            `${STEPS.length}단계 중 ${index + 1}단계`,
            `Step ${index + 1} of ${STEPS.length}`,
          )}
        >
          {STEPS.map((entry, entryIndex) => (
            <span
              key={entry}
              className={entryIndex <= index ? styles.barDone : styles.bar}
            />
          ))}
        </div>
        {languageToggle}
      </header>

      {step === "date" && (
        <section className={styles.step}>
          <h1>{tr("언제 가세요?", "When are you travelling?")}</h1>
          <label className={styles.label} htmlFor="plan-date">
            {tr("여행 날짜", "Travel date")}
          </label>
          <input
            id="plan-date"
            type="date"
            className={styles.field}
            value={date}
            min={todayInKorea()}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setDate(event.target.value);
              clearError();
            }}
          />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              clearError();
              if (dateIsValid()) setStep("start");
            }}
          >
            {tr("다음", "Next")}
          </button>
        </section>
      )}

      {step === "start" && (
        <section className={styles.step}>
          <h1>{tr("어디서 시작하세요?", "Where does the trip start?")}</h1>
          <ManualLocationPicker
            language={language}
            purpose="saved_stop"
            heading={tr("출발지 찾기", "Find the starting point")}
            areaHint={tr(
              "시·군·구만 골라도 됩니다. 선택한 지역의 대표 지점을 사용합니다.",
              "You may choose only a city or district; its representative point will be used.",
            )}
            onPick={(place) => {
              setStart(place);
              clearError();
              setStep("appointment");
            }}
          />
        </section>
      )}

      {step === "appointment" && (
        <section className={styles.step}>
          <h1>
            {plan.length === 0
              ? tr("꼭 지킬 약속이 있나요?", "What appointment must be protected?")
              : tr(
                  `${plan.length + 2}번째로 갈 곳이 있나요?`,
                  `Add stop ${plan.length + 2}?`,
                )}
          </h1>
          <p className={styles.summaryDate}>{formatPlanDate(date, language)}</p>

          {pending && (
            <div className={styles.pendingBlock}>
              <p className={styles.picked}>{pending.title}</p>
              <label className={styles.label} htmlFor="plan-appointment-time">
                {tr("몇 시 약속인가요?", "What time is it?")}
              </label>
              <select
                id="plan-appointment-time"
                className={styles.field}
                value={pendingTime}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setPendingTime(event.target.value);
                  clearError();
                }}
              >
                {times.map((time) => (
                  <option key={time.value} value={time.value}>
                    {language === "en" ? time.value : time.label}
                  </option>
                ))}
              </select>
              <label className={styles.lockRow}>
                <input
                  type="checkbox"
                  checked={pendingLocked}
                  onChange={(event) => {
                    setPendingLocked(event.target.checked);
                    clearError();
                  }}
                />
                <span>
                  <strong>{tr("이 일정은 못 바꿔요", "Protect this appointment")}</strong>
                  <em>
                    {tr(
                      "예약·공연·교통편처럼 시간을 옮길 수 없는 일정",
                      "A booking, performance or transport departure that cannot move",
                    )}
                  </em>
                </span>
              </label>
              {error && <p className={styles.error} role="alert">{error}</p>}
              <button type="button" className={styles.primary} onClick={addPending}>
                {tr("이 곳을 일정에 담기", "Add this stop")}
              </button>
            </div>
          )}

          {plan.length > 0 && (
            <ol className={styles.route}>
              {plan.map((entry, entryIndex) => (
                <li key={`${entry.place.title}-${entryIndex}`}>
                  <span>{entryIndex + 2}</span>
                  <div>
                    <strong>{entry.place.title}</strong>
                    <em>{entry.time}{entry.locked ? tr(" · 잠금", " · locked") : ""}</em>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {!pending && (
            <ManualLocationPicker
              language={language}
              purpose="saved_stop"
              heading={tr(
                plan.length === 0 ? "약속 장소 찾기" : "갈 곳 찾기",
                plan.length === 0 ? "Find the appointment place" : "Find another stop",
              )}
              areaHint={tr(
                "시·군·구만 골라도 됩니다. 선택한 지역의 대표 지점을 사용합니다.",
                "You may choose only a city or district; its representative point will be used.",
              )}
              onPick={(place) => {
                setPending(place);
                clearError();
              }}
            />
          )}

          {error && !pending && <p className={styles.error} role="alert">{error}</p>}
          {plan.length > 0 && !pending && (
            <div className={styles.stepActions}>
              <button type="button" className={styles.primary} onClick={review}>
                {tr("일정 검토하기", "Review the itinerary")}
              </button>
            </div>
          )}
        </section>
      )}

      {step === "confirm" && (
        <section className={styles.step}>
          <h1>{tr("이렇게 등록할까요?", "Register this itinerary?")}</h1>
          <p className={styles.summaryDate}>{formatPlanDate(date, language)}</p>
          <ol className={styles.route}>
            <li>
              <span>1</span>
              <div><strong>{start?.title}</strong><em>{START_TIME}</em></div>
            </li>
            {plan.map((entry, entryIndex) => (
              <li key={`${entry.place.title}-${entryIndex}`}>
                <span>{entryIndex + 2}</span>
                <div>
                  <strong>{entry.place.title}</strong>
                  <em>{entry.time}{entry.locked ? tr(" · 잠금", " · locked") : ""}</em>
                </div>
              </li>
            ))}
          </ol>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button
            type="button"
            className={styles.primary}
            onClick={() => void save()}
            disabled={saving || !start || !plan.length}
          >
            {saving
              ? tr("등록하는 중…", "Saving…")
              : tr("이 일정으로 등록", "Register this itinerary")}
          </button>
        </section>
      )}
    </div>
  );
}
